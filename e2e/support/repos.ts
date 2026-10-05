// Run-scoped fixture repositories, created from Node with the owner PAT:
//
//   POST /-/api/nodes/repos {parent: e2e/<pack>, slug: <runId>-<suite>,
//                            import: {mode: "push"}}      (Owner-only import mode)
//   git push <repo>.git main                              (the fixture history)
//   POST /-/api/repos/<id>/import-complete                (protection and lanes on)
//
// `fixtureRepo` is idempotent and shared: two workers that ask for the same
// repo get one, because the second sees 409 and polls (bounded) until the
// first has finished the import. Within a worker the promise is memoised.
// The launcher's teardown archives every `<runId>-*` repo, so nothing here
// deletes.

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { NodeDto, ViewResponse } from "@tartan/contract/api.ts";
import { buildHistory, FIXTURE, type Fixture } from "./fixture-repo.ts";
import { gitEnv, gitOk } from "./git.ts";
import { ApiError, ok, query, tokenApi } from "./http.ts";
import { type Pack, PACK_GROUP, repoPathOf, repoSlug } from "./names.ts";
import { type Stage, tokensOf } from "./stage.ts";

export type FixtureRepo = {
	readonly pack: Pack;
	readonly path: string;
	readonly id: string;
	/** The fixture commits, oldest first. */
	readonly shas: readonly string[];
	/** `https://<forge>/<path>.git`. */
	readonly remote: string;
};

const IMPORT_WAIT_MS = 90_000;

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

const headOf = (fixture: Fixture): string =>
	fixture.shas[fixture.shas.length - 1];

/** A temporary directory for one piece of git work, removed afterwards. */
export const withTempDir = async <T>(
	runId: string,
	work: (dir: string) => Promise<T>,
): Promise<T> => {
	const dir = await mkdtemp(path.join(tmpdir(), `tartan-e2e-${runId}-`));
	try {
		return await work(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
};

const pushFixture = async (
	s: Stage,
	remote: string,
	fixture: Fixture,
): Promise<void> => {
	const token = tokensOf(s).ownerPat;
	await withTempDir(s.runId, async (tmp) => {
		const home = path.join(tmp, "home");
		const work = path.join(tmp, "work");
		await mkdir(home);
		await mkdir(work);
		const shas = await buildHistory(work, home, fixture.commits);
		if (shas.join() !== fixture.shas.join()) {
			throw new Error(
				"the local git built a fixture with other SHAs than the constants",
			);
		}
		await gitOk(["push", "-q", remote, "main:refs/heads/main"], {
			cwd: work,
			env: gitEnv({ home, auth: { origin: s.origin, token } }),
			token,
		});
	});
};

const waitForTrunk = async (
	s: Stage,
	repoPath: string,
	head: string,
): Promise<NodeDto> => {
	const owner = tokenApi(s.origin, tokensOf(s).ownerPat);
	const deadline = Date.now() + IMPORT_WAIT_MS;
	for (;;) {
		const view = await owner.get<ViewResponse>(
			`/-/api/view?${query({ path: repoPath, view: "" })}`,
		);
		const body = view.status === 200 ? view.body : null;
		if (body !== null && body.repo?.trunkSha === head) return body.node;
		if (Date.now() > deadline) {
			throw new Error(
				`${repoPath} has no fixture trunk after ${IMPORT_WAIT_MS / 1000} s`,
			);
		}
		await sleep(2_000);
	}
};

const createFixtureRepo = async (
	s: Stage,
	pack: Pack,
	suite: string,
	fixture: Fixture,
): Promise<FixtureRepo> => {
	const owner = tokenApi(s.origin, tokensOf(s).ownerPat);
	const repoPath = repoPathOf(pack, s.runId, suite);
	const remote = `${s.origin}/${repoPath}.git`;
	const head = headOf(fixture);
	const created = await owner.send<NodeDto>("POST", "/-/api/nodes/repos", {
		parent: PACK_GROUP[pack],
		slug: repoSlug(s.runId, suite),
		visibility: "private",
		description: `e2e fixture for ${suite}`,
		import: { mode: "push" },
	});
	let node: NodeDto;
	if (created.status === 409) {
		node = await waitForTrunk(s, repoPath, head);
	} else {
		node = ok("POST", "/-/api/nodes/repos", created);
		await pushFixture(s, remote, fixture);
		const done = ok(
			"POST",
			"/-/api/repos/<id>/import-complete",
			await owner.send<{ trunkSha?: string }>(
				"POST",
				`/-/api/repos/${encodeURIComponent(node.id)}/import-complete`,
				{},
			),
		);
		if (done.trunkSha !== head) {
			throw new ApiError("POST", "/-/api/repos/<id>/import-complete", 200, {
				code: "unexpected",
				reason: "trunk",
				message: "the imported trunk is not the fixture head",
			});
		}
	}
	return { pack, path: repoPath, id: node.id, shas: fixture.shas, remote };
};

const memo = new Map<string, Promise<FixtureRepo>>();

/**
 * The run's repo `<group>/<runId>-<suite>` with `fixture`'s history (the
 * basic one by default), created on first use.
 */
export const fixtureRepo = (
	s: Stage,
	pack: Pack,
	suite: string,
	fixture: Fixture = FIXTURE,
): Promise<FixtureRepo> => {
	const key = `${pack}/${suite}`;
	let repo = memo.get(key);
	if (repo === undefined) {
		repo = createFixtureRepo(s, pack, suite, fixture);
		memo.set(key, repo);
		repo.catch(() => memo.delete(key));
	}
	return repo;
};

/** A repo created empty in import mode, for a suite that pushes history itself. */
export const importModeRepo = async (
	s: Stage,
	pack: Pack,
	suite: string,
): Promise<Omit<FixtureRepo, "shas">> => {
	const owner = tokenApi(s.origin, tokensOf(s).ownerPat);
	const repoPath = repoPathOf(pack, s.runId, suite);
	const node = ok(
		"POST",
		"/-/api/nodes/repos",
		await owner.send<NodeDto>("POST", "/-/api/nodes/repos", {
			parent: PACK_GROUP[pack],
			slug: repoSlug(s.runId, suite),
			visibility: "private",
			import: { mode: "push" },
		}),
	);
	return {
		pack,
		path: repoPath,
		id: node.id,
		remote: `${s.origin}/${repoPath}.git`,
	};
};

/** Archives a node the run made outside the `<runId>-*` repo pattern (best effort). */
export const archiveNode = async (
	s: Stage,
	nodePath: string,
): Promise<void> => {
	const owner = tokenApi(s.origin, tokensOf(s).ownerPat);
	await owner.send("POST", "/-/api/nodes/archive", { node: nodePath });
};
