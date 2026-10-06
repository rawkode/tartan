// The gateway end to end with stock git (M1; the local harness of
// `testing/world.ts`: stock git → gateway handlers → WP5a's real RepoDO core →
// `git http-backend`): clones, human pushes and their recording, synthesized
// rejections and how git prints them. Skipped when no `git` binary is on PATH.

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

test("clone and fetch through the gateway: trunk visible, kernel refs hidden (member view, v2)", async () => {
	await withWorld(async (w) => {
		const user = w.principal("user");
		const dir = await w.clone(user, "c1");
		equal(await revParse(w.sandbox, dir, "HEAD"), w.trunk);
		const refs = await lsRemote(w, user);
		ok(refs.includes("refs/heads/main"));
		ok(!refs.some(isHiddenRef), `hidden refs advertised: ${refs}`);
		// Upstream got the kernel's Bearer token, never the client's credential.
		ok(w.backend.requests.length > 0);
		for (const request of w.backend.requests) {
			match(request.headers.authorization ?? "", /^Bearer art_v2_/);
		}
	});
});

test("protocol v0 clones and ls-remote are filtered the same way", async () => {
	await withWorld(async (w) => {
		const user = w.principal("user");
		const target = `${w.sandbox.root}/v0`;
		const v0 = ["-c", "protocol.version=0"];
		await w.gitAs(user, [...v0, "clone", "-q", w.remote, target]);
		equal(await revParse(w.sandbox, target, "HEAD"), w.trunk);
		const out = await w.gitAs(user, [...v0, "ls-remote", w.remote]);
		ok(out.stdout.includes("refs/heads/main"));
		ok(!out.stdout.includes("refs/tartan/"), out.stdout);
	});
});

test("a human pushes a branch: forwarded, recorded by phase 1 with attribution, phase 2 run", async () => {
	await withWorld(async (w) => {
		const user = w.principal("user");
		const dir = await w.clone(user, "c1");
		const head = await commitFile(w.sandbox, dir, "feat.txt", "feature\n");
		await w.gitAs(user, ["push", "-q", "origin", "HEAD:refs/heads/feat-x"], {
			cwd: dir,
		});
		await w.settle();
		equal((await bareRefs(w.sandbox, w.bare))["refs/heads/feat-x"], head);
		const refs = await w.h.facade.refs();
		equal(refs.find((r) => r.ref === "refs/heads/feat-x")?.sha, head);
		const accepted = w.h.events.ofType("push.accepted");
		equal(accepted.length, 1);
		equal(accepted[0].actor.id, user.id);
		deepStrictEqual(w.probeCalls.map((c) => c.after), [head]);
		// Phase 2 reached RepoDO: the push row is diffed.
		const row = w.h.storage.sql.exec<{ diff_state: string; via: string }>(
			"SELECT diff_state, via FROM pushes WHERE ref = 'refs/heads/feat-x'",
		).toArray()[0];
		deepStrictEqual(row, { diff_state: "done", via: "gateway" });
	});
});

test("a human push to main gets a synthesized ng that stock git prints; nothing is forwarded", async () => {
	await withWorld(async (w) => {
		const user = w.principal("user", { role: ROLE.owner });
		const dir = await w.clone(user, "c1");
		await commitFile(w.sandbox, dir, "x.txt", "x\n");
		const out = await w.gitAs(user, ["push", "origin", "HEAD:main"], {
			cwd: dir,
			allowFail: true,
		});
		ok(out.code !== 0);
		match(out.stderr, /! \[remote rejected\] HEAD -> main \(woven-by-tartan\)/);
		equal(forwardedPushes(w).length, 0);
		await w.settle();
		const rejected = w.h.events.ofType("push.rejected");
		equal(rejected.length, 1);
		equal((await bareRefs(w.sandbox, w.bare))["refs/heads/main"], w.trunk);
	});
});

test("rejection display: --porcelain and -q both show the synthesized reason", async () => {
	await withWorld(async (w) => {
		const user = w.principal("user");
		const dir = await w.clone(user, "c");
		await commitFile(w.sandbox, dir, "x.txt", "x\n");
		const porcelain = await w.gitAs(user, [
			"push",
			"--porcelain",
			"origin",
			"HEAD:main",
		], { cwd: dir, allowFail: true });
		match(
			porcelain.stdout,
			/!\tHEAD:refs\/heads\/main\t\[remote rejected\] \(woven-by-tartan\)/,
		);
		const quiet = await w.gitAs(user, ["push", "-q", "origin", "HEAD:main"], {
			cwd: dir,
			allowFail: true,
		});
		match(quiet.stderr, /\[remote rejected\] HEAD -> main \(woven-by-tartan\)/);
	});
});

