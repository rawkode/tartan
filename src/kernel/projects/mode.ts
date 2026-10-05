// The `TARTAN_PROJECTS` switch (WP25 slice A′): `off`
// (the default) keeps the detector chain without cuenv and hides every
// project surface; `scan` makes cuenv `#Project`s the primary detector
// (Tier 0, a textual scan) and serves the projects API and pages. `eval`
// (Tier 1, `cue export`) comes after submission.
// It is rendered by `scripts/render-config.ts` (`deploy --projects`).

import type { Env } from "../../env.ts";

export type ProjectsMode = "off" | "scan";

/** `TARTAN_PROJECTS` of a Worker env: `scan` only when set exactly so. */
export const projectsMode = (
	env: Pick<Env, "TARTAN_PROJECTS">,
): ProjectsMode => env.TARTAN_PROJECTS === "scan" ? "scan" : "off";
