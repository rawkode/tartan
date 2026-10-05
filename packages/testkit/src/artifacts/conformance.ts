// The FakeArtifacts conformance suite: the same calls run against
// FakeArtifacts locally and against a deployed binding (from the smoke
// Worker, `scripts/smoke/worker-git`): names, tokens, reads, headers, token
// scope and an import. It fails when a read resolves a full refname or
// `HEAD`, or when a token minted for one repo can write another.
//
// Every repo it creates starts with `prefix` and is deleted at the end.

import { isRepoStoreError } from "@tartan/contract/kernel.ts";
import { advertisement, type FetchLike, push } from "../git/client.ts";
import { encodeCommit, type GitObject } from "../git/objects.ts";
import {
	createObjectStore,
	reachableObjects,
	writeTree,
} from "../git/store.ts";

export type ConformanceTarget = {
	/** The namespace binding (`env.ARTIFACTS` live, FakeArtifacts locally). */
	readonly artifacts: Artifacts;
	/** Reaches the repos' `remote` URLs (global `fetch` live, `fake.fetch` locally). */
	readonly fetch: FetchLike;
	/** Repo name prefix (live: `tartan-smoke-…`). */
	readonly prefix: string;
	/**
	 * Optional import check: a public smart-HTTP URL (e.g. the dev capability
	 * route) whose `branch` tip is `head`.
	 */
	readonly importSource?: {
		readonly url: string;
		readonly branch: string;
		readonly head: string;
	};
};

export type ConformanceResult = {
	readonly id: string;
	readonly title: string;
	readonly pass: boolean;
	readonly detail: string;
};

const SIG = {
	name: "Tartan Conformance",
	email: "conformance@example.invalid",
};

type Check = (ctx: Ctx) => Promise<string>;
type Ctx = {
	readonly t: ConformanceTarget;
	readonly name: (suffix: string) => string;
	readonly created: Set<string>;
};

class CheckFailed extends Error {}
const expect = (cond: boolean, message: string): void => {
	if (!cond) throw new CheckFailed(message);
};

const errorCode = (e: unknown): string =>
	isRepoStoreError(e)
		? `${(e as ArtifactsError).code}/${(e as ArtifactsError).numericCode}`
		: String(e);

const create = async (ctx: Ctx, suffix: string) => {
	const name = ctx.name(suffix);
	const result = await ctx.t.artifacts.create(name);
	ctx.created.add(name);
	return result;
};

/** Pushes one commit (with a `change-id` header) holding `files` to `main`. */
const pushFiles = async (
	ctx: Ctx,
	remote: string,
	token: string,
	files: Record<string, string>,
): Promise<
	{ commit: string; tree: string; report: Awaited<ReturnType<typeof push>> }
> => {
	const store = createObjectStore();
	const tree = writeTree(store, files);
	const sig = { ...SIG, at: 1_790_000_000 };
	const commit = store.put(
		encodeCommit({
			tree,
			parents: [],
			author: sig,
			committer: sig,
			extraHeaders: [[
				"change-id",
				"I0481624e2229c1f6db170741f2b832413828cbc1",
			]],
			message:
				"conformance\n\nChange-Id: I0481624e2229c1f6db170741f2b832413828cbc1\n",
		}),
	);
	const objects = reachableObjects(store, [commit]).oids.map((o) =>
		store.get(o)!
	) as GitObject[];
	const report = await push(
		ctx.t.fetch,
		remote,
		[{ ref: "refs/heads/main", new: commit }],
		objects,
		{ auth: { bearer: token } },
	);
	return { commit, tree, report };
};

