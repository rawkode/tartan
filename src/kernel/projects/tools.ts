// An extension's tools as JSON for a session (the same cookie, CSRF and token
// rules as every `/-/api` route; the extension host applies the tool's own role
// check, as the viewer):
//
//   POST /-/api/repos/<repoId>/ext/<extensionId>/tools/<toolName>
//     { args: {…}, project?: "<project name>" }
//   ⇒ { result: <tool output> } or { error: { code, message } }
//
// - 404 `not_installed` when the extension has no installation in force at the
//   repo.
// - With `project`: it must exist in the graph at the trunk tip, its root is
//   passed to the tool as `args.project`, and a project with the extension
//   switched off gets 403 `extension_disabled`.
// - Without `project`: the tool runs repo-wide. `args.project` is the kernel's to
//   set, so a caller's own is dropped: it could otherwise reach a project whose
//   switch says off.
//
// The per-project switch is on/off, and it is read textually from the project's
// `.cue` files at the trunk tip. It scopes this route for the UI; it is not a
// security boundary and it is not policy-gated (docs/repo-config.md).

import {
	fromRpcError,
	httpStatus,
	type InstallationInForce,
	notFound,
	type ToolContext,
	toWire,
	unauthenticated,
} from "@tartan/contract";
import { actorBoundsOf } from "@tartan/contract/kernel.ts";
import { z } from "zod";
import type { RouteHandler } from "../../router.ts";
import { readJson } from "../browse/http.ts";
import { openRepo, type ProjectsDepsFor } from "./api.ts";
import { projectsDepsOf } from "./deps.ts";
import { projectView, resolveProject } from "./resolve.ts";

const BodySchema = z.object({
	args: z.record(z.string(), z.unknown()).default({}),
	project: z.string().min(1).max(512).optional(),
}).strict();

const answer = (body: unknown, status = 200): Response =>
	Response.json(body, {
		status,
		headers: { "cache-control": "no-store" },
	});

const fail = (code: string, message: string, status: number): Response =>
	answer({ error: { code, message } }, status);

const failure = (error: unknown): Response => {
	const wire = toWire(error);
	if (wire.error === "internal") {
		console.error(
			"[tartan] extension tool: internal error",
			fromRpcError(error).message,
		);
	}
	return fail(wire.error, wire.message, httpStatus(wire.error));
};

export const createExtensionToolHandler = (
	depsFor: ProjectsDepsFor = (c) => projectsDepsOf(c.env, c.ctx),
): RouteHandler =>
async (c) => {
	try {
		const auth = c.auth;
		if (auth === null) throw unauthenticated();
		const deps = depsFor(c);
		const target = await openRepo(deps, auth, c.params.repoId ?? "");
		const repoId = target.node.id;
		const extensionId = c.params.extensionId ?? "";
		const body = await readJson(c.req, BodySchema);

		const installation: InstallationInForce | undefined =
			(await deps.inForce(repoId)).find((i) => i.manifest.id === extensionId);
		if (installation === undefined) {
			return fail(
				"not_installed",
				`${extensionId} is not installed at ${target.node.path}`,
				404,
			);
		}

		const { project: _ignored, ...args } = body.args;
		if (body.project !== undefined) {
			const tip = (await deps.repo(repoId).info()).trunkSha;
			if (tip === null) throw notFound("the repo has no commits yet");
			const graph = await deps.graph(repoId, tip);
			const project = resolveProject(projectView(graph), body.project);
			if (project === null) {
				throw notFound(`no project ${body.project} at ${tip}`);
			}
			if (project.extensions[extensionId]?.enabled === false) {
				return fail(
					"extension_disabled",
					`${extensionId} is switched off in ${project.name}`,
					403,
				);
			}
			args.project = project.root;
		}

		const ctx: ToolContext = {
			node: repoId,
			repo: repoId,
			scope: target.node.path,
			actor: {
				kind: auth.kind,
				id: auth.principal,
				...(auth.onBehalfOf ? { onBehalfOf: auth.onBehalfOf } : {}),
			},
			mode: installation.installation.mode === "shadow" ? "shadow" : "enforce",
		};
		const result = await deps.callTool(
			installation,
			repoId,
			c.params.toolName ?? "",
			args,
			ctx,
			actorBoundsOf(auth),
		);
		return answer({ result: result ?? null });
	} catch (error) {
		return failure(error);
	}
};

/** `POST /-/api/repos/<repoId>/ext/<extensionId>/tools/<toolName>`. */
export const handleExtensionTool: RouteHandler = createExtensionToolHandler();
