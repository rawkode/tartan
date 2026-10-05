// HTTP handler of the projects API (WP25 slice A′), routed in
// `src/router.ts` as:
//
//   {
//     id: "api.repos.projects",
//     owner: "WP25",
//     methods: READ,
//     policy: POLICY.apiPublic,
//     pattern: /^\/-\/api\/repos\/(?<repoId>[^/]+)\/projects(?:\/(?<rest>.+))?$/,
//     handler: handleProjects,
//   }

import type { RouteHandler } from "../../router.ts";
import { createProjectsHandler } from "./api.ts";

/** `GET /-/api/repos/<repoId>/projects[/<project>[/issues|/changes]]`. */
export const handleProjects: RouteHandler = createProjectsHandler();
