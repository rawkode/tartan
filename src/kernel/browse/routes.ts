// HTTP handlers of the hierarchy and repo browse API (WP3), as the router
// (`src/router.ts`) imports them. Each is built from a factory that takes its
// ports, so tests inject fakes.

import type { RouteHandler } from "../../router.ts";
import { createImportCompleteHandler } from "./imports.ts";
import { createNodesHandler } from "./nodes.ts";
import { createRawHandler } from "./raw.ts";
import {
	createBlobHandler,
	createCommitHandler,
	createCompareHandler,
	createLogHandler,
	createTreeHandler,
} from "./repo.ts";

/** `/-/api/nodes[/*]`: nodes, repo create/import, move, grants, protected refs. */
export const handleNodes: RouteHandler = createNodesHandler();

/** `GET /-/api/tree`: a tree by walking a readable ref. */
export const handleTree: RouteHandler = createTreeHandler();

/** `GET /-/api/blob`: a blob reached from a readable ref. */
export const handleBlob: RouteHandler = createBlobHandler();

/** `GET /-/api/log`: first-parent history. */
export const handleLog: RouteHandler = createLogHandler();

/** `GET /-/api/commit`: one commit with its diff summary. */
export const handleCommit: RouteHandler = createCommitHandler();

/** `GET /-/api/compare`: two revisions. */
export const handleCompare: RouteHandler = createCompareHandler();

/**
 * `POST /-/api/repos/<id>/import-complete` (Owner): ends import mode; the
 * logic is WP5a's `RepoCoreFacade.importComplete`.
 */
export const handleImportComplete: RouteHandler = createImportCompleteHandler();

/** `GET /<repoPath>/-/raw/<ref>/<file>`: raw file with `CSP: sandbox`. */
export const handleRaw: RouteHandler = createRawHandler();
