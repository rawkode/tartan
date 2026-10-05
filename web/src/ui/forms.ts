// Action payloads without a component: the value a field starts with (what
// `UiField` registers in its form), a form's starting values and a board
// move's payload. Pure, so the slot conformance test submits forms and moves
// cards exactly as the SPA would.

import type { UiJson } from "./nodeTypes.ts";

export type FieldKind = "input" | "textarea" | "select" | "checkbox";
type Option = string | number | {
	readonly value: string | number | boolean;
	readonly label: string;
};

const FIELD_KINDS: ReadonlySet<string> = new Set([
	"input",
	"textarea",
	"select",
	"checkbox",
]);

/** A field's value before the viewer edits it. */
export const initialFieldValue = (
	kind: FieldKind,
	value: unknown,
	options: readonly Option[] | undefined,
): UiJson => {
	if (kind === "checkbox") return value === true;
	if (kind === "select") {
		if (value !== undefined && value !== null && !Array.isArray(value)) {
			return value as UiJson;
		}
		const first = options?.[0];
		return first === undefined
			? null
			: typeof first === "object"
			? first.value
			: first;
	}
	if (typeof value === "string" || typeof value === "number") return value;
	return "";
};

type FieldLike = {
	readonly t: FieldKind;
	readonly name: string;
	readonly value?: unknown;
	readonly options?: readonly Option[];
};

const isField = (value: unknown): value is FieldLike =>
	typeof value === "object" && value !== null &&
	FIELD_KINDS.has(String((value as { t?: unknown }).t)) &&
	typeof (value as { name?: unknown }).name === "string";

/** The starting values of a form's fields (nested layout nodes included), by name. */
export const formDefaults = (
	fields: readonly unknown[],
): Record<string, UiJson> => {
	const values: Record<string, UiJson> = {};
	const walk = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const item of value) walk(item);
			return;
		}
		if (typeof value !== "object" || value === null) return;
		if (isField(value)) {
			if (!Object.hasOwn(values, value.name)) {
				values[value.name] = initialFieldValue(
					value.t,
					value.value,
					value.options,
				);
			}
			return;
		}
		for (const child of Object.values(value)) walk(child);
	};
	walk(fields);
	return values;
};

/** A board card move (`board.moveAction`): the action's payload, then `card`, `from`, `to`. */
export const boardMovePayload = (
	actionPayload: UiJson | undefined,
	card: { readonly id: string; readonly col: string },
	to: string,
): UiJson => ({
	...(typeof actionPayload === "object" && actionPayload !== null &&
			!Array.isArray(actionPayload)
		? actionPayload
		: {}),
	card: card.id,
	from: card.col,
	to,
});
