// `POST /-/api/repos/<repoId>/import-complete` (WP3 route and DTO; the logic is
// WP5a's `RepoCoreFacade.importComplete`): an Owner of the repo
// (credential-bounded, never an agent) ends import mode. RepoDO reconciles the
// refs, seeds `trunk_commits`, turns protection and lanes on (⇒
// `repo.imported`); the tree then records the default branch on the node (⇒
// forge `repo.imported`).

import {
	denied,
	ImportCompleteRequestSchema,
	type ImportCompleteResponse,
	isUlid,
	notFound,
} from "@tartan/contract";
import type { RouteHandler } from "../../router.ts";
import { accessFacts, decide } from "../tree/authz.ts";
import { browseDepsOf } from "./deps.ts";
import { failure, json, readJson, requireAuth } from "./http.ts";
import type { BrowseDepsFor } from "./repo.ts";

export const createImportCompleteHandler = (
	depsFor: BrowseDepsFor = (c) => browseDepsOf(c.env, c.ctx),
): RouteHandler =>
async (c) => {
	try {
		const auth = requireAuth(c.auth);
		const deps = depsFor(c);
		const repoId = c.params.repoId ?? "";
		if (!isUlid(repoId)) throw notFound("no such repo");
		const tree = deps.tree();
		const node = await tree.node(repoId);
		if (node === null || node.kind !== "repo") throw notFound("no such repo");
		const facts = await accessFacts(tree, auth, node);
		try {
			decide(auth, node, facts, "read-metadata");
		} catch {
			throw notFound("no such repo");
		}
		decide(auth, node, facts, "grant");
		if (auth.kind !== "user") {
			throw denied("role", "an agent cannot complete an import");
		}
		const body = await readJson(c.req, ImportCompleteRequestSchema);
		const result: ImportCompleteResponse = await deps.repo(repoId)
			.importComplete(auth.principal, body);
		await tree.importCompleted(auth.principal, repoId, result.defaultBranch);
		return json(result);
	} catch (error) {
		return failure(error);
	}
};
