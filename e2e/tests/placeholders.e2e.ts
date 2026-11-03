// Features that are designed but not merged yet. Each is a skipped test with
// the flow it will check, tagged `pending`, so the report lists it and the
// skip is flipped when the feature lands:
//
// - Project-scoped installations (not built yet): a project's own
//   installation's tabs appear only under that project.
//
// Merged and checked elsewhere: repository config in CUE
// (tests/repo-config.e2e.ts, tests/cue/cue-config.e2e.ts) and monorepo
// projects slice A′ (tests/projects/projects.e2e.ts).

import { test } from "../support/fixtures.ts";

test.describe("pending features", { tags: ["pending"] }, () => {
	test("projects: a project-scoped installation's tabs appear only under it", {
		tags: ["projects"],
		skip:
			"pending: per-project installations are not built yet (the first projects slice ships without them)",
	}, async () => {});
});
