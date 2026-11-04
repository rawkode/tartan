// An Owner's direct push to the default branch, end to end with stock git and a
// real `git http-backend` (`testing/world.ts`): fast-forwards land and record
// trunk history, a forced rewrite is refused by the server, everyone else keeps
// `woven-by-tartan`, the quarantine ref never stays, nothing trips `ref.tampered`,
// and a trunk push (only a trunk push) is discovered, best effort.

import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { DIRECT_PUSH_PREFIX, ROLE } from "@tartan/contract";
import { bareRefs, commitFile, git, revParse } from "./testing/git.ts";
import {
	agentWithLane,
	forwardedPushes,
	gitTest as test,
	withWorld,
	type World,
} from "./testing/world.ts";

const trunkRows = (w: World) =>
	w.h.storage.sql.exec<{ sha: string; seq: number; source: string }>(
		"SELECT sha, seq, source FROM trunk_commits ORDER BY seq",
	).toArray();

const owner = (w: World) => {
	const user = w.principal("user", { role: ROLE.owner });
	w.forgeOwners.add(user.id);
	return user;
};

const noQuarantine = async (w: World) =>
	ok(
		!Object.keys(await bareRefs(w.sandbox, w.bare)).some((ref) =>
			ref.startsWith(DIRECT_PUSH_PREFIX)
		),
		"the quarantine ref is gone",
	);

test("the Owner's fast-forward lands, records trunk history, and stock git prints it as normal", async () => {
	await withWorld(async (w) => {
		const user = owner(w);
		const dir = await w.clone(user, "c1");
		await commitFile(w.sandbox, dir, "a.txt", "a\n");
		const first = await revParse(w.sandbox, dir, "HEAD");
		await commitFile(w.sandbox, dir, "b.txt", "b\n");
		const head = await revParse(w.sandbox, dir, "HEAD");
		const out = await w.gitAs(user, ["push", "origin", "HEAD:main"], {
			cwd: dir,
		});
		equal(out.code, 0);
		match(out.stderr, /HEAD -> main/);
		ok(!out.stderr.includes("direct"), "the client never sees the quarantine");
		await w.settle();
		equal((await bareRefs(w.sandbox, w.bare))["refs/heads/main"], head);
		await noQuarantine(w);
		const pushed = trunkRows(w).filter((row) => row.source === "push");
		deepStrictEqual(pushed.map((row) => row.sha), [first, head]);
		ok(pushed[0].seq < pushed[1].seq);
		// The index and meta follow, attributed; phase 2 used the range it had.
		const row = w.h.storage.sql.exec<
			{ principal_id: string; via: string; diff_state: string }
		>(
			"SELECT principal_id, via, diff_state FROM pushes WHERE ref = 'refs/heads/main' AND after = ?",
			head,
		).toArray()[0];
		deepStrictEqual(row, {
			principal_id: user.id,
			via: "gateway",
			diff_state: "done",
		});
		equal(w.h.internal.metaSync("trunk_sha"), head);
		equal(w.h.events.ofType("push.accepted").length, 1);
		equal(w.h.events.ofType("push.diffed").length, 1);
		deepStrictEqual(w.probeCalls.map((c) => c.after), [head]);
	});
});

test("a second fast-forward continues the history", async () => {
	await withWorld(async (w) => {
		const user = owner(w);
		const dir = await w.clone(user, "c1");
		await commitFile(w.sandbox, dir, "a.txt", "a\n");
		await w.gitAs(user, ["push", "-q", "origin", "HEAD:main"], { cwd: dir });
		const one = await revParse(w.sandbox, dir, "HEAD");
		await commitFile(w.sandbox, dir, "b.txt", "b\n");
		await w.gitAs(user, ["push", "-q", "origin", "HEAD:main"], { cwd: dir });
		const two = await revParse(w.sandbox, dir, "HEAD");
		await w.settle();
		deepStrictEqual(
			trunkRows(w).filter((r) => r.source === "push").map((r) => r.sha),
			[one, two],
		);
	});
});

