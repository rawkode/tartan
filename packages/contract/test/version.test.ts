// The contract's version markers agree: `CONTRACT_VERSION`, `package.json`
// and, where the checkout carries one, the newest CHANGELOG.md entry.

import { equal } from "node:assert/strict";
import { CONTRACT_VERSION } from "../src/product.ts";
import pkg from "../package.json" with { type: "json" };

Deno.test("CONTRACT_VERSION, package.json and the newest CHANGELOG entry name one version", async () => {
	equal(CONTRACT_VERSION, pkg.version);
	const changelog = await Deno.readTextFile(
		new URL("../CHANGELOG.md", import.meta.url),
	).catch(() => null);
	if (changelog === null) return;
	const newest = /^## (\d+\.\d+\.\d+) /m.exec(changelog)?.[1];
	equal(newest, pkg.version);
});
