// Loads and keeps the Change Graph live for one repo:
//
// 1. subscribe to `/-/live?repo=<id>` first (frames are buffered until the
//    history is folded, so nothing between the read and the socket is lost);
// 2. the active lanes (WP5a `GET /-/api/lanes?repo=<path>&state=…`, paged,
//    at most `MAX_LANES`), the viewer's agents (names and models; optional),
//    and the last `HISTORY` seqs of the repo log (WP6 `GET /-/api/events`,
//    filtered to the graph's event patterns);
// 3. fold the history, then the buffered and later live frames; a `gap`
//    frame or a reconnect that could not resume reloads everything.
//
// Lanes an event names but the list did not have (opened after the read, or
// finished ones) are fetched one by one (`GET /-/api/lanes/<id>`).

import {
	computed,
	type ComputedRef,
	onScopeDispose,
	type Ref,
	ref,
	shallowRef,
	watch,
} from "vue";
import type { Envelope } from "@tartan/contract/events.ts";
import type { Api } from "../../../api/client.ts";
import { errorMessage } from "../../../api/http.ts";
import type { LiveStatus, LiveStore } from "../../../live/store.ts";
import type { Scheduler } from "../../../live/scheduler.ts";
import {
	ACTIVE_STATES,
	type AgentInfo,
	emptyGraph,
	foldEvents,
	GRAPH_EVENT_PATTERNS,
	type GraphState,
	type LaneRow,
	laneRows,
	withLanes,
} from "./model.ts";

/** Lanes read per page (WP5a's maximum) and in total. */
export const LANES_PAGE = 200;
export const MAX_LANES = 1000;
/** How far back the event history reaches (WP6's maximum page). */
export const HISTORY = 500;
/** The axis' "now" moves this often. */
export const CLOCK_MS = 30_000;

export type ChangeGraph = {
	readonly rows: ComputedRef<readonly LaneRow[]>;
	readonly graph: Readonly<Ref<GraphState>>;
	readonly loading: Readonly<Ref<boolean>>;
	readonly error: Readonly<Ref<string | null>>;
	/** True when more active lanes exist than were read. */
	readonly truncated: Readonly<Ref<boolean>>;
	readonly live: ComputedRef<LiveStatus>;
	readonly now: Readonly<Ref<number>>;
	readonly reload: () => Promise<void>;
	/** Ensures one lane is in the graph (the lane page), whatever its state. */
	readonly ensureLane: (laneId: string) => Promise<void>;
};

