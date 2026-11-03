// The synthesized-`ng` suite: the gateway's synthesized rejection, shown
// by stock git. A push to `main` is answered by the gateway itself, without
// reaching upstream, as a 200 report-status `ng refs/heads/main
// woven-by-tartan`, and git prints it as a remote rejection in every way
// stock git can ask for it: the capabilities git negotiates
// (report-status-v2 with side-band-64k as advertised; `quiet` with -q;
// `atomic` with --atomic), protocol v0 and v1, and the plain, --porcelain,
// -q and -v outputs. No output ever carries a control character.
//
// Band 2 (`remote: tartan ▸ …` guidance on a refusal, echo lines on an
// accepted lane push) is sent only with echo on (`ECHO_ENABLED` in
// src/constants.ts, or `stage up --echo on`). While it is off, the
// matrix checks that no Tartan band-2 line is sent; with it on, the refusal
// guidance is checked. The accepted-push echo test stays a pending skip
// whatever the switch: the echo lines come from the installations in force,
// and this branch has none.

import { writeFile } from "node:fs/promises";
import * as path from "node:path";
import { expect } from "e2e";
import type { LaneHandle } from "@tartan/contract/interfaces.ts";
import type { RefPolicyReason } from "@tartan/contract/security.ts";
import { scriptedAgent } from "../../support/agent.ts";
import { sharedStore, test } from "../../support/fixtures.ts";
import { FIXTURE_HEAD } from "../../support/fixture-repo.ts";
import {
	controlsIn,
	echoOn,
	refusedWith,
	tartanRemoteLines,
} from "../../support/gateway.ts";
import { git, gitDate, gitEnv, gitOk } from "../../support/git.ts";
import { PACK_GROUP } from "../../support/names.ts";
import { fixtureRepo } from "../../support/repos.ts";
import { keyOf } from "../../support/shared.ts";
import { type Stage, stage, tokensOf } from "../../support/stage.ts";

const WOVEN: RefPolicyReason = "woven-by-tartan";
const ECHO = echoOn(stage().switches);
const ECHO_OFF =
	"pending: band-2 lines need echo on this stage (stage up --echo on, or ECHO_ENABLED in src/constants.ts)";

/** How stock git can ask for the refusal: capabilities, protocol, output. */
const MATRIX: readonly {
	readonly name: string;
	readonly config: readonly string[];
	readonly flags: readonly string[];
}[] = [
	{ name: "plain (report-status-v2, side-band-64k)", config: [], flags: [] },
	{ name: "--porcelain", config: [], flags: ["--porcelain"] },
	{ name: "-q (quiet)", config: [], flags: ["-q"] },
	{ name: "-v", config: [], flags: ["-v"] },
	{ name: "--atomic", config: [], flags: ["--atomic"] },
	{ name: "protocol v0", config: ["-c", "protocol.version=0"], flags: [] },
	{ name: "protocol v1", config: ["-c", "protocol.version=1"], flags: [] },
	{
		name: "protocol v1 --porcelain -q",
		config: ["-c", "protocol.version=1"],
		flags: ["--porcelain", "-q"],
	},
];

const repoFor = async (stage: Stage, title: string) => {
	const index = await sharedStore().claimIndex(`claim-s3-${keyOf(title)}`);
	return await fixtureRepo(
		stage,
		"classic",
		index === 0 ? "s3" : `s3-${index}`,
	);
};

/** A clone with the owner's PAT and one new commit on top of trunk. */
const ownerClone = async (
	stage: Stage,
	remote: string,
	workdir: string,
	label: string,
) => {
	const token = tokensOf(stage).ownerPat;
	const env = gitEnv({
		home: path.join(workdir, `${label}-home`),
		auth: { origin: stage.origin, token },
		date: gitDate(1_767_571_200),
	});
	const clone = path.join(workdir, `${label}-clone`);
	await gitOk(["clone", "-q", remote, clone], { cwd: workdir, env, token });
	await writeFile(path.join(clone, `${label}.txt`), `${label}\n`);
	await gitOk(["add", "--all"], { cwd: clone, env });
	await gitOk(["commit", "-q", "--no-verify", "-m", `S3 ${label}`], {
		cwd: clone,
		env,
	});
	return { clone, env, token };
};

