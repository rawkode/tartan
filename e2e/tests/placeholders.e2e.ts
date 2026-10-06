// Features that are designed but not merged yet. Each is a skipped test with
// the flow it will check, tagged `pending`, so the report lists it and the
// skip is flipped when the feature lands:
//
// - The setup pack step installs at the owner's root node, also for a
//   reserved handle.
// - Project-scoped installations (not built yet): a project's own
//   installation's tabs appear only under that project.
//
// Merged and checked elsewhere: repository config in CUE
// (tests/repo-config.e2e.ts, tests/cue/cue-config.e2e.ts, step 1 of the M1
// loop) and monorepo projects slice A′ (tests/projects/projects.e2e.ts).

import { test } from "../support/fixtures.ts";

test.describe("pending features", { tags: ["pending"] }, () => {
	test("projects: a project-scoped installation's tabs appear only under it", {
		tags: ["projects"],
		skip:
			"pending: per-project installations are not built yet (the first projects slice ships without them)",
	}, async () => {});

	test("the setup pack step installs at the owner's root node", {
		tags: ["setup-pack-node"],
		skip: "pending: the pack step uses the handle, not the root",
	}, async () => {});
});