export const useChangeGraph = (deps: {
	readonly api: Api;
	readonly live: LiveStore;
	readonly scheduler: Scheduler;
	/** The repo's node path and id; null until the view has loaded. */
	readonly repo: () => { readonly path: string; readonly id: string } | null;
}): ChangeGraph => {
	const { api, live, scheduler } = deps;
	const graph = shallowRef<GraphState>(emptyGraph());
	const agents = shallowRef<ReadonlyMap<string, AgentInfo>>(new Map());
	const loading = ref(false);
	const error = ref<string | null>(null);
	const truncated = ref(false);
	const now = ref(scheduler.now());

	let generation = 0;
	let buffer: Envelope[] | null = null;
	const fetching = new Set<string>();
	/** Lanes the page asked for by id: kept across reloads. */
	const pinned = new Set<string>();
	let current: { path: string; id: string } | null = null;

	const fetchUnknown = (): void => {
		const repo = current;
		if (!repo) return;
		for (const laneId of graph.value.unknownLanes) {
			if (fetching.has(laneId)) continue;
			fetching.add(laneId);
			const mine = generation;
			void api.lanes.get(repo.path, laneId)
				.then((lane) => {
					if (mine !== generation) return;
					// Done: a later backend change may ask for it again.
					fetching.delete(laneId);
					graph.value = withLanes(graph.value, [lane]);
				})
				.catch(() => {
					// A lane the viewer cannot read (or one already deleted) stays
					// out, and is not asked for again until the next reload.
				});
		}
	};

	const apply = (events: readonly Envelope[]): void => {
		if (buffer !== null) {
			buffer.push(...events);
			return;
		}
		graph.value = foldEvents(graph.value, events);
		fetchUnknown();
	};

	const loadAgents = async (): Promise<void> => {
		try {
			const { agents: list } = await api.agents.list();
			agents.value = new Map(
				list.map((a) => [a.id, {
					handle: a.handle,
					display: a.display,
					...(a.tool ? { tool: a.tool } : {}),
					...(a.model ? { model: a.model } : {}),
				}]),
			);
		} catch {
			// Names are a nicety: other people's agents show their principal id.
		}
	};

	const load = async (repo: { path: string; id: string }): Promise<void> => {
		const mine = ++generation;
		current = repo;
		fetching.clear();
		buffer = [];
		loading.value = true;
		error.value = null;
		try {
			const lanes = [];
			let cursor: string | undefined;
			do {
				const page = await api.lanes.list(repo.path, {
					state: ACTIVE_STATES,
					limit: LANES_PAGE,
					...(cursor ? { cursor } : {}),
				});
				lanes.push(...page.lanes);
				cursor = page.cursor;
			} while (cursor && lanes.length < MAX_LANES);
			const head = (await api.events.list(repo.id, { limit: 1 })).head;
			const history = await api.events.list(repo.id, {
				since: Math.max(0, head - HISTORY),
				limit: HISTORY,
				types: GRAPH_EVENT_PATTERNS,
			});
			await loadAgents();
			if (mine !== generation) return;
			truncated.value = cursor !== undefined;
			const pending = buffer ?? [];
			buffer = null;
			const folded = foldEvents(
				foldEvents(withLanes(emptyGraph(), lanes), history.events),
				pending,
			);
			const missing = [...pinned].filter((id) => !folded.lanes.has(id));
			graph.value = missing.length === 0 ? folded : {
				...folded,
				unknownLanes: new Set([...folded.unknownLanes, ...missing]),
			};
			fetchUnknown();
		} catch (e) {
			if (mine === generation) {
				buffer = null;
				error.value = errorMessage(e);
			}
		} finally {
			if (mine === generation) loading.value = false;
		}
	};

	let unsubscribe: (() => void) | null = null;
	watch(
		() => deps.repo(),
		(repo, before) => {
			if (repo?.id === before?.id && repo?.path === before?.path) return;
			unsubscribe?.();
			unsubscribe = null;
			graph.value = emptyGraph();
			if (!repo) return;
			unsubscribe = live.subscribe(repo.id, {
				patterns: GRAPH_EVENT_PATTERNS,
				onEvents: apply,
				onResync: () => void load(repo),
			});
			void load(repo);
		},
		{ immediate: true },
	);

	let tick: unknown = null;
	const schedule = (): void => {
		tick = scheduler.setTimeout(() => {
			now.value = scheduler.now();
			schedule();
		}, CLOCK_MS);
	};
	schedule();

	onScopeDispose(() => {
		generation += 1;
		unsubscribe?.();
		scheduler.clearTimeout(tick);
	});

	const repoId = computed(() => deps.repo()?.id ?? null);

	return {
		rows: computed(() => laneRows(graph.value, agents.value)),
		graph,
		loading,
		error,
		truncated,
		live: computed(() =>
			repoId.value ? live.status(repoId.value).value : "closed"
		),
		now,
		reload: () => (current ? load(current) : Promise.resolve()),
		ensureLane: async (laneId) => {
			pinned.add(laneId);
			const repo = current ?? deps.repo();
			if (!repo || graph.value.lanes.has(laneId)) return;
			const mine = generation;
			const lane = await api.lanes.get(repo.path, laneId);
			if (mine === generation) graph.value = withLanes(graph.value, [lane]);
		},
	};
};
