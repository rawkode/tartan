// Injection points between the renderer and its host (a slot host, a settings
// form, the gallery). The renderer itself never talks to the network: actions
// go to the host's `UiActionRunner`, and `diff` nodes ask the host's
// `UiDiffSource` (which fetches under the viewer's authz).

import type { InjectionKey, Ref } from "vue";
import type { FileDiff } from "@tartan/contract/git.ts";
import type { UiAction, UiJson } from "./nodeTypes.ts";

export type UiActionRunner = {
	/** Runs an action; resolves when the host has applied the result. */
	readonly run: (action: UiAction, payload?: UiJson) => Promise<void>;
	/** True while an action of this host is in flight. */
	readonly busy: Readonly<Ref<boolean>>;
};

export type UiDiffRequest = {
	readonly repo: string;
	readonly base: string;
	readonly head: string;
	/** Read both sides from this lane (a `repo` lane's commits are in its lane repo). */
	readonly lane?: string;
	readonly paths?: readonly string[];
};

export type UiDiffSource = (
	request: UiDiffRequest,
) => Promise<readonly FileDiff[]>;

/** Form field values keyed by field name (`input`, `select` … inside a `form`). */
export type UiFormState = {
	readonly values: Record<string, UiJson>;
	readonly register: (name: string, initial: UiJson) => void;
};

export const UI_ACTIONS: InjectionKey<UiActionRunner> = Symbol("ui-actions");
export const UI_DIFF_SOURCE: InjectionKey<UiDiffSource> = Symbol("ui-diff");
export const UI_FORM: InjectionKey<UiFormState> = Symbol("ui-form");

/**
 * Payload of a form submit (tartan-ui@1 convention, documented on `ui.form` in
 * `@tartan/ext-api` and in the contract's `ui.ts`): the field values by name
 * at the top level, with the submit action's own payload merged over them, so
 * an action key (`ref`, `changeId` …) beats a field of the same name. A
 * non-object action payload travels as `payload`. There is no `values` key.
 */
export const formPayload = (
	actionPayload: UiJson | undefined,
	values: Readonly<Record<string, UiJson>>,
): UiJson => {
	const base = typeof actionPayload === "object" && actionPayload !== null &&
			!Array.isArray(actionPayload)
		? actionPayload
		: actionPayload === undefined
		? {}
		: { payload: actionPayload };
	return { ...values, ...base };
};
