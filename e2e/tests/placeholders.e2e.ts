// Features that are designed but not merged yet. Each is a skipped test with
// the flow it will check, tagged `pending`, so the report lists it and the
// skip is flipped when the feature lands:
//
// - Monorepo projects: project pages list only that project's work items
//   and changes; a project-scoped installation's tabs appear only under
//   that project.
// - The setup pack step installs at the owner's root node, also for a
//   reserved handle.
//
// Repository config in CUE has merged: tests/repo-config.e2e.ts and step 1
// of tests/loop/m1-loop.e2e.ts check it.

import { test } from "../support/fixtures.ts";

test.describe("pending features", { tags: ["pending"] }, () => {
	test("projects: a project page lists only that project's items and changes", {
		tags: ["projects"],
		skip: "pending: monorepo project pages",
	}, async () => {});

	test("projects: a project-scoped installation's tabs appear only under it", {
		tags: ["projects"],
		skip: "pending: monorepo project pages",
	}, async () => {});

	test("the setup pack step installs at the owner's root node", {
		tags: ["setup-pack-node"],
		skip: "pending: the pack step uses the handle, not the root",
	}, async () => {});
});
