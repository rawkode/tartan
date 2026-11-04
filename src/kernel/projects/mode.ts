// The `TARTAN_PROJECTS` switch: `scan` serves the projects API and pages and
// discovers each trunk push eagerly; `off` (the default) hides every project
// surface. Detection itself does not depend on it: RepoProbe finds the same
// `package tartan` projects either way, when something asks.
// It is rendered by `scripts/render-config.ts` (`deploy --projects`).

import type { Env } from "../../env.ts";

export type ProjectsMode = "off" | "scan";

/** `TARTAN_PROJECTS` of a Worker env: `scan` only when set exactly so. */
export const projectsMode = (
	env: Pick<Env, "TARTAN_PROJECTS">,
): ProjectsMode => env.TARTAN_PROJECTS === "scan" ? "scan" : "off";
