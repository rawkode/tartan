// The extension tool route over fakes: the shared contract the UI and the
// kernel agree on (`{result}` or `{error: {code, message}}`).

import { deepStrictEqual, equal } from "node:assert/strict";
import { denied, type InstallationInForce } from "@tartan/contract";
import type { AuthContext } from "@tartan/contract/kernel.ts";
import type { RouteContext } from "../../router.ts";
import {
	authOf,
	depsOf,
	DS,
	type Fakes,
	fakes,
	OWNER,
	REPO_ID,
	TIP,
} from "./testing/fakes.ts";
import { createExtensionToolHandler } from "./tools.ts";

const ISSUES = {
	installation: { id: "i_issues", storageScope: "repo", mode: "enforce" },
	manifest: { id: "rawkode.issues" },
	depth: 0,
} as unknown as InstallationInForce;

const CONTENT = "rawkode-academy-content";

const post = async (
	f: Fakes,
	body: unknown,
	options: {
		readonly tool?: string;
		readonly ext?: string;
		readonly auth?: AuthContext | null;
		readonly callTool?: () => Promise<unknown>;
		readonly repoId?: string;
	} = {},
) => {
	const seen: { name: string; args: unknown; ctx: unknown }[] = [];
	const deps = {
		...depsOf(f),
		callTool: (
			_p: unknown,
			_r: unknown,
			name: string,
			args: unknown,
			ctx: unknown,
		) => {
			seen.push({ name, args, ctx });
			return options.callTool?.() ?? Promise.resolve({ issues: [] });
		},
	} as ReturnType<typeof depsOf>;
	const handler = createExtensionToolHandler(() => deps);
	const url = new URL("https://code.example.com/-/api/x");
	const res = await handler({
		req: new Request(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: typeof body === "string" ? body : JSON.stringify(body),
		}),
		url,
		params: {
			repoId: options.repoId ?? REPO_ID,
			extensionId: options.ext ?? "rawkode.issues",
			toolName: options.tool ?? "list",
		},
		auth: options.auth === undefined ? authOf(OWNER) : options.auth,
	} as unknown as RouteContext);
	return {
		status: res.status,
		body: await res.json() as Record<string, unknown>,
		seen,
	};
};

const installed = () => fakes({ installed: [ISSUES] });

Deno.test("repo-wide: the tool runs as the viewer and answers {result}", async () => {
	const out = await post(installed(), { args: { state: "open" } });
	equal(out.status, 200);
	deepStrictEqual(out.body, { result: { issues: [] } });
	equal(out.seen[0].name, "list");
	deepStrictEqual(out.seen[0].args, { state: "open" });
	deepStrictEqual(out.seen[0].ctx, {
		node: REPO_ID,
		repo: REPO_ID,
		scope: "rawkode/academy",
		actor: { kind: "user", id: OWNER },
		mode: "enforce",
	});
});

Deno.test("repo-wide: a caller's own args.project is dropped", async () => {
	const out = await post(installed(), {
		args: { project: "projects/rawkode.academy/content", state: "open" },
	});
	deepStrictEqual(out.seen[0].args, { state: "open" });
});

Deno.test("no installation in force is 404 not_installed", async () => {
	const out = await post(fakes(), { args: {} });
	equal(out.status, 404);
	equal((out.body.error as { code: string }).code, "not_installed");
	deepStrictEqual(out.seen, []);
	const other = await post(installed(), {}, { ext: "rawkode.other" });
	equal((other.body.error as { code: string }).code, "not_installed");
});

Deno.test("project: its root goes to the tool as args.project, whatever the caller said", async () => {
	const out = await post(installed(), {
		project: DS,
		args: { project: "elsewhere", state: "all" },
	});
	equal(out.status, 200);
	deepStrictEqual(out.seen[0].args, {
		project: "packages/design-system",
		state: "all",
	});
});

Deno.test("project: an unknown one is 404; one with the extension off is 403", async () => {
	const unknown = await post(installed(), { project: "nope" });
	equal(unknown.status, 404);
	equal((unknown.body.error as { code: string }).code, "not_found");
	const off = await post(installed(), { project: CONTENT });
	equal(off.status, 403);
	equal((off.body.error as { code: string }).code, "extension_disabled");
	deepStrictEqual(off.seen, []);
});

Deno.test("project: the graph is the one at the trunk tip; without commits it is 404", async () => {
	const f = installed();
	await post(f, { project: DS });
	deepStrictEqual(f.graphCalls, [TIP]);
	const empty = await post(
		fakes({ installed: [ISSUES], trunkSha: null }),
		{ project: DS },
	);
	equal(empty.status, 404);
});

Deno.test("errors keep the shape: the host's refusal, a bad body, no session, a hidden repo", async () => {
	const refused = await post(installed(), {}, {
		callTool: () => Promise.reject(denied("role", "close needs role 30")),
	});
	equal(refused.status, 403);
	deepStrictEqual(refused.body, {
		error: { code: "denied", message: "close needs role 30" },
	});
	for (const body of ["{nope", { args: [] }, { project: "" }, { other: 1 }]) {
		const bad = await post(installed(), body);
		equal(bad.status, 400, JSON.stringify(body));
		equal((bad.body.error as { code: string }).code, "invalid");
	}
	const anonymous = await post(installed(), {}, { auth: null });
	equal(anonymous.status, 401);
	const hidden = await post(installed(), {}, {
		repoId: "01k6zzzzzzzzzzzzzzzzzzzzzz",
	});
	equal(hidden.status, 404);
	equal((hidden.body.error as { code: string }).code, "not_found");
});
