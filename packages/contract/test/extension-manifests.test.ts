// Every `extensions/**/tartan.json` in the repo
// (including the packs under `extensions/packs/*/`) is a valid manifest (zod +
// JSON Schema) and passes the bundled-builtin policy checks.

import { deepStrictEqual, ok } from "node:assert/strict";
import { manifestPolicyIssues, parseManifest } from "../src/manifest.ts";
import { loadSchema } from "./helpers.ts";

const extensionsDir = new URL("../../../extensions/", import.meta.url);
const SKIP_DIRS = new Set(["node_modules", "dist", "target"]);

const walkManifests = async (dir: URL): Promise<URL[]> => {
	const found: URL[] = [];
	for await (const entry of Deno.readDir(dir)) {
		if (entry.isDirectory && !SKIP_DIRS.has(entry.name)) {
			found.push(...(await walkManifests(new URL(`${entry.name}/`, dir))));
		} else if (entry.isFile && entry.name === "tartan.json") {
			found.push(new URL(entry.name, dir));
		}
	}
	return found;
};

const manifestPaths = async (): Promise<URL[]> =>
	(await walkManifests(extensionsDir)).sort((a, b) =>
		a.href.localeCompare(b.href)
	);

Deno.test("extensions/**/tartan.json validate against manifest v1", async () => {
	const schema = await loadSchema("schema/manifest-1.json");
	const paths = await manifestPaths();
	ok(paths.length > 0, "no extensions/**/tartan.json found");
	for (const url of paths) {
		const name = url.href.slice(extensionsDir.href.length);
		const raw = JSON.parse(await Deno.readTextFile(url));
		const json = schema(raw);
		ok(json.valid, `${name} (json schema): ${json.errors.join("; ")}`);
		const parsed = parseManifest(raw);
		ok(
			parsed.ok,
			`${name} (zod): ${parsed.ok ? "" : parsed.errors.join("; ")}`,
		);
		const bundled = raw.id?.startsWith("tartan.") === true;
		deepStrictEqual(
			manifestPolicyIssues(parsed.manifest, { bundled }),
			[],
			`${name} policy`,
		);
	}
});
