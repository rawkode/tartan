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
// accepted lane push) is sent only with `ECHO_ENABLED` (src/constants.ts):
// while it is off, the matrix checks that no Tartan band-2 line is
// sent, and the echo tests are pending skips that run once it is on.
//
// Untrusted text (a work item title with ESC, OSC and BEL sequences) is
// stripped of its control characters before it reaches another agent's
// notices (and, with echo on, its terminal).

import { writeFile } from "node:fs/promises";
import * as path from "node:path";
import { expect } from "e2e";
import type { Conflict, WorkItem } from "@tartan/contract/interfaces.ts";
import type { LaneHandle } from "@tartan/contract/interfaces.ts";
import type { RefPolicyReason } from "@tartan/contract/security.ts";
import { scriptedAgent } from "../../support/agent.ts";
import { sharedStore, test } from "../../support/fixtures.ts";
import { FIXTURE_HEAD } from "../../support/fixture-repo.ts";
import {
	controlsIn,
	echoEnabled,
	refusedWith,
	tartanRemoteLines,
} from "../../support/gateway.ts";
import { git, gitDate, gitEnv, gitOk } from "../../support/git.ts";
import { PACK_GROUP } from "../../support/names.ts";
import { fixtureRepo } from "../../support/repos.ts";
import { keyOf } from "../../support/shared.ts";
import { type Stage, tokensOf } from "../../support/stage.ts";

const WOVEN: RefPolicyReason = "woven-by-tartan";
const ECHO = echoEnabled();
const ECHO_OFF =
	"pending: band-2 lines need ECHO_ENABLED (src/constants.ts), which is off by default";

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
			skip: ECHO ? false : ECHO_OFF,
			tags: ["echo", "agent"],
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
				"origin",
				`HEAD:${lane.ref}`,
			]);
			expect(pushed.code).toBe(0);
			expect(tartanRemoteLines(pushed.stderr).length).toBeGreaterThan(0);
			expect(controlsIn(pushed.stdout + pushed.stderr)).toEqual([]);
		},
	);

	test("ESC, OSC and BEL in a work title never reach another agent", {
		tags: ["agent", "radar", "n2"],
		timeout: 300_000,
	}, async ({ stage, workdir }) => {
		// A claims an item whose title carries terminal escapes; both agents
		// then edit one file, B first: A's push is the one radar reacts to,
		// so it tells B about A's lane, title included.
		const repo = await fixtureRepo(stage, "swarm", "s3-escapes");
		const a = scriptedAgent(stage, PACK_GROUP.swarm, "A");
		const b = scriptedAgent(stage, PACK_GROUP.swarm, "B");
		const hostile =
			`Pwn\u001b]0;owned\u0007 \u001b[31mred\u001b[0m \u009b2J ${stage.runId}`;
		const lanes: Record<"A" | "B", string> = { A: "", B: "" };
		for (
			const [agent, title] of [[b, `Plain ${stage.runId}`], [
				a,
				hostile,
			]] as const
		) {
			const item = await agent.mcp.call<WorkItem>("work_create", {
				repo: repo.path,
				kind: "intent",
				title,
			});
			const claim = await agent.mcp.call<{ lane: LaneHandle }>("work_claim", {
				ref: item.ref,
			});
			const lane = await agent.awaitOpen(repo.path, claim.lane);
			const clone = await agent.clone(workdir, repo.remote);
			await agent.runLane(lane.git.start, clone);
			await writeFile(
				path.join(clone, "docs", "guide.md"),
				`# Guide\n\n${agent.name} was here.\n`,
			);
			await agent.commit(clone, `S3 escapes ${agent.name}`);
			const pushed = await agent.gitResult(clone, [
				"push",
				"origin",
				`HEAD:${lane.ref}`,
			]);
			expect(pushed.code, `agent ${agent.name} pushes its lane`).toBe(0);
			expect(controlsIn(pushed.stdout + pushed.stderr)).toEqual([]);
			lanes[agent.name] = lane.id;
		}
		// Radar's conflict exists, and one of B's next results carries the
		// notice about A's lane with the title's text but none of its
		// controls. A notice is delivered once, so every result B gets from
		// here on is read for it (the structured notices and the text block).
		const notices: string[] = [];
		const texts: string[] = [];
		const told = () => notices.some((n) => n.includes(lanes.A));
		await expect.poll(async () => {
			const result = await b.mcp.callFull<{ conflicts: Conflict[] }>(
				"conflicts_list",
				{ repo: repo.path },
			);
			notices.push(...result.notices.map((n) => n.text));
			texts.push(result.text);
			return result.value.conflicts.some((x) =>
				new Set([x.a, x.b]).has(lanes.A) && new Set([x.a, x.b]).has(lanes.B)
			);
		}, { timeout: 120_000, interval: 2_000, message: "radar saw no conflict" })
			.toBe(true);
		await expect.poll(async () => {
			if (told()) return true;
			const result = await b.mcp.callFull("lanes_get", {
				repo: repo.path,
				laneId: lanes.B,
			});
			notices.push(...result.notices.map((n) => n.text));
			texts.push(result.text);
			return told();
		}, { timeout: 120_000, interval: 2_000, message: "B was never told" })
			.toBe(true);
		const notice = notices.find((n) => n.includes(lanes.A)) ?? "";
		expect(controlsIn(notice), "the notice has no control character")
			.toEqual([]);
		expect(controlsIn(texts.join("\n")), "nor the results' text").toEqual([]);
		expect(notice, "the title's printable text survives").toContain("owned");
	});
});
