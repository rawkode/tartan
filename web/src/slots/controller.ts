// One dynamic slot instance on a page.
//
// - load: `GET /-/api/slot/<inst>/<slotId>?ctx=<b64url hints>`, `slotId`
//   being the contribution id (`SlotInstanceDto.id`); the kernel re-derives
//   and confines ctx, validates the document and returns it or the
//   error chip.
// - refresh: on live events matching the instance's and the document's
//   `refreshOn`, on `refreshMs`, on a sibling's action `refresh`, and on a
//   live `gap`; throttled to ≤ 1 per second per slot. The subscription
//   carries the render's `cursor` as `since`, so an event between the render
//   and the socket's `hello` still refreshes the slot.
// - actions: `POST …/action {action, payload, ctx}`; the result may replace
//   the document (`render`), show a `toast`, `navigate` (same-origin paths
//   only, re-checked) and `refresh` other slots by id (`actions.ts`).
// - ctx: read at each call (`deps.ctx()`); when the page's hint changes (in-view
//   navigation to another change, lane, file or work item), the host calls
//   `reload()`: the old document goes, in-flight renders and an in-flight
//   action's `render` for the old ctx are dropped, and the slot renders again.
// No DOM access: the host component wires navigation, toasts and confirm.

import { reactive } from "vue";
import type {
	ActionResponse,
	SlotInstanceDto,
	SlotRenderResponse,
} from "@tartan/contract/api.ts";
import type { Api } from "../api/client.ts";
import { errorMessage } from "../api/http.ts";
import type { LiveStore } from "../live/store.ts";
import {
	createThrottle,
	type Scheduler,
	type TimerHandle,
} from "../live/scheduler.ts";
import type { Tone, UiAction, UiJson } from "../ui/nodeTypes.ts";
import { applyActionEffects } from "./actions.ts";
import type { SlotCtxHint } from "./ctx.ts";

export const SLOT_REFRESH_MIN_MS = 1000;
/** The contract's floor for `refreshMs` (`UiDocSchema`). */
export const SLOT_REFRESH_MS_FLOOR = 5000;

export type SlotState = {
	doc: SlotRenderResponse | null;
	error: string | null;
	loading: boolean;
	busy: boolean;
};

export type SlotControllerDeps = {
	readonly api: Pick<Api, "slots">;
	readonly live: LiveStore | null;
	readonly scheduler: Scheduler;
	readonly instance: SlotInstanceDto;
	/** The hint this slot takes now (already narrowed to its slot). */
	readonly ctx: () => SlotCtxHint;
	/** Repo of the page, for the live feed (none on forge/node pages). */
	readonly repoId?: () => string | undefined;
	readonly navigate: (path: string) => void;
	readonly toast: (toast: { tone: Tone; text: string }) => void;
	readonly refreshSlots: (ids: readonly string[]) => void;
	readonly confirm: (text: string) => boolean;
};

export type SlotController = {
	readonly state: Readonly<SlotState>;
	readonly start: () => void;
	readonly stop: () => void;
	/** Throttled re-render (≤ 1/s). */
	readonly refresh: () => void;
	/**
	 * The ctx changed: drop the document and anything in flight for the old
	 * ctx, re-subscribe (the repo may have changed) and render now.
	 */
	readonly reload: () => void;
	readonly runAction: (action: UiAction, payload?: UiJson) => Promise<void>;
};

const docRefreshOn = (doc: SlotRenderResponse | null): readonly string[] =>
	doc && Array.isArray(doc.refreshOn) ? doc.refreshOn : [];

const docRefreshMs = (doc: SlotRenderResponse | null): number | null =>
	doc && typeof doc.refreshMs === "number" && Number.isFinite(doc.refreshMs)
		? Math.max(SLOT_REFRESH_MS_FLOOR, doc.refreshMs)
		: null;