test("a forced rewrite of main is refused by the server, and nothing moves", async () => {
	await withWorld(async (w) => {
		const user = owner(w);
		const dir = await w.clone(user, "c1");
		await commitFile(w.sandbox, dir, "a.txt", "a\n");
		await w.gitAs(user, ["push", "-q", "origin", "HEAD:main"], { cwd: dir });
		const tip = await revParse(w.sandbox, dir, "HEAD");
		await w.settle();
		const before = trunkRows(w);
		// Amend: the same parent, another commit, past stock git's own check.
		await git(w.sandbox, ["commit", "-q", "--amend", "-m", "rewritten"], {
			cwd: dir,
			env: { GIT_COMMITTER_DATE: "2030-01-01T00:00:00Z" },
		});
		const rewritten = await revParse(w.sandbox, dir, "HEAD");
		const out = await w.gitAs(
			user,
			["push", "--force", "origin", "HEAD:main"],
			{ cwd: dir, allowFail: true },
		);
		ok(out.code !== 0);
		match(out.stderr, /\[remote rejected\] HEAD -> main \(non-fast-forward\)/);
		await w.settle();
		equal((await bareRefs(w.sandbox, w.bare))["refs/heads/main"], tip);
		await noQuarantine(w);
		deepStrictEqual(trunkRows(w), before);
		equal(w.h.internal.metaSync("trunk_sha"), tip);
		ok(
			!w.h.storage.sql.exec<{ after: string }>(
				"SELECT after FROM pushes",
			).toArray().some((row) => row.after === rewritten),
		);
		deepStrictEqual(
			w.h.events.ofType("push.rejected").map((e) =>
				(e.data as { reason: string }).reason
			),
			["non-fast-forward"],
		);
		// Back to an ancestor is a rewrite too (no new objects at all).
		const back = await w.gitAs(
			user,
			["push", "--force", "origin", "HEAD~1:main"],
			{ cwd: dir, allowFail: true },
		);
		match(back.stderr, /\(non-fast-forward\)/);
		equal((await bareRefs(w.sandbox, w.bare))["refs/heads/main"], tip);
	});
});

test("a push the kernel cannot check does not land", async () => {
	await withWorld(async (w) => {
		const user = owner(w);
		const dir = await w.clone(user, "c1");
		await commitFile(w.sandbox, dir, "a.txt", "a\n");
		w.probeDown = true;
		const out = await w.gitAs(user, ["push", "origin", "HEAD:main"], {
			cwd: dir,
			allowFail: true,
		});
		ok(out.code !== 0);
		match(out.stderr, /could not check the push/);
		equal((await bareRefs(w.sandbox, w.bare))["refs/heads/main"], w.trunk);
		await noQuarantine(w);
	});
});

test("the Owner role alone does not push main: a grant to a third party is not the forge Owner", async () => {
	await withWorld(async (w) => {
		const contributor = w.principal("user", { role: ROLE.owner });
		const dir = await w.clone(contributor, "c1");
		await commitFile(w.sandbox, dir, "a.txt", "a\n");
		const out = await w.gitAs(contributor, ["push", "origin", "HEAD:main"], {
			cwd: dir,
			allowFail: true,
		});
		ok(out.code !== 0);
		match(out.stderr, /\(woven-by-tartan\)/);
		equal(forwardedPushes(w).length, 0);
		equal((await bareRefs(w.sandbox, w.bare))["refs/heads/main"], w.trunk);
	});
});

test("deleting main is refused before anything is sent", async () => {
	await withWorld(async (w) => {
		const user = owner(w);
		const dir = await w.clone(user, "c1");
		const out = await w.gitAs(user, ["push", "origin", ":main"], {
			cwd: dir,
			allowFail: true,
		});
		match(out.stderr, /\(non-fast-forward\)/);
		equal(forwardedPushes(w).length, 0);
		equal((await bareRefs(w.sandbox, w.bare))["refs/heads/main"], w.trunk);
	});
});

test("a branch and main in one push both land, and report per ref", async () => {
	await withWorld(async (w) => {
		const user = owner(w);
		const dir = await w.clone(user, "c1");
		await commitFile(w.sandbox, dir, "a.txt", "a\n");
		const head = await revParse(w.sandbox, dir, "HEAD");
		await w.gitAs(user, [
			"push",
			"origin",
			"HEAD:main",
			"HEAD:refs/heads/side",
		], { cwd: dir });
		await w.settle();
		const refs = await bareRefs(w.sandbox, w.bare);
		equal(refs["refs/heads/main"], head);
		equal(refs["refs/heads/side"], head);
		await noQuarantine(w);
		deepStrictEqual(
			trunkRows(w).filter((r) => r.source === "push").map((r) => r.sha),
			[head],
		);
	});
});

test("merge commits record every new commit, parents first", async () => {
	await withWorld(async (w) => {
		const user = owner(w);
		const dir = await w.clone(user, "c1");
		await git(w.sandbox, ["switch", "-q", "-c", "side"], { cwd: dir });
		await commitFile(w.sandbox, dir, "side.txt", "s\n");
		const side = await revParse(w.sandbox, dir, "HEAD");
		await git(w.sandbox, ["switch", "-q", "main"], { cwd: dir });
		await commitFile(w.sandbox, dir, "main.txt", "m\n");
		const mainline = await revParse(w.sandbox, dir, "HEAD");
		await git(w.sandbox, ["merge", "-q", "--no-edit", "side"], { cwd: dir });
		const merge = await revParse(w.sandbox, dir, "HEAD");
		await w.gitAs(user, ["push", "-q", "origin", "HEAD:main"], { cwd: dir });
		await w.settle();
		const pushed = trunkRows(w).filter((r) => r.source === "push");
		equal(pushed.at(-1)?.sha, merge);
		deepStrictEqual(
			pushed.map((r) => r.sha).sort(),
			[side, mainline, merge].sort(),
		);
	});
});