test("with ECHO_ENABLED, band-2 guidance reaches git as remote: lines, with no control characters", async () => {
	await withWorld(async (w) => {
		w.config = { ...w.config, echo: true };
		const { agent, laneId, dir } = await agentWithLane(w, "a");
		await commitFile(w.sandbox, dir, "a.txt", "one\n");
		const out = await w.gitAs(agent, ["push", "origin", "HEAD:main"], {
			cwd: dir,
			allowFail: true,
		});
		match(
			out.stderr,
			/remote: tartan ▸ main is woven by Tartan; nobody pushes it directly\./,
		);
		ok(
			out.stderr.includes(`git push origin HEAD:${laneRef(laneId)}`),
			out.stderr,
		);
		ok(!out.stderr.includes("\x1b"));
		// Without echo (the M1 default), only the reason.
		w.config = { ...w.config, echo: false };
		const plain = await w.gitAs(agent, ["push", "origin", "HEAD:main"], {
			cwd: dir,
			allowFail: true,
		});
		ok(!plain.stderr.includes("remote: tartan"));
		match(plain.stderr, /\(woven-by-tartan\)/);
	});
});

test("with echo on, an accepted lane push carries the installations' echo as remote: lines", async () => {
	await withWorld(async (w) => {
		const calls: { type: string; repoId: string }[] = [];
		w.echo = (event, at) => {
			calls.push({ type: event.type, repoId: at.repoId });
			return Promise.resolve([
				"[no-secrets] AWS access key at config/x.ts:3 (AKIA…MPLE)",
			]);
		};
		const { agent, laneId, dir } = await agentWithLane(w, "a");
		await commitFile(w.sandbox, dir, "a.txt", "one\n");
		// Echo off (the default): the push succeeds, no line, no echo call.
		const off = await w.gitAs(agent, [
			"push",
			"origin",
			`HEAD:${laneRef(laneId)}`,
		], { cwd: dir });
		ok(!off.stderr.includes("[no-secrets]"), off.stderr);
		equal(calls.length, 0);
		// Echo on: the line reaches git as band 2, after the accepted ref.
		w.config = { ...w.config, echo: true };
		await commitFile(w.sandbox, dir, "b.txt", "two\n");
		const on = await w.gitAs(agent, [
			"push",
			"origin",
			`HEAD:${laneRef(laneId)}`,
		], { cwd: dir });
		match(
			on.stderr,
			/remote: \[no-secrets\] AWS access key at config\/x\.ts:3 \(AKIA…MPLE\)/,
		);
		deepStrictEqual(calls.map((c) => c.type), ["push.accepted"]);
		// An echo that fails releases the flush untouched.
		w.echo = () => Promise.reject(new Error("host down"));
		await commitFile(w.sandbox, dir, "c.txt", "three\n");
		const failed = await w.gitAs(agent, [
			"push",
			"origin",
			`HEAD:${laneRef(laneId)}`,
		], { cwd: dir });
		ok(!failed.stderr.includes("[no-secrets]"), failed.stderr);
	});
});

test("a redirected repo path answers 301 and git follows it", async () => {
	await withWorld(async (w) => {
		w.redirects.set("acme/old-shop", w.repoPath);
		const user = w.principal("user");
		const target = `${w.sandbox.root}/moved`;
		await w.gitAs(user, [
			"clone",
			"-q",
			`${w.gatewayUrl}/acme/old-shop.git`,
			target,
		]);
		equal(await revParse(w.sandbox, target, "HEAD"), w.trunk);
	});
});

test("a human deletes a feature branch; the delete is recorded and no diff is computed", async () => {
	await withWorld(async (w) => {
		const user = w.principal("user");
		const dir = await w.clone(user, "c");
		await commitFile(w.sandbox, dir, "f.txt", "f\n");
		await w.gitAs(user, ["push", "-q", "origin", "HEAD:refs/heads/tmp"], {
			cwd: dir,
		});
		await w.settle();
		await w.gitAs(user, ["push", "-q", "origin", ":refs/heads/tmp"], {
			cwd: dir,
		});
		await w.settle();
		equal((await bareRefs(w.sandbox, w.bare))["refs/heads/tmp"], undefined);
		equal(w.probeCalls.length, 1);
		equal(w.h.events.ofType("push.accepted").length, 2);
	});
});

test("a multi-ref human push (branch + tag by a Maintainer) is forwarded once and records both refs", async () => {
	await withWorld(async (w) => {
		const user = w.principal("user", { role: ROLE.maintainer });
		const dir = await w.clone(user, "c");
		const head = await commitFile(w.sandbox, dir, "f.txt", "f\n");
		await w.gitAs(user, ["tag", "v1.0"], { cwd: dir });
		await w.gitAs(user, [
			"push",
			"-q",
			"origin",
			"HEAD:refs/heads/rel",
			"refs/tags/v1.0",
		], { cwd: dir });
		await w.settle();
		const upstream = await bareRefs(w.sandbox, w.bare);
		equal(upstream["refs/heads/rel"], head);
		equal(upstream["refs/tags/v1.0"], head);
		equal(forwardedPushes(w).length, 1);
		equal(w.h.events.ofType("push.accepted").length, 2);
		// A Developer may not tag.
		const dev = w.principal("user", { role: ROLE.developer });
		await w.gitAs(dev, ["tag", "v2.0"], { cwd: dir });
		const out = await w.gitAs(dev, ["push", "origin", "refs/tags/v2.0"], {
			cwd: dir,
			allowFail: true,
		});
		match(out.stderr, /\(tags-maintainer\)/);
	});
});