export const createSlotController = (
	deps: SlotControllerDeps,
): SlotController => {
	const state = reactive<SlotState>({
		doc: null,
		error: null,
		loading: false,
		busy: false,
	});
	let running = false;
	let generation = 0;
	/** Bumped by `reload()`: an action started before it keeps its toast only. */
	let ctxVersion = 0;
	let unsubscribe: (() => void) | null = null;
	let subscribedPatterns = "";
	let poll: TimerHandle | null = null;

	const patterns = (): string[] => [
		...new Set([...deps.instance.refreshOn, ...docRefreshOn(state.doc)]),
	];

	const resubscribe = (): void => {
		const repoId = deps.repoId?.();
		if (!running) return;
		if (!deps.live || !repoId) {
			unsubscribe?.();
			unsubscribe = null;
			subscribedPatterns = "";
			return;
		}
		const next = patterns();
		// The render's cursor (the repo's log head before it ran) is where this
		// view stands: the feed replays from it, or resyncs a view it is past.
		const since = typeof state.doc?.cursor === "number"
			? state.doc.cursor
			: undefined;
		const key = `${repoId}\n${since ?? ""}\n${next.join("\n")}`;
		if (key === subscribedPatterns && unsubscribe) return;
		// Subscribe before unsubscribing, so the shared socket stays open.
		const previous = unsubscribe;
		subscribedPatterns = key;
		unsubscribe = next.length === 0 ? null : deps.live.subscribe(repoId, {
			patterns: next,
			onEvents: () => throttle.trigger(),
			onResync: () => throttle.trigger(),
			...(since === undefined ? {} : { since }),
		});
		previous?.();
	};

	const schedulePoll = (): void => {
		if (poll !== null) deps.scheduler.clearTimeout(poll);
		poll = null;
		const ms = docRefreshMs(state.doc);
		if (ms === null || !running) return;
		poll = deps.scheduler.setTimeout(() => {
			poll = null;
			throttle.trigger();
		}, ms);
	};

	const apply = (doc: SlotRenderResponse): void => {
		state.doc = doc;
		state.error = null;
		resubscribe();
		schedulePoll();
	};

	const load = async (): Promise<void> => {
		const mine = ++generation;
		state.loading = true;
		try {
			const doc = await deps.api.slots.render(
				deps.instance.installationId,
				deps.instance.id,
				deps.ctx(),
			);
			if (mine === generation && running) apply(doc);
		} catch (e) {
			if (mine === generation && running) {
				state.error = errorMessage(e);
				schedulePoll();
			}
		} finally {
			if (mine === generation) state.loading = false;
		}
	};

	const throttle = createThrottle(
		() => void load(),
		SLOT_REFRESH_MIN_MS,
		deps.scheduler,
	);

	const handleResult = (result: ActionResponse, current: boolean): void => {
		if (result.render && current) {
			generation += 1; // drop any in-flight render: the action's wins
			state.loading = false;
			apply(result.render);
		}
		applyActionEffects(result, deps);
	};

	const runAction = async (
		action: UiAction,
		payload?: UiJson,
	): Promise<void> => {
		if (state.busy) return;
		if (action.confirm && !deps.confirm(action.confirm)) return;
		state.busy = true;
		const version = ctxVersion;
		try {
			const result = await deps.api.slots.action(
				deps.instance.installationId,
				deps.instance.id,
				{
					action: action.id,
					payload: payload ?? action.payload,
					ctx: deps.ctx(),
				},
			);
			if (running) handleResult(result, version === ctxVersion);
		} catch (e) {
			deps.toast({ tone: "danger", text: errorMessage(e) });
		} finally {
			state.busy = false;
		}
	};

	return {
		state,
		start: () => {
			if (running) return;
			running = true;
			resubscribe();
			throttle.trigger();
		},
		stop: () => {
			running = false;
			generation += 1;
			throttle.cancel();
			unsubscribe?.();
			unsubscribe = null;
			subscribedPatterns = "";
			if (poll !== null) deps.scheduler.clearTimeout(poll);
			poll = null;
		},
		refresh: () => throttle.trigger(),
		reload: () => {
			generation += 1; // a late render for the old ctx is ignored
			ctxVersion += 1;
			throttle.cancel();
			if (poll !== null) deps.scheduler.clearTimeout(poll);
			poll = null;
			state.doc = null;
			state.error = null;
			state.loading = false;
			if (!running) return;
			resubscribe();
			void load();
		},
		runAction,
	};
};
