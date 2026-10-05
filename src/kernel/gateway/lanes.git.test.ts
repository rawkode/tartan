// Agents and their `branch` lanes through the gateway with stock git (the
// canonical write precheck, the landing freeze, `stale-old`, lane pins,
// read-scoped tokens). Two real agent tokens and one user token on a
// `branch`-backend repo.

import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { isHiddenRef, ROLE } from "@tartan/contract";
import { bareRefs, commitFile, revParse } from "./testing/git.ts";
import {
	agentWithLane,
	forwardedPushes,
	gitTest as test,
	laneRef,
	lsRemote,
	withWorld,
} from "./testing/world.ts";

test("an agent creates, updates and force-pushes its own lane; RepoDO records each push on the lane", async () => {
	await withWorld(async (w) => {
		const { agent, laneId, dir } = await agentWithLane(w, "a");
		const h1 = await commitFile(w.sandbox, dir, "a.txt", "one\n");
		await w.gitAs(agent, [
			"push",
			"-q",
			"-u",
			"origin",
			`HEAD:${laneRef(laneId)}`,
		], { cwd: dir });
		await w.settle();
		equal((await w.h.facade.getLane(laneId))?.head, h1);
		const h2 = await commitFile(w.sandbox, dir, "a.txt", "two\n");
		await w.gitAs(agent, ["push", "-q", "origin", `HEAD:${laneRef(laneId)}`], {
			cwd: dir,
		});
		await w.settle();
		equal((await w.h.facade.getLane(laneId))?.head, h2);
		// A rebase: amend and push with --force-with-lease (the receive-pack
		// advertisement shows the agent its own lane head).
		await w.gitAs(agent, ["commit", "-q", "--amend", "-m", "amended"], {
			cwd: dir,
		});
		const h3 = await revParse(w.sandbox, dir, "HEAD");
		await w.gitAs(agent, [
			"push",
			"-q",
			"--force-with-lease",
			"origin",
			`HEAD:${laneRef(laneId)}`,
		], { cwd: dir });
		await w.settle();
		equal((await w.h.facade.getLane(laneId))?.head, h3);
		equal((await bareRefs(w.sandbox, w.bare))[laneRef(laneId)], h3);
		deepStrictEqual(
			w.h.events.ofType("push.accepted").map((e) =>
				(e.data as { target: string }).target
			),
			[laneId, laneId, laneId],
		);
		// Phase 2 ran for every lane push, on the lane.
		deepStrictEqual(w.probeCalls.map((c) => c.source.laneId), [
			laneId,
			laneId,
			laneId,
		]);
	});
});

test("the agent sees its own lane in advertisements; another member only for an explicit v2 prefix", async () => {
	await withWorld(async (w) => {
		const { agent, laneId, dir } = await agentWithLane(w, "a");
		const head = await commitFile(w.sandbox, dir, "a.txt", "one\n");
		await w.gitAs(agent, ["push", "-q", "origin", `HEAD:${laneRef(laneId)}`], {
			cwd: dir,
		});
		await w.settle();
		ok((await lsRemote(w, agent)).includes(laneRef(laneId)));
		const other = w.principal("agent");
		ok(!(await lsRemote(w, other)).some(isHiddenRef));
		const v0 = await w.gitAs(other, [
			"-c",
			"protocol.version=0",
			"ls-remote",
			w.remote,
		]);
		ok(!v0.stdout.includes("refs/heads/lanes/"), v0.stdout);
		// An explicit refspec sends `ref-prefix` inside the hidden namespace,
		// so another Reporter+ can fetch the lane (they may read every lane).
		const otherDir = await w.clone(other, "b");
		await w.gitAs(other, [
			"fetch",
			"-q",
			"origin",
			`${laneRef(laneId)}:refs/remotes/peek`,
		], { cwd: otherDir });
		equal(await revParse(w.sandbox, otherDir, "refs/remotes/peek"), head);
	});
});

