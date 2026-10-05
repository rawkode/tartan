// Test helpers: JSON Schema (draft 2020-12) validation with
// @cfworker/json-schema (runs in Workers too), and fixture loading.

import { type Schema, Validator } from "@cfworker/json-schema";

const root = new URL("../", import.meta.url);

export const readJson = async (path: string): Promise<unknown> =>
	JSON.parse(await Deno.readTextFile(new URL(path, root)));

export type JsonCheck = (
	value: unknown,
) => { valid: boolean; errors: string[] };

export const jsonSchemaValidator = (schema: unknown): JsonCheck => {
	const validator = new Validator(schema as Schema, "2020-12", false);
	return (value) => {
		const result = validator.validate(value);
		return {
			valid: result.valid,
			errors: result.errors.map((e) => `${e.instanceLocation}: ${e.error}`),
		};
	};
};

export const loadSchema = async (path: string): Promise<JsonCheck> =>
	jsonSchemaValidator(await readJson(path));

/** Deep-clones JSON data so a test can mutate one fixture without touching others. */
export const clone = <T>(value: T): T => structuredClone(value);
