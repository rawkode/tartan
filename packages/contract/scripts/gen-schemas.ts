// Regenerates the derived JSON files of @tartan/contract from their zod
// sources of truth:
//   interfaces/<name>@<major>.json  ← src/interfaces.ts
//   schema/envelope-1.json          ← src/events.ts EnvelopeSchema
// `manifest-1.json` and `ui-1.json` are hand-written normative schemas and are
// not generated. `generated.test.ts` fails when a checked-in file drifts.
//
// Usage: deno run -A packages/contract/scripts/gen-schemas.ts && deno fmt packages/contract

import { generatedFiles } from "../src/generated.ts";

const root = new URL("../", import.meta.url);

for (const [path, value] of Object.entries(generatedFiles())) {
	const url = new URL(path, root);
	await Deno.mkdir(new URL("./", url), { recursive: true });
	await Deno.writeTextFile(url, `${JSON.stringify(value, null, "\t")}\n`);
	console.log(`wrote ${path}`);
}
