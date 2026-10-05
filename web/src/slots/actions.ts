// Slot action results, shared by the slot hosts
// (`controller.ts`) and the repo header actions (`RepoFrame.vue`):
//
// - `applyActionEffects`: a result's `toast`, `navigate` (same-origin paths
//   only, re-checked here) and `refresh` of sibling slots by contribution id.
//   A `render` replaces a slot's document, so only a slot host applies it.
// - `postStaticAction`: a `static+action` contribution such as
//   `repo.header.action` (a button with no document). Its action name is its
//   contribution id, and the page's hint is narrowed to the slot's context
//   (the kernel re-derives and confines it, K12).

import type {
	ActionResponse,
	StaticContributionDto,
} from "@tartan/contract/api.ts";
import type { Api } from "../api/client.ts";
import { errorMessage } from "../api/http.ts";
import { sameOriginPath } from "../ui/links.ts";
import type { Tone } from "../ui/nodeTypes.ts";
import { narrowCtx, type SlotCtxHint } from "./ctx.ts";

export type ActionEffects = {
	readonly navigate: (path: string) => void;
	readonly toast: (toast: { tone: Tone; text: string }) => void;
	readonly refreshSlots: (ids: readonly string[]) => void;
};

/** Applies a result's toast, navigation and sibling refreshes (not `render`). */
export const applyActionEffects = (
	result: ActionResponse,
	effects: ActionEffects,
): void => {
	if (result.toast) effects.toast(result.toast);
	const path = sameOriginPath(result.navigate);
	if (path !== null) effects.navigate(path);
	if (Array.isArray(result.refresh) && result.refresh.length > 0) {
		effects.refreshSlots(result.refresh);
	}
};

export type StaticActionDeps = ActionEffects & {
	readonly api: Pick<Api, "slots">;
};

/**
 * Posts a `static+action` contribution (`POST /-/api/slot/<inst>/<id>/action`
 * with `{action: <id>, ctx}`) and applies the result. Failures become a
 * danger toast; nothing throws.
 */
export const postStaticAction = async (
	deps: StaticActionDeps,
	contribution: Pick<StaticContributionDto, "installationId" | "id" | "slot">,
	page: SlotCtxHint,
): Promise<void> => {
	try {
		const result = await deps.api.slots.action(
			contribution.installationId,
			contribution.id,
			{ action: contribution.id, ctx: narrowCtx(contribution.slot, page) },
		);
		applyActionEffects(result, deps);
	} catch (e) {
		deps.toast({ tone: "danger", text: errorMessage(e) });
	}
};
