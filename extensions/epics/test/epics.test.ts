// tartan.epics while it is an M0 stub: the `decompose` tool (MCP
// `epics_decompose`) and slot actions stay undeclared until they work (M2), so
// agents are not offered a tool that always fails with `not_implemented` and a
// slot action is refused ("has no actions") rather than silently ignored.

import { parseManifest, validateUi } from "@tartan/contract";
import { createTestHarness } from "@tartan/ext-api/testing.ts";
import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import manifestJson from "../tartan.json" with { type: "json" };
import { extension, migrations } from "../src/index.ts";

const result = parseManifest(manifestJson);
if (!result.ok) throw new Error(result.errors.join("; "));
const manifest = result.manifest;

const SLOT_CTX = {
	node: "01k6aaaaaaaaaaaaaaaaaaaaab",
	mode: "enforce",
} as const;

Deno.test("no tools and no provided interfaces, so no epics_decompose", () => {
	equal(manifest.contributes?.tools, undefined);
	equal(manifest.provides, undefined);
});

Deno.test("the module has no action or tool hooks", () => {
	deepStrictEqual(Object.keys(extension).sort(), [
		"init",
		"onEvent",
		"render",
	]);
});

Deno.test("slots render valid placeholders; actions and tools are refused", async () => {
	const h = createTestHarness({ module: extension, migrations });
	try {
		const slots = manifest.contributes?.slots ?? [];
		ok(slots.length > 0);
		for (const slot of slots) {
			const doc = await h.render(slot.id, SLOT_CTX);
			ok(validateUi(doc).ok, slot.id);
			equal(doc.root.t, "empty", slot.id);
		}
		await rejects(h.action("anything", {}, SLOT_CTX));
		await rejects(h.tool("decompose", { epic: 1 }, undefined as never));
	} finally {
		h.close();
	}
});