test("everyone else keeps woven-by-tartan: non-owners, agents, a lanes-only Owner token", async () => {
	await withWorld(async (w) => {
		const owning = owner(w);
		const dir = await w.clone(owning, "c1");
		await commitFile(w.sandbox, dir, "x.txt", "x\n");
		const refused = async (who: Parameters<World["gitAs"]>[0], cwd: string) => {
			const out = await w.gitAs(who, ["push", "origin", "HEAD:main"], {
				cwd,
				allowFail: true,
			});
			ok(out.code !== 0);
			match(out.stderr, /\[remote rejected\] HEAD -> main \(woven-by-tartan\)/);
		};
		await refused(w.principal("user", { role: ROLE.developer }), dir);
		await refused(w.principal("user", { role: ROLE.maintainer }), dir);
		await refused(
			w.principal("user", { role: ROLE.owner, scopes: ["repo:read", "lanes"] }),
			dir,
		);
		await refused(
			w.principal("user", { role: ROLE.owner, maxRole: ROLE.developer }),
			dir,
		);
		const { agent, dir: agentDir } = await agentWithLane(w, "a");
		await commitFile(w.sandbox, agentDir, "y.txt", "y\n");
		await refused(agent, agentDir);
		equal(forwardedPushes(w).length, 0);
		equal((await bareRefs(w.sandbox, w.bare))["refs/heads/main"], w.trunk);
	});
});

test("an Owner agent's token is refused too", async () => {
	await withWorld(async (w) => {
		const user = owner(w);
		const dir = await w.clone(user, "c1");
		await commitFile(w.sandbox, dir, "x.txt", "x\n");
		const agent = w.principal("agent", { role: ROLE.owner });
		const laneId = await w.openLane(agent);
		ok(laneId.length > 0);
		const out = await w.gitAs(agent, ["push", "origin", "HEAD:main"], {
			cwd: dir,
			allowFail: true,
		});
		match(out.stderr, /\(woven-by-tartan\)/);
	});
});

test("a direct push does not trip ref.tampered: reconciliation agrees, and the quarantine is ignored", async () => {
	await withWorld(async (w) => {
		const user = owner(w);
		const dir = await w.clone(user, "c1");
		await commitFile(w.sandbox, dir, "a.txt", "a\n");
		const head = await revParse(w.sandbox, dir, "HEAD");
		await w.gitAs(user, ["push", "-q", "origin", "HEAD:main"], { cwd: dir });
		await w.settle();
		// What a trigger reports for the same transition, and for the quarantine.
		await w.h.facade.observePush({
			eventId: "ev-main",
			repoName: w.h.canonical,
			ref: "refs/heads/main",
			before: w.trunk,
			after: head,
			at: 1,
		});
		await w.h.facade.observePush({
			eventId: "ev-q",
			repoName: w.h.canonical,
			ref: `${DIRECT_PUSH_PREFIX}abc`,
			before: "0".repeat(40),
			after: head,
			at: 1,
		});
		equal(
			w.h.storage.sql.exec<{ n: number }>(
				"SELECT COUNT(*) AS n FROM pending_observations",
			).toArray()[0].n,
			0,
		);
		w.h.clock.advance(10 * 60 * 1000);
		await w.h.runTimers();
		equal(w.h.events.ofType("ref.tampered").length, 0);
		equal(w.h.internal.metaSync("landing_paused"), "0");
		equal(w.h.internal.metaSync("drifted"), "0");
	});
});

test("a trunk push is discovered; a branch push is not; a failed discovery leaves the push alone", async () => {
	await withWorld(async (w) => {
		const asked: string[] = [];
		w.discover = (_repoId, sha) => {
			asked.push(sha);
			return Promise.resolve();
		};
		const user = owner(w);
		const dir = await w.clone(user, "c1");
		await commitFile(w.sandbox, dir, "a.txt", "a\n");
		const branch = await revParse(w.sandbox, dir, "HEAD");
		await w.gitAs(user, ["push", "-q", "origin", "HEAD:refs/heads/feat"], {
			cwd: dir,
		});
		await w.settle();
		deepStrictEqual(asked, [], "a branch push does not change the graph");
		await w.gitAs(user, ["push", "-q", "origin", "HEAD:main"], { cwd: dir });
		await w.settle();
		deepStrictEqual(asked, [branch]);
		w.discover = () => Promise.reject(new Error("the probe is down"));
		await commitFile(w.sandbox, dir, "b.txt", "b\n");
		const next = await revParse(w.sandbox, dir, "HEAD");
		const out = await w.gitAs(user, ["push", "origin", "HEAD:main"], {
			cwd: dir,
		});
		equal(out.code, 0);
		await w.settle();
		equal((await bareRefs(w.sandbox, w.bare))["refs/heads/main"], next);
		ok(w.logs.some((l) => l.message.includes("project discovery failed")));
	});
});
