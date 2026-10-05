// `POST /-/api/installations/replace`: the queue@1 swap an Owner makes on a
// live subtree, its sheet (dry run) for a Maintainer, and the listing that
// follows the swap.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import type {
	InstallationsResponse,
	ReplaceProviderResponse,
} from "@tartan/contract";
import type { AuthContext } from "@tartan/contract/kernel.ts";
import { bundled, manifest } from "../registry/test/fakes.ts";
import { handleInstallationsRequest } from "./installations.ts";
import { apiFixture, OWNER, session } from "./test/fixture.ts";

const MAINT = "u_maint";

const QUEUES = [
	bundled(manifest("tartan.weave", {
		provides: ["queue@1"],
		permissions: { land: ["refs/heads/*"] },
		subscribe: [{ event: "review.decided" }],
	})),
	bundled(manifest("tartan.fifo", {
		provides: ["queue@1"],
		permissions: { land: ["refs/heads/*"] },
		subscribe: [{ event: "review.decided" }],
	})),
];

const setup = async () => {
	const a = apiFixture(QUEUES);
	a.fx.tree.grant("acme/platform", MAINT, 40);
	await a.registry.facade.install(OWNER, {
		extId: "tartan.weave",
		version: "0.1.0",
		node: "acme/platform",
		mode: "enforce",
	});
	return a;
};

const call = (
	a: Awaited<ReturnType<typeof setup>>,
	method: string,
	rest: string | undefined,
	auth: AuthContext | null,
	body?: unknown,
	query = "",
) =>
	handleInstallationsRequest(
		a.deps,
		new Request(
			`https://forge.test/-/api/installations${rest ? `/${rest}` : ""}${query}`,
			{
				method,
				...(body === undefined ? {} : {
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				}),
			},
		),
		rest,
		auth,
	);

const swap = (extId: string, extra = {}) => ({
	node: "acme/platform/router",
	iface: "queue@1",
	extId,
	version: "0.1.0",
	...extra,
});

Deno.test("replace: a Maintainer gets the sheet; only an Owner swaps queue@1", async () => {
	const a = await setup();
	const sheet = await call(
		a,
		"POST",
		"replace",
		session(MAINT),
		swap("tartan.fifo", { dryRun: true }),
	);
	equal(sheet.status, 200);
	const plan = (await sheet.json()) as ReplaceProviderResponse;
	equal(plan.dryRun, true);
	equal(plan.needsOwner, true);
	equal(plan.from?.extId, "tartan.weave");
	deepStrictEqual(plan.steps.map((s) => s.kind), ["install"]);
	const refused = await call(
		a,
		"POST",
		"replace",
		session(MAINT),
		swap("tartan.fifo"),
	);
	equal(refused.status, 403);
	const done = await call(
		a,
		"POST",
		"replace",
		session(OWNER),
		swap("tartan.fifo"),
	);
	equal(done.status, 200);
	const out = (await done.json()) as ReplaceProviderResponse;
	equal(out.provider?.extId, "tartan.fifo");
	equal(out.provider?.nodePath, "acme/platform/router");
	// The listing shows what acts at the repo: FIFO, not the replaced Weave.
	const listed = await call(
		a,
		"GET",
		undefined,
		session(MAINT),
		undefined,
		"?node=acme/platform/router",
	);
	const body = (await listed.json()) as InstallationsResponse;
	const ids = body.installations.map((i) => i.installation.extId);
	ok(ids.includes("tartan.fifo"));
	ok(!ids.includes("tartan.weave"));
	// And back, in one call.
	const back = await call(
		a,
		"POST",
		"replace",
		session(OWNER),
		swap("tartan.weave"),
	);
	equal(back.status, 200);
	deepStrictEqual(
		((await back.json()) as ReplaceProviderResponse).steps.map((s) => s.kind),
		["disable", "inherit"],
	);
});

Deno.test("replace: bad bodies, unknown nodes and tokens without the admin scope are refused", async () => {
	const a = await setup();
	const bad = await call(a, "POST", "replace", session(OWNER), {
		node: "acme/platform/router",
		iface: "queue@9",
		extId: "tartan.fifo",
		version: "0.1.0",
	});
	equal(bad.status, 400);
	const missing = await call(
		a,
		"POST",
		"replace",
		session(OWNER),
		swap("tartan.fifo", { node: "acme/nowhere" }),
	);
	equal(missing.status, 404);
	const pat = await call(
		a,
		"POST",
		"replace",
		session(OWNER, { via: "pat", scopes: ["api"] }),
		swap("tartan.fifo"),
	);
	equal(pat.status, 403);
	const notProvider = await call(
		a,
		"POST",
		"replace",
		session(OWNER),
		swap("tartan.board"),
	);
	equal(notProvider.status, 400);
});