const CHECKS: readonly { id: string; title: string; run: Check }[] = [
	{
		id: "C1",
		title: "names fold case; ALREADY_EXISTS 10201; NOT_FOUND 10200",
		run: async (ctx) => {
			const lower = ctx.name("case-x");
			await ctx.t.artifacts.create(lower);
			ctx.created.add(lower);
			const upper = lower.toUpperCase();
			let dup = "created";
			try {
				await ctx.t.artifacts.create(upper);
				ctx.created.add(upper);
			} catch (e) {
				dup = errorCode(e);
			}
			expect(dup === "ALREADY_EXISTS/10201", `create(upper) → ${dup}`);
			const info = await (await ctx.t.artifacts.get(upper)).info();
			expect(info.name === lower, `get(upper).name = ${info.name}`);
			let missing = "found";
			try {
				await ctx.t.artifacts.get(ctx.name("never-existed"));
			} catch (e) {
				missing = errorCode(e);
			}
			expect(missing === "NOT_FOUND/10200", `get(missing) → ${missing}`);
			const deletedMissing = await ctx.t.artifacts.delete(
				ctx.name("never-existed"),
			);
			expect(deletedMissing === false, `delete(missing) → ${deletedMissing}`);
			return `dup=${dup} missing=${missing}`;
		},
	},
	{
		id: "C2",
		title: "token shape art_v2_x_…?expires=; TTL < 60 is INVALID_TTL 10103",
		run: async (ctx) => {
			const r = await create(ctx, "tok");
			expect(
				/^art_v2_x_[0-9a-f]{40}\?expires=\d{10}$/.test(r.token),
				`create() token shape (length ${r.token.length})`,
			);
			const repo = await ctx.t.artifacts.get(r.name);
			let short = "minted";
			try {
				await repo.createToken("read", 30);
			} catch (e) {
				short = errorCode(e);
			}
			expect(short === "INVALID_TTL/10103", `createToken(read, 30) → ${short}`);
			const t = await repo.createToken("read", 60);
			expect(await repo.revokeToken(t.id), "revokeToken(id) → true");
			const listed = (await repo.listTokens()).tokens.find((x) =>
				x.id === t.id
			);
			// A revoked token is not listed.
			expect(
				listed === undefined,
				`revoked token still listed (${listed?.state})`,
			);
			return `length=${r.token.length}`;
		},
	},
	{
		id: "C3",
		title: "reads resolve short branch names and SHAs only (K15)",
		run: async (ctx) => {
			const r = await create(ctx, "reads");
			const { commit, tree, report } = await pushFiles(ctx, r.remote, r.token, {
				"README.md": "# conformance\n",
				"src/hello.txt": "hello\n",
			});
			expect(
				report.refs.get("refs/heads/main") === "ok",
				`push: ${[...report.refs]}`,
			);
			const repo = await ctx.t.artifacts.get(r.name);
			const byBranch = await repo.log({ ref: "main", limit: 1 });
			expect(byBranch[0]?.hash === commit, "log(main) resolves");
			const bySha = await repo.readFile({ ref: commit, path: "src/hello.txt" });
			expect((await bySha?.text()) === "hello\n", "readFile(<sha>) resolves");
			const spelled: string[] = [];
			for (const ref of ["refs/heads/main", "heads/main", "HEAD"]) {
				const log = await repo.log({ ref, limit: 1 });
				const file = await repo.readFile({ ref, path: "README.md" });
				if (log.length > 0 || file !== null) spelled.push(ref);
			}
			expect(
				spelled.length === 0,
				`full refnames resolved: ${spelled.join(", ")}`,
			);
			const t = await repo.readTree(tree);
			expect(
				t?.some((e) => e.name === "src" && e.type === "tree") === true,
				"readTree(tree)",
			);
			return `commit=${commit.slice(0, 7)}`;
		},
	},
	{
		id: "C4",
		title: "readCommit drops headers; readBlob(commit) is null",
		run: async (ctx) => {
			const r = await create(ctx, "hdr");
			const { commit } = await pushFiles(ctx, r.remote, r.token, {
				"a.txt": "a\n",
			});
			const repo = await ctx.t.artifacts.get(r.name);
			const meta = await repo.readCommit(commit);
			expect(
				meta !== null && !JSON.stringify(meta).includes("change-id I"),
				"no header in readCommit",
			);
			expect(
				meta?.message.endsWith(
					"Change-Id: I0481624e2229c1f6db170741f2b832413828cbc1",
				) === true,
				"trailer kept",
			);
			expect(
				(await repo.readBlob(commit)) === null,
				"readBlob(commit sha) is null",
			);
			return "ok";
		},
	},
	{
		id: "C5",
		title: "a token minted for one repo cannot write another",
		run: async (ctx) => {
			const a = await create(ctx, "scope-a");
			const b = await create(ctx, "scope-b");
			const { report } = await pushFiles(ctx, a.remote, b.token, {
				"x.txt": "x\n",
			});
			expect(
				report.status === 401 || report.status === 403,
				`cross-repo push status ${report.status}`,
			);
			const repoA = await ctx.t.artifacts.get(a.name);
			expect(
				(await repoA.log({ ref: "main" })).length === 0,
				"repo A unchanged",
			);
			const adv = await advertisement(ctx.t.fetch, a.remote, {
				auth: { bearer: b.token },
			});
			expect(
				adv.status === 401 || adv.status === 403,
				`cross-repo read status ${adv.status}`,
			);
			return `push=${report.status} read=${adv.status}`;
		},
	},
	{
		id: "C6",
		title: "import() keeps the source branch name",
		run: async (ctx) => {
			const src = ctx.t.importSource;
			if (!src) return "skipped (no import source)";
			const name = ctx.name("imp");
			ctx.created.add(name);
			const result = await ctx.t.artifacts.import({
				source: { url: src.url, branch: src.branch },
				target: { name },
			});
			expect(
				result.defaultBranch === src.branch,
				`defaultBranch ${result.defaultBranch}`,
			);
			const repo = await ctx.t.artifacts.get(name);
			const log = await repo.log({ ref: src.branch, limit: 1 });
			expect(log[0]?.hash === src.head, "imported head");
			return `branch=${result.defaultBranch}`;
		},
	},
];

export const CONFORMANCE_IDS = CHECKS.map((c) => c.id);

/** Runs every check; never throws. Deletes the repos it created. */
export const runConformance = async (
	t: ConformanceTarget,
	only?: readonly string[],
): Promise<ConformanceResult[]> => {
	let n = 0;
	const ctx: Ctx = {
		t,
		name: (suffix) => `${t.prefix}-${suffix}-${(++n).toString(36)}`,
		created: new Set(),
	};
	const results: ConformanceResult[] = [];
	for (const check of CHECKS) {
		if (only && !only.includes(check.id)) continue;
		try {
			const detail = await check.run(ctx);
			results.push({ id: check.id, title: check.title, pass: true, detail });
		} catch (e) {
			results.push({
				id: check.id,
				title: check.title,
				pass: false,
				detail: e instanceof CheckFailed ? e.message : `error: ${errorCode(e)}`,
			});
		}
	}
	for (const name of ctx.created) {
		await t.artifacts.delete(name).catch(() => false);
	}
	return results;
};