test.describe("The synthesized ng through the product gateway", {
	tags: ["gateway", "s3", "git", "regression", "owner"],
	session: "owner",
}, () => {
	for (const cell of MATRIX) {
		const title =
			`a refused push to main shows as a remote rejection: ${cell.name}`;
		test(title, { timeout: 180_000 }, async ({ stage, workdir }) => {
			const repo = await repoFor(stage, title);
			const c = await ownerClone(stage, repo.remote, workdir, "s3");
			const pushed = await git(
				[
					...cell.config,
					"push",
					...cell.flags,
					"origin",
					"HEAD:refs/heads/main",
				],
				{ cwd: c.clone, env: c.env, token: c.token },
			);
			const out = pushed.stdout + pushed.stderr;
			expect(pushed.code, "the push fails").not.toBe(0);
			expect(refusedWith(out, "refs/heads/main", WOVEN), out).toBe(true);
			expect(controlsIn(out), "no control character reaches the terminal")
				.toEqual([]);
			if (!ECHO) {
				expect(tartanRemoteLines(out), "no band-2 line while echo is off")
					.toEqual([]);
			} else if (!cell.flags.includes("--porcelain")) {
				expect(tartanRemoteLines(out).length, "band-2 guidance")
					.toBeGreaterThan(
						0,
					);
			}
			const trunk = await gitOk(["ls-remote", "origin", "refs/heads/main"], {
				cwd: c.clone,
				env: c.env,
				token: c.token,
			});
			expect(trunk.split("\t")[0], "trunk did not move").toBe(FIXTURE_HEAD);
		});
	}

	test("a refusal carries remote: guidance with the lane push command", {
		skip: ECHO ? false : ECHO_OFF,
		tags: ["echo"],
		timeout: 180_000,
	}, async ({ stage, workdir }) => {
		const repo = await repoFor(stage, "s3 guidance");
		const c = await ownerClone(stage, repo.remote, workdir, "guidance");
		const pushed = await git(["push", "origin", "HEAD:refs/heads/main"], {
			cwd: c.clone,
			env: c.env,
			token: c.token,
		});
		expect(tartanRemoteLines(pushed.stderr).join("\n")).toMatch(
			/main is woven by Tartan/,
		);
	});

	test(
		"an accepted lane push carries Tartan's band-2 lines before git's own end",
		{
			// An accepted push carries the echo of the installations in force;
			// no extension is installed on this branch, so a repo gets none.
			skip:
				"pending: no installed extension contributes an echo on this branch",
			tags: ["echo", "agent", "pending"],
			timeout: 300_000,
		},
		async ({ stage, workdir }) => {
			const repo = await fixtureRepo(stage, "swarm", "s3-echo");
			const agent = scriptedAgent(stage, PACK_GROUP.swarm, "A");
			const { lane: first } = await agent.mcp.call<{ lane: LaneHandle }>(
				"lanes_open",
				{ repo: repo.path, purpose: "S3 echo" },
			);
			const lane = await agent.awaitOpen(repo.path, first);
			const clone = await agent.clone(workdir, repo.remote);
			await agent.runLane(lane.git.start, clone);
			await writeFile(path.join(clone, "echo.txt"), "echo\n");
			await agent.commit(clone, "S3 echo");
			const pushed = await agent.gitResult(clone, [
				"push",
				lane.remote,
				`HEAD:${lane.ref}`,
			]);
			expect(pushed.code).toBe(0);
			expect(tartanRemoteLines(pushed.stderr).length).toBeGreaterThan(0);
			expect(controlsIn(pushed.stdout + pushed.stderr)).toEqual([]);
		},
	);
});