test("ref policy for a second agent: another lane, main, a branch, a tag, case variants, kernel refs and a delete are refused", async () => {
	await withWorld(async (w) => {
		const a = await agentWithLane(w, "a");
		await commitFile(w.sandbox, a.dir, "a.txt", "one\n");
		await w.gitAs(a.agent, [
			"push",
			"-q",
			"origin",
			`HEAD:${laneRef(a.laneId)}`,
		], { cwd: a.dir });
		const b = await agentWithLane(w, "b");
		await commitFile(w.sandbox, b.dir, "b.txt", "b\n");
		await w.gitAs(b.agent, [
			"push",
			"-q",
			"origin",
			`HEAD:${laneRef(b.laneId)}`,
		], { cwd: b.dir });
		const cases: [string, string][] = [
			[`HEAD:${laneRef(a.laneId)}`, "not-your-lane"],
			["HEAD:refs/heads/main", "woven-by-tartan"],
			["HEAD:refs/heads/feature", "agents-lanes-only"],
			["HEAD:refs/tags/v9", "tags-maintainer"],
			[
				`HEAD:refs/heads/lanes/${a.laneId.toUpperCase()}`,
				"case-collision",
			],
			["HEAD:refs/heads/Main", "case-collision"],
			["HEAD:refs/heads/lanes", "reserved-parent"],
			["HEAD:refs/tartan/changes/x", "kernel-only"],
			["HEAD:refs/notes/tartan", "kernel-only"],
			[`:${laneRef(b.laneId)}`, "use-lanes-close"],
		];
		const before = forwardedPushes(w).length;
		for (const [spec, reason] of cases) {
			const out = await w.gitAs(b.agent, ["push", "origin", spec], {
				cwd: b.dir,
				allowFail: true,
			});
			ok(out.code !== 0, spec);
			ok(out.stderr.includes(`(${reason})`), `${spec}: ${out.stderr}`);
		}
		equal(forwardedPushes(w).length, before, "a refused push was forwarded");
		await w.settle();
		equal(w.h.events.ofType("push.rejected").length, cases.length);
		// The lanes are where their owners left them.
		const upstream = await bareRefs(w.sandbox, w.bare);
		equal(upstream["refs/heads/main"], w.trunk);
		ok(upstream[laneRef(b.laneId)] !== undefined);
	});
});

test("one rejected command rejects the whole push; the allowed one is reported as atomic", async () => {
	await withWorld(async (w) => {
		const { agent, laneId, dir } = await agentWithLane(w, "a");
		await commitFile(w.sandbox, dir, "a.txt", "one\n");
		const out = await w.gitAs(agent, [
			"push",
			"--porcelain",
			"origin",
			`HEAD:${laneRef(laneId)}`,
			"HEAD:refs/heads/main",
		], { cwd: dir, allowFail: true });
		ok(out.code !== 0);
		match(
			out.stdout,
			/!\tHEAD:refs\/heads\/main\t\[remote rejected\] \(woven-by-tartan\)/,
		);
		match(
			out.stdout,
			/\[remote rejected\] \(atomic: another ref was rejected\)/,
		);
		equal(forwardedPushes(w).length, 0);
		await w.settle();
		equal((await w.h.facade.getLane(laneId))?.head, undefined);
	});
});

test("canonical write precheck: with an allow-all policy, an agent without a branch lane gets agents-lanes-only and no write token is requested", async () => {
	await withWorld(async (w) => {
		w.config = {
			...w.config,
			policy: (_ctx, commands) =>
				commands.map((c) => ({ ref: c.ref, allow: true as const })),
		};
		const agent = w.principal("agent");
		const dir = await w.clone(agent, "a");
		await commitFile(w.sandbox, dir, "a.txt", "one\n");
		const out = await w.gitAs(agent, [
			"push",
			"origin",
			"HEAD:refs/heads/main",
			"HEAD:refs/heads/x",
		], { cwd: dir, allowFail: true });
		ok(out.code !== 0);
		match(out.stderr, /\(agents-lanes-only\)/);
		ok(
			!w.upstreamCalls.some((c) => c.scope === "write"),
			"a write token was requested",
		);
		equal(forwardedPushes(w).length, 0);
		// Its receive-pack advertisement was synthesized: no write token either.
		ok(!w.backend.requests.some((r) => r.query.includes("git-receive-pack")));
		equal((await bareRefs(w.sandbox, w.bare))["refs/heads/main"], w.trunk);
	});
});

test("the landing freeze: a push to the agent's own lane while it is landing is lane-landing", async () => {
	await withWorld(async (w) => {
		const { agent, laneId, dir } = await agentWithLane(w, "a");
		await commitFile(w.sandbox, dir, "a.txt", "one\n");
		await w.gitAs(agent, ["push", "-q", "origin", `HEAD:${laneRef(laneId)}`], {
			cwd: dir,
		});
		await w.settle();
		// LandWorkflow's freeze (WP10, not merged): the lane row as RepoDO
		// holds it while its batch lands.
		const setState = (state: string) =>
			w.h.storage.sql.exec(
				"UPDATE lanes SET state = ? WHERE id = ?",
				state,
				laneId,
			);
		setState("landing");
		await commitFile(w.sandbox, dir, "a.txt", "two\n");
		const out = await w.gitAs(agent, [
			"push",
			"origin",
			`HEAD:${laneRef(laneId)}`,
		], { cwd: dir, allowFail: true });
		ok(out.code !== 0);
		match(out.stderr, /\(lane-landing\)/);
		equal(forwardedPushes(w).length, 1);
		// Back to submitted (a non-landing outcome): the push goes through.
		setState("submitted");
		await w.gitAs(agent, ["push", "-q", "origin", `HEAD:${laneRef(laneId)}`], {
			cwd: dir,
		});
		equal(forwardedPushes(w).length, 2);
	});
});

