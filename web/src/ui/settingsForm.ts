// `contributes.settings` (a JSON Schema in an extension's manifest) → a
// `tartan-ui@1` form, rendered by the same host components as any slot, so
// every title, description and value stays text. Only flat
// object schemas with string/number/integer/boolean/enum properties become
// fields; anything else is listed as unsupported rather than guessed at.
//
// Form field names must match the contract's `^[a-z0-9_]{1,32}$`, which
// camelCase property names do not, so fields are named `f0`, `f1`, … and
// `settingsValues()` maps submitted values back to property names.

import type { UiNode } from "./nodeTypes.ts";

const MAX_FIELDS = 30;
const MAX_PROPERTY_NAME = 64;

type Obj = Readonly<Record<string, unknown>>;
const isObj = (v: unknown): v is Obj =>
	typeof v === "object" && v !== null && !Array.isArray(v);

export type SettingsForm = {
	readonly form: UiNode | null;
	/** Property names that could not be rendered. */
	readonly unsupported: readonly string[];
	/** Field name (`f0`, …) → property name. */
	readonly names: Readonly<Record<string, string>>;
};

const text = (value: unknown, max: number): string | undefined =>
	typeof value === "string" ? value.slice(0, max) : undefined;

export const SETTINGS_ACTION_ID = "tartan.settings.save";

const fieldFor = (
	field: string,
	prop: Obj,
	label: string,
	value: unknown,
	required: boolean,
): UiNode | null => {
	const req = required ? { required: true } : {};
	if (Array.isArray(prop["enum"])) {
		const options = prop["enum"].filter((o): o is string | number =>
			typeof o === "string" || typeof o === "number"
		).slice(0, 100);
		return {
			t: "select",
			name: field,
			label,
			options,
			...(typeof value === "string" || typeof value === "number"
				? { value }
				: {}),
			...req,
		};
	}
	switch (prop["type"]) {
		case "boolean":
			return { t: "checkbox", name: field, label, value: value === true };
		case "integer":
		case "number":
			return {
				t: "input",
				name: field,
				label,
				value: typeof value === "number" && Number.isFinite(value) ? value : 0,
				...req,
			};
		case "string":
			return {
				t: prop["format"] === "textarea" ? "textarea" : "input",
				name: field,
				label,
				value: typeof value === "string" ? value : "",
				...req,
			};
		default:
			return null;
	}
};

export const settingsForm = (
	schema: unknown,
	config: unknown,
): SettingsForm => {
	if (!isObj(schema) || !isObj(schema["properties"])) {
		return { form: null, unsupported: [], names: {} };
	}
	const current = isObj(config) ? config : {};
	const required = new Set(
		Array.isArray(schema["required"])
			? schema["required"].filter((r): r is string => typeof r === "string")
			: [],
	);
	const fields: UiNode[] = [];
	const unsupported: string[] = [];
	const names: Record<string, string> = {};
	for (const [name, prop] of Object.entries(schema["properties"])) {
		const field = `f${fields.length}`;
		const node = fields.length < MAX_FIELDS && isObj(prop) &&
				name.length <= MAX_PROPERTY_NAME
			? fieldFor(
				field,
				prop,
				text(prop["title"], 120) ?? name,
				current[name] ?? prop["default"],
				required.has(name),
			)
			: null;
		if (node === null) {
			unsupported.push(name);
			continue;
		}
		fields.push(node);
		names[field] = name;
	}
	return {
		form: fields.length === 0 ? null : {
			t: "form",
			fields,
			submit: { text: "Save settings", action: { id: SETTINGS_ACTION_ID } },
		},
		unsupported,
		names,
	};
};

/** Submitted form values (by field name) → config values (by property name). */
export const settingsValues = (
	form: SettingsForm,
	values: Readonly<Record<string, unknown>>,
): Record<string, unknown> =>
	Object.fromEntries(
		Object.entries(values).flatMap(([field, value]) => {
			const name = form.names[field];
			return name === undefined ? [] : [[name, value]];
		}),
	);
