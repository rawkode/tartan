// The derived JSON files of this package and how to build them from zod
// (used by `scripts/gen-schemas.ts` and the drift test).

import { z } from "zod";
import { EnvelopeSchema } from "./events.ts";
import { INTERFACES, interfaceToJson } from "./interfaces.ts";

export const envelopeJsonSchema = (): Record<string, unknown> => {
	const schema = z.toJSONSchema(EnvelopeSchema, {
		target: "draft-2020-12",
		io: "input",
		unrepresentable: "any",
	}) as Record<string, unknown>;
	const { $schema: _drop, ...rest } = schema;
	return {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		$id: "https://tartan.dev/schema/envelope-1.json",
		title: "Tartan event envelope v1",
		description:
			"Generated from packages/contract/src/events.ts (EnvelopeSchema). Payloads (`data`) are validated per type: kernel events by KernelEventSchema, interface events by interfaces/<name>@<major>.json.",
		...rest,
	};
};

/** Package-relative path → JSON value. */
export const generatedFiles = (): Record<string, unknown> => ({
	"schema/envelope-1.json": envelopeJsonSchema(),
	...Object.fromEntries(
		Object.values(INTERFACES).map((def) => [
			`interfaces/${def.id}.json`,
			interfaceToJson(def),
		]),
	),
});