test("an upstream lane head ahead of the index is stale-old and never forwarded", async () => {
	await withWorld(async (w) => {
		const { agent, laneId, dir } = await agentWithLane(w, "a");
		await commitFile(w.sandbox, dir, "a.txt", "one\n");
		await w.gitAs(agent, ["push", "-q", "origin", `HEAD:${laneRef(laneId)}`], {
			cwd: dir,
		});
		await w.settle();
		// A write that bypassed the gateway moves the upstream lane ref.
		const foreign = await commitFile(w.sandbox, w.seed, "foreign.txt", "x\n");
		await w.gitAs(null, [
			"push",
			"-q",
			"-f",
			w.bare,
			`${foreign}:${laneRef(laneId)}`,
		], { cwd: w.seed });
		await commitFile(w.sandbox, dir, "a.txt", "two\n");
		const out = await w.gitAs(agent, [
			"push",
			"-f",
			"origin",
			`HEAD:${laneRef(laneId)}`,
		], { cwd: dir, allowFail: true });
		ok(out.code !== 0);
		match(out.stderr, /\(stale-old\)/);
		equal(forwardedPushes(w).length, 1);
	});
});

test("a lane-pinned token writes its pinned lane only; the same agent's other lane is not-your-lane", async () => {
	await withWorld(async (w) => {
		const agent = w.principal("agent");
		const pinnedLane = await w.openLane(agent);
		const otherLane = await w.openLane(agent);
		const pinned = w.pin(agent, pinnedLane);
		const dir = await w.clone(pinned, "p");
		await commitFile(w.sandbox, dir, "a.txt", "one\n");
		await w.gitAs(pinned, [
			"push",
			"-q",
			"origin",
			`HEAD:${laneRef(pinnedLane)}`,
		], { cwd: dir });
		const out = await w.gitAs(pinned, [
			"push",
			"origin",
			`HEAD:${laneRef(otherLane)}`,
		], { cwd: dir, allowFail: true });
		match(out.stderr, /\(not-your-lane\)/);
		// The unpinned token writes either.
		await w.gitAs(agent, [
			"push",
			"-q",
			"origin",
			`HEAD:${laneRef(otherLane)}`,
		], { cwd: dir });
		const upstream = await bareRefs(w.sandbox, w.bare);
		ok(upstream[laneRef(pinnedLane)] !== undefined);
		ok(upstream[laneRef(otherLane)] !== undefined);
	});
});

test("a read-scoped token and a Reporter cannot push (403 before any pack is forwarded); both still clone", async () => {
	await withWorld(async (w) => {
		const reader = w.principal("agent", { scopes: ["repo:read", "mcp"] });
		const reporter = w.principal("user", { role: ROLE.reporter });
		for (const who of [reader, reporter]) {
			const dir = await w.clone(who, who.id);
			await commitFile(w.sandbox, dir, "a.txt", "x\n");
			const out = await w.gitAs(who, ["push", "origin", "HEAD:refs/heads/x"], {
				cwd: dir,
				allowFail: true,
			});
			ok(out.code !== 0);
			match(out.stderr, /403/);
		}
		equal(forwardedPushes(w).length, 0);
	});
});

test("a downgraded user (RepoDO's current role below Developer) holds no write credential", async () => {
	await withWorld(async (w) => {
		const user = w.principal("user");
		const dir = await w.clone(user, "c");
		await commitFile(w.sandbox, dir, "a.txt", "x\n");
		const real = w.repo;
		w.repo = {
			...real,
			pushContext: async (...args) => ({
				...(await real.pushContext(...args)),
				caller: { kind: "user", writeCredential: false },
			}),
		};
		const out = await w.gitAs(user, ["push", "origin", "HEAD:refs/heads/x"], {
			cwd: dir,
			allowFail: true,
		});
		match(out.stderr, /\(no-write-credential\)/);
		equal(forwardedPushes(w).length, 0);
	});
});
