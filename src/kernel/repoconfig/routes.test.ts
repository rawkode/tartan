// The repository-config routes' facades: an
// anonymous request wakes no Durable Object, and every stub a signed-in
// request opens is disposed when its call settles.

import { equal } from "node:assert/strict";
import { createUlid } from "@tartan/contract";
import type { AuthContext } from "@tartan/contract/kernel.ts";
import type { RouteContext } from "../../router.ts";
import {
	handleConfigApprovals,
	handleRepoConfig,
	handleRepoOverrides,
} from "./routes.ts";

const ulid = createUlid();
const REPO = ulid();
const OWNER = `u_${ulid()}`;

/** A fake Worker env that counts stubs opened and disposed. */
const fakeEnv = () => {
	const counts = { opened: 0, disposed: 0, forge: 0, repo: 0 };
	const stub = <T extends object>(target: T): T & Disposable => {
		counts.opened += 1;
		return Object.assign(target, {
			[Symbol.dispose]: () => void (counts.disposed += 1),
		});
	};
	const node = {
		id: REPO,
		parentId: null,
		kind: "repo",
		slug: "api",
		path: "acme/api",
		depth: 1,
		visibility: "private",
		archived: false,
		createdAt: 0,
	};
	const env = {
		FORGE: {
			getByName: () => {
				counts.forge += 1;
				return {
					tree: () =>
						stub({
							node: () => Promise.resolve(node),
							effectiveRole: () => Promise.resolve(50),
						}),
					registry: () =>
						stub({
							repoConfigEffective: () =>
								Promise.resolve({ effective: [], approvals: [], epoch: 1 }),
						}),
				};
			},
		},
		REPO: {
			getByName: () => {
				counts.repo += 1;
				return {
					repoconfig: () =>
						stub({
							state: () => Promise.resolve({ repoId: REPO, status: "current" }),
						}),
				};
			},
		},
	};
	return { env, counts };
};

const call = (
	handler: typeof handleRepoConfig,
	env: unknown,
	auth: AuthContext | null,
	params: Record<string, string>,
	method = "GET",
) =>
	handler({
		env,
		req: new Request("https://forge.test/x", { method }),
		params,
		auth,
	} as unknown as RouteContext);

const session: AuthContext = {
	principal: OWNER,
	kind: "user",
	via: "session",
	scopes: [],
	nodeId: null,
	laneId: null,
	maxRole: 50,
	isAdmin: false,
};

Deno.test("an anonymous request to the repo-config routes gets 401 and opens no Durable Object stub", async () => {
	const { env, counts } = fakeEnv();
	equal(
		(await call(handleRepoConfig, env, null, { repoId: REPO })).status,
		401,
	);
	equal(
		(await call(handleConfigApprovals, env, null, { node: REPO })).status,
		401,
	);
	equal(
		(await call(
			handleRepoOverrides,
			env,
			null,
			{ installation: `i_${ulid()}` },
			"PUT",
		)).status,
		401,
	);
	equal(counts.forge, 0, "ForgeDO was never asked for");
	equal(counts.repo, 0, "RepoDO was never asked for");
	equal(counts.opened, 0);
});

Deno.test("every facade stub a signed-in request opens is disposed", async () => {
	const { env, counts } = fakeEnv();
	const res = await call(handleRepoConfig, env, session, { repoId: REPO });
	equal(res.status, 200);
	equal(counts.opened > 0, true);
	equal(counts.disposed, counts.opened, "no stub left open");
});
