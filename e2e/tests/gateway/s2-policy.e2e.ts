// M1-exit probe S2-rem, the rows for BRANCH lanes: the canonical
// repo's receive-pack table with stock git and the run's
// real tokens, hidden-namespace filtering, and the fail-closed parser.
// Each row is its own test over one shared setup (support/shared.ts): a
// Classic repo where agents A and B each opened a lane and pushed it once.
// Every refusal is checked by its `ng` reason (contract `REF_POLICY_REASONS`)
// and by the ref it must not have moved.
//
// Not here: the lane-remote table and the upstream scope check belong
// to the `repo` lane backend (M2): pending skips tagged `m2-lanes`. The
// public-view rows need a public repo, which the e2e groups never hold:
// pending skips tagged `public-view`.

import { appendFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { expect } from "e2e";
import {
	REF_POLICY_REASONS,
	type RefPolicyReason,
} from "@tartan/contract/security.ts";
import type { LaneDto, LanesResponse } from "@tartan/contract/api.ts";
import type { LaneHandle } from "@tartan/contract/interfaces.ts";
import { type AgentName, scriptedAgent } from "../../support/agent.ts";
import { sharedStore, test } from "../../support/fixtures.ts";
import { FIXTURE_HEAD } from "../../support/fixture-repo.ts";
import {
	PARSER_PROBES,
	receivePackAllowlist,
	refusedWith,
	refusedWithAny,
} from "../../support/gateway.ts";
import { git, gitDate, gitEnv, gitOk } from "../../support/git.ts";
import { gitHttp, ok, query, tokenApi } from "../../support/http.ts";
import { PACK_GROUP } from "../../support/names.ts";
import { fixtureRepo } from "../../support/repos.ts";
import { keyOf, sharedDirOf } from "../../support/shared.ts";
import { type Stage, tokensOf } from "../../support/stage.ts";

// `ng` reasons, checked against the contract by `deno task check`.
const R = {
	woven: "woven-by-tartan",
	kernel: "kernel-only",
	notYours: "not-your-lane",
	close: "use-lanes-close",
	landing: "lane-landing",
	stale: "stale-old",
	agentsLanes: "agents-lanes-only",
	tags: "tags-maintainer",
	unsupported: "unsupported-ref",
	reservedParent: "reserved-parent",
	caseCollision: "case-collision",
	malformed: "malformed-push",
} as const satisfies Readonly<Record<string, RefPolicyReason>>;
const LANDING: LaneDto["state"] = "landing";

type Lane = {
	readonly id: string;
	readonly ref: string;
	readonly head: string;
};
type Setup = {
	readonly repo: { readonly path: string; readonly remote: string };
	readonly lanes: Readonly<Record<AgentName, Lane>>;
};

/** One shared setup per instance: A and B each open a lane and push it once. */
const setupOf = (stage: Stage, index: number): Promise<Setup> =>
	sharedStore().once(`s2-${index}-setup`, async (): Promise<Setup> => {
		const suite = index === 0 ? "s2" : `s2-${index}`;
		const repo = await fixtureRepo(stage, "classic", suite);
		const scratch = path.join(
			sharedDirOf(tmpdir(), stage.runId),
			`scratch-${suite}`,
		);
		const lanes = {} as Record<AgentName, Lane>;
		for (const name of ["A", "B"] as const) {
			const agent = scriptedAgent(stage, PACK_GROUP.classic, name);
			const { lane: first } = await agent.mcp.call<{ lane: LaneHandle }>(
				"lanes_open",
				{ repo: repo.path, purpose: `S2 probe lane ${name}` },
			);
			const lane = await agent.awaitOpen(repo.path, first);
			const clone = await agent.clone(scratch, repo.remote);
			await agent.runLane(lane.git.start, clone);
			await writeFile(path.join(clone, `s2-${name}.txt`), `${name}\n`);
			const head = await agent.commit(clone, `S2 lane ${name}`);
			// Row 4: the create of an own lane (no head yet, old = zeros).
			await agent.runLane(lane.git.push, clone);
			lanes[name] = { id: lane.id, ref: lane.ref, head };
		}
		return { repo: { path: repo.path, remote: repo.remote }, lanes };
	});

const setupFor = async (stage: Stage, title: string): Promise<Setup> =>
	setupOf(stage, await sharedStore().claimIndex(`claim-s2-${keyOf(title)}`));

/** A fresh clone of the repo for `who` (an agent or a token) in `workdir`. */
const cloneAs = async (
	stage: Stage,
	setup: Setup,
	workdir: string,
	token: string,
	label: string,
) => {
	const home = path.join(workdir, `${label}-home`);
	const env = gitEnv({
		home,
		auth: { origin: stage.origin, token },
		date: gitDate(1_767_484_800),
	});
	const clone = path.join(workdir, `${label}-clone`);
	await gitOk(["clone", "-q", setup.repo.remote, clone], {
		cwd: workdir,
		env,
		token,
	});
	const run = (args: readonly string[]) =>
		git(args, { cwd: clone, env, token });
	const runOk = (args: readonly string[]) =>
		gitOk(args, { cwd: clone, env, token });
	const commit = async (name: string): Promise<string> => {
		await appendFile(path.join(clone, `${name}.txt`), `${name}\n`);
		await runOk(["add", "--all"]);
		await runOk(["commit", "-q", "--no-verify", "-m", `S2 ${name}`]);
		return (await runOk(["rev-parse", "HEAD"])).trim();
	};
	const remoteHead = async (ref: string): Promise<string | null> => {
		const out = await runOk(["ls-remote", "origin", ref]);
		const line = out.split("\n").find((l) => l.endsWith(`\t${ref}`));
		return line === undefined ? null : line.split("\t")[0];
	};
	return { clone, env, run, runOk, commit, remoteHead };
};

const agentToken = (stage: Stage, name: AgentName) =>
	name === "A"
		? tokensOf(stage).developerAgent
		: tokensOf(stage).developerAgentB;

/** A new lane of agent `name`, created by its first push (row 4's create). */
const freshLane = async (
	stage: Stage,
	setup: Setup,
	name: AgentName,
	workdir: string,
	label: string,
): Promise<Lane> => {
	const agent = scriptedAgent(stage, PACK_GROUP.classic, name);
	const { lane: first } = await agent.mcp.call<{ lane: LaneHandle }>(
		"lanes_open",
		{ repo: setup.repo.path, purpose: `S2 ${label} lane` },
	);
	const lane = await agent.awaitOpen(setup.repo.path, first);
	const clone = await agent.clone(path.join(workdir, label), setup.repo.remote);
	await agent.runLane(lane.git.start, clone);
	await writeFile(path.join(clone, `s2-${label}.txt`), `${label}\n`);
	const head = await agent.commit(clone, `S2 ${label} lane`);
	await agent.runLane(lane.git.push, clone);
	return { id: lane.id, ref: lane.ref, head };
};

const T = {
	ownLane: "row 4: an agent updates, force-pushes and leases its own lane",
	stale: "row 4: a stale old never moves a lane",
	other: "row 5: another agent's lane is not-your-lane",
	main: "row 2: main is woven-by-tartan, for an agent too",
	branch: "row 8: an agent's branch is agents-lanes-only",
	tagAgent: "row 9: an agent's tag is tags-maintainer",
	tagOwner: "row 9: the Owner (Maintainer+) may push a tag",
	caseVariant: "row 0: a case variant of the lane prefix is case-collision",
	parent: "row 0: the reserved parent refs/heads/lanes is reserved-parent",
	delete: "row 5: deleting an own lane is use-lanes-close",
	kernel: "row 3: kernel refs are kernel-only",
	unsupported: "row 10: other namespaces are unsupported-ref",
	read: "a read-scoped token is refused before any pack is sent",
	atomic: "one rejected command rejects the whole push",
	hidden: "lane refs stay hidden from clone and ls-remote, except one's own",
	fetchOther: "a member fetches another lane by name (protocol v2 ref-prefix)",
	caps:
		"the receive-pack advertisement offers only the allowlisted capabilities",
	parser: "the fail-closed parser refuses malformed receive-pack bodies",
	landing: "row 4: a push while the own lane is landing is lane-landing",
} as const;

test.describe("S2-rem: the canonical receive-pack table (branch lanes)", {
	tags: ["gateway", "s2", "git", "regression"],
	session: "developer",
}, () => {
	test(T.ownLane, { tags: ["agent"], timeout: 300_000 }, async ({
		stage,
		workdir,
	}) => {
		// A lane of its own: the shared lanes A and B never move, so the
		// tests that check "did not move" can run beside this one.
		const s = await setupFor(stage, T.ownLane);
		const lane = await freshLane(stage, s, "A", workdir, "own");
		const a = await cloneAs(stage, s, workdir, agentToken(stage, "A"), "a");
		expect(await a.remoteHead(lane.ref), "the lane was created").toBe(
			lane.head,
		);
		await a.runOk(["fetch", "-q", "origin", lane.ref]);
		await a.runOk(["switch", "-q", "-c", "lane", "FETCH_HEAD"]);
		// A fast-forward update.
		const ff = await a.commit("ff");
		await a.runOk(["push", "-q", "origin", `HEAD:${lane.ref}`]);
		expect(await a.remoteHead(lane.ref)).toBe(ff);
		// A forced rewrite (rebases work).
		await a.runOk(["reset", "-q", "--hard", "HEAD~1"]);
		const forced = await a.commit("forced");
		await a.runOk(["push", "-q", "--force", "origin", `HEAD:${lane.ref}`]);
		expect(await a.remoteHead(lane.ref)).toBe(forced);
		// --force-with-lease naming the current head.
		await a.runOk(["reset", "-q", "--hard", "HEAD~1"]);
		const leased = await a.commit("leased");
		await a.runOk([
			"push",
			"-q",
			`--force-with-lease=${lane.ref}:${forced}`,
			"origin",
			`HEAD:${lane.ref}`,
		]);
		expect(await a.remoteHead(lane.ref)).toBe(leased);
	});

	// Quarantined (docs/testing/e2e.md "Flakes") until the race's refusal
	// forms are pinned down. The loser's output is on the message's first
	// line; run it with `--tag quarantine`.
	test(T.stale, {
		tags: ["agent", "stale-old", "quarantine"],
		timeout: 300_000,
	}, async ({
		stage,
		workdir,
	}) => {
		// Two clones of the same lane head push different commits at once:
		// exactly one wins, and the other is refused (stale-old at the
		// gateway, or git's own "fetch first" when it saw the new head).
		const s = await setupFor(stage, T.stale);
		const lane = await freshLane(stage, s, "B", workdir, "stale");
		const token = agentToken(stage, "B");
		const one = await cloneAs(stage, s, workdir, token, "b1");
		const two = await cloneAs(stage, s, workdir, token, "b2");
		for (const c of [one, two]) {
			await c.runOk(["fetch", "-q", "origin", lane.ref]);
			await c.runOk(["switch", "-q", "-c", "lane", "FETCH_HEAD"]);
		}
		const base = (await one.runOk(["rev-parse", "HEAD"])).trim();
		const heads = [await one.commit("race-1"), await two.commit("race-2")];
		const results = await Promise.all(
			[one, two].map((c) => c.run(["push", "origin", `HEAD:${lane.ref}`])),
		);
		const won = results.map((r) => r.code === 0);
		expect(won.filter(Boolean).length, "exactly one push wins").toBe(1);
		const loser = results[won.indexOf(false)];
		const said = loser.stdout + loser.stderr;
		// Three ways to lose the race, each leaving the lane at the winner:
		// the gateway's stale-old (it saw the winner's head first), the
		// upstream's own compare-and-swap refusal (when both passed the
		// gateway's check at once: any reason that is not the gateway's),
		// or git's "fetch first".
		const upstream = refusedWithAny(said, lane.ref) &&
			!REF_POLICY_REASONS.some((r) => refusedWith(said, lane.ref, r));
		expect(
			refusedWith(said, lane.ref, R.stale) || upstream ||
				/\[rejected\].*\((?:fetch first|non-fast-forward)\)/.test(said),
			`the other is refused as stale or not a fast-forward (loser said: ${
				(loser.stderr + loser.stdout).replace(/\s+/g, " ").trim().slice(0, 400)
			})`,
		).toBe(true);
		const head = await one.remoteHead(lane.ref);
		expect(head).toBe(heads[won.indexOf(true)]);
		expect(head).not.toBe(base);
	});

	for (
		const [title, name, refOf, reason] of [
			[T.other, "B", (s: Setup) => s.lanes.A.ref, R.notYours],
			[T.main, "A", () => "refs/heads/main", R.woven],
			[T.branch, "A", () => "refs/heads/s2-agent-branch", R.agentsLanes],
			[T.tagAgent, "A", () => "refs/tags/s2-agent-tag", R.tags],
			[
				T.caseVariant,
				"A",
				(s: Setup) =>
					s.lanes.A.ref.replace("refs/heads/lanes/", "refs/heads/Lanes/"),
				R.caseCollision,
			],
			[T.parent, "A", () => "refs/heads/lanes", R.reservedParent],
			[T.kernel, "A", () => "refs/tartan/s2-probe", R.kernel],
		] as const
	) {
		test(title, { tags: ["agent"], timeout: 300_000 }, async ({
			stage,
			workdir,
		}) => {
			const s = await setupFor(stage, title);
			const ref = refOf(s);
			const c = await cloneAs(stage, s, workdir, agentToken(stage, name), "c");
			const before = await c.remoteHead(ref);
			await c.commit("refused");
			const pushed = await c.run(["push", "origin", `HEAD:${ref}`]);
			expect(pushed.code, "the push fails").not.toBe(0);
			expect(
				refusedWith(pushed.stdout + pushed.stderr, ref, reason),
				`${ref} refused with ${reason}:\n${pushed.stderr}`,
			).toBe(true);
			expect(await c.remoteHead(ref), `${ref} did not move`).toBe(before);
		});
	}

	test(T.delete, { tags: ["agent"], timeout: 300_000 }, async ({
		stage,
		workdir,
	}) => {
		const s = await setupFor(stage, T.delete);
		const lane = s.lanes.A;
		const a = await cloneAs(stage, s, workdir, agentToken(stage, "A"), "a");
		const before = await a.remoteHead(lane.ref);
		const pushed = await a.run(["push", "origin", `:${lane.ref}`]);
		expect(pushed.code).not.toBe(0);
		expect(
			refusedWith(pushed.stdout + pushed.stderr, lane.ref, R.close),
			`${lane.ref} deletion refused with ${R.close}:\n${pushed.stderr}`,
		).toBe(true);
		expect(await a.remoteHead(lane.ref)).toBe(before);
	});

	test(T.tagOwner, { tags: ["owner"], timeout: 300_000 }, async ({
		stage,
		workdir,
	}) => {
		const s = await setupFor(stage, T.tagOwner);
		const o = await cloneAs(stage, s, workdir, tokensOf(stage).ownerPat, "o");
		const tag = `refs/tags/s2-owner-${stage.runId}`;
		await o.runOk(["push", "-q", "origin", `HEAD:${tag}`]);
		expect(await o.remoteHead(tag)).toBe(FIXTURE_HEAD);
	});

	test(T.unsupported, { tags: ["owner"], timeout: 300_000 }, async ({
		stage,
		workdir,
	}) => {
		const s = await setupFor(stage, T.unsupported);
		const o = await cloneAs(stage, s, workdir, tokensOf(stage).ownerPat, "o");
		for (const ref of ["refs/pull/1/head", "refs/for/main"]) {
			const pushed = await o.run(["push", "origin", `HEAD:${ref}`]);
			expect(pushed.code, ref).not.toBe(0);
			expect(
				refusedWith(pushed.stdout + pushed.stderr, ref, R.unsupported),
				`${ref}:\n${pushed.stderr}`,
			).toBe(true);
		}
		const notes = await o.run([
			"push",
			"origin",
			`HEAD:refs/notes/tartan`,
		]);
		expect(notes.code).not.toBe(0);
		expect(
			refusedWith(notes.stdout + notes.stderr, "refs/notes/tartan", R.kernel),
		).toBe(true);
	});

	test(T.read, { tags: ["developer"], timeout: 300_000 }, async ({
		stage,
		workdir,
	}) => {
		const s = await setupFor(stage, T.read);
		// The read-only PAT reads (member view)…
		const r = await cloneAs(stage, s, workdir, tokensOf(stage).readPat, "r");
		expect(await r.remoteHead("refs/heads/main")).toBe(FIXTURE_HEAD);
		// …and is refused before a pack is sent: no write credential.
		await r.commit("read-only");
		const pushed = await r.run(["push", "origin", "HEAD:refs/heads/s2-read"]);
		expect(pushed.code).not.toBe(0);
		expect(pushed.stderr).toMatch(/\b403\b/);
		expect(pushed.stderr).toMatch(/lanes or repo:write scope/);
		expect(await r.remoteHead("refs/heads/s2-read")).toBeNull();
	});

	test(T.atomic, { tags: ["owner"], timeout: 300_000 }, async ({
		stage,
		workdir,
	}) => {
		const s = await setupFor(stage, T.atomic);
		const o = await cloneAs(stage, s, workdir, tokensOf(stage).ownerPat, "o");
		await o.commit("atomic");
		const branch = `refs/heads/s2-atomic-${stage.runId}`;
		const pushed = await o.run([
			"push",
			"origin",
			`HEAD:${branch}`,
			"HEAD:refs/heads/main",
		]);
		expect(pushed.code).not.toBe(0);
		const out = pushed.stdout + pushed.stderr;
		expect(refusedWith(out, "refs/heads/main", R.woven)).toBe(true);
		// The allowed branch is refused with the push (nothing forwarded).
		expect(out).toMatch(
			new RegExp(
				`\\[remote rejected\\][^\\n]*${branch.replace("refs/heads/", "")}`,
			),
		);
		expect(await o.remoteHead(branch)).toBeNull();
		expect(await o.remoteHead("refs/heads/main")).toBe(FIXTURE_HEAD);
	});

	test(T.hidden, { tags: ["agent", "hidden-refs"], timeout: 300_000 }, async ({
		stage,
		workdir,
	}) => {
		const s = await setupFor(stage, T.hidden);
		const a = await cloneAs(stage, s, workdir, agentToken(stage, "A"), "a");
		// The advertisement holds the visible refs plus the caller's own
		// lanes: A's clone may carry its own lanes, never B's.
		const refs = (await a.runOk(["for-each-ref", "--format=%(refname)"]))
			.split("\n");
		expect(refs.filter((r) => r.includes(s.lanes.B.id))).toEqual([]);
		// ls-remote of the lane namespace (no ref-prefix is sent for a
		// pattern): A sees its own lane, not B's.
		const listed =
			(await a.runOk(["ls-remote", "origin", "refs/heads/lanes/*"]))
				.split("\n").filter((l) => l !== "").map((l) => l.split("\t")[1]);
		expect(listed).toContain(s.lanes.A.ref);
		expect(listed).not.toContain(s.lanes.B.ref);
		// A user (the read-only PAT) owns no lane: its clone and ls-remote
		// see none.
		const r = await cloneAs(stage, s, workdir, tokensOf(stage).readPat, "r");
		const userRefs = await r.runOk(["for-each-ref", "--format=%(refname)"]);
		expect(userRefs.split("\n").filter((x) => x.includes("/lanes/")))
			.toEqual([]);
		const none = await r.runOk(["ls-remote", "origin", "refs/heads/lanes/*"]);
		expect(none.trim()).toBe("");
	});

	test(
		T.fetchOther,
		{ tags: ["agent", "hidden-refs"], timeout: 300_000 },
		async ({
			stage,
			workdir,
		}) => {
			const s = await setupFor(stage, T.fetchOther);
			const a = await cloneAs(stage, s, workdir, agentToken(stage, "A"), "a");
			await a.runOk([
				"-c",
				"protocol.version=2",
				"fetch",
				"-q",
				"origin",
				s.lanes.B.ref,
			]);
			expect((await a.runOk(["rev-parse", "FETCH_HEAD"])).trim()).toBe(
				s.lanes.B.head,
			);
		},
	);

	test(T.caps, { tags: ["parser"], timeout: 120_000 }, async ({ stage }) => {
		const s = await setupFor(stage, T.caps);
		const reply = await gitHttp(
			stage.origin,
			agentToken(stage, "A"),
			s.repo.path,
			{ kind: "advertisement", service: "git-receive-pack" },
		);
		expect(reply.status).toBe(200);
		const first = reply.text.split("\n").find((l) => l.includes("\0")) ?? "";
		const caps = first.split("\0")[1]?.trim().split(" ").map((c) =>
			c.split("=")[0]
		) ?? [];
		const allow = receivePackAllowlist();
		expect(caps.length, "an advertisement with capabilities").toBeGreaterThan(
			0,
		);
		expect(caps.filter((c) => !allow.includes(c)), "outside the allowlist")
			.toEqual([]);
		expect(caps).not.toContain("push-cert");
		expect(caps).toEqual(
			expect.arrayContaining(["report-status", "side-band-64k"]),
		);
	});

	test(T.parser, { tags: ["parser", "agent"], timeout: 300_000 }, async ({
		stage,
		workdir,
	}) => {
		const s = await setupFor(stage, T.parser);
		const lane = s.lanes.A;
		const token = agentToken(stage, "A");
		const a = await cloneAs(stage, s, workdir, token, "a");
		const head = await a.remoteHead(lane.ref);
		expect(head).not.toBeNull();
		const command = { old: head!, new: FIXTURE_HEAD, ref: lane.ref };
		const post = (body: string, headers?: Record<string, string>) =>
			gitHttp(stage.origin, token, s.repo.path, {
				kind: "post",
				service: "git-receive-pack",
				body,
				...(headers ? { headers } : {}),
			});
		// A content-encoded body: 415, nothing read.
		const gzip = await post("", { "content-encoding": "gzip" });
		expect(gzip.status).toBe(415);
		for (const probe of PARSER_PROBES(command)) {
			const reply = await post(probe.body);
			const refused =
				(reply.status === 400 && /push refused/.test(reply.text)) ||
				(reply.status === 200 && /\bng \S+ /.test(reply.text) &&
					reply.text.includes(R.malformed)) ||
				(reply.status === 400 && reply.text.includes(R.malformed));
			expect(refused, `${probe.name}: HTTP ${reply.status}`).toBe(true);
			expect(reply.text).not.toMatch(/\bok refs\//);
		}
		expect(await a.remoteHead(lane.ref), "lane A did not move").toBe(head);
	});

	test(T.landing, {
		tags: ["containers", "agent", "land"],
		timeout: 900_000,
	}, async ({ stage, workdir }) => {
		test.skip(
			!stage.containers,
			"landing needs CI and the Advance, which run in containers (the stage was deployed with --no-containers)",
		);
		// A Swarm repo with no owners rules or projects: a small change is
		// approved by review on its own and the Weave lands it; while its
		// candidate's checks run, the lane is landing and frozen.
		const index = await sharedStore().claimIndex(
			`claim-s2-${keyOf(T.landing)}`,
		);
		const suite = index === 0 ? "s2-landing" : `s2-landing-${index}`;
		const repo = await fixtureRepo(stage, "swarm", suite);
		const agent = scriptedAgent(stage, PACK_GROUP.swarm, "A");
		const { lane: first } = await agent.mcp.call<{ lane: LaneHandle }>(
			"lanes_open",
			{ repo: repo.path, purpose: "S2 landing freeze" },
		);
		const lane = await agent.awaitOpen(repo.path, first);
		const clone = await agent.clone(workdir, repo.remote);
		await agent.runLane(lane.git.start, clone);
		await writeFile(path.join(clone, "landing.txt"), `${stage.runId}\n`);
		await agent.commit(clone, "S2 landing");
		await agent.runLane(lane.git.push, clone);
		await agent.mcp.call("changes_submit", {
			repo: repo.path,
			laneId: lane.id,
			title: `S2 landing ${stage.runId}`,
			summary: "A one-line file.",
		});
		const owner = tokenApi(stage.origin, tokensOf(stage).ownerPat);
		let state = "";
		await expect.poll(async () => {
			const lanes = ok(
				"GET",
				"/-/api/lanes",
				await owner.get<LanesResponse>(
					`/-/api/lanes?${query({ repo: repo.path })}`,
				),
			).lanes;
			state = lanes.find((l) => l.id === lane.id)?.state ?? "";
			if (state === "landed" || state === "closed") {
				throw new Error(
					`the lane went ${state} before a push could hit the landing window`,
				);
			}
			return state;
		}, {
			timeout: 600_000,
			interval: 500,
			message: "the lane never started landing (review or the Weave held it)",
		}).toBe(LANDING);
		await appendFile(path.join(clone, "landing.txt"), "late\n");
		await agent.commit(clone, "S2 landing (late)");
		const pushed = await agent.gitResult(clone, [
			"push",
			"origin",
			`HEAD:${lane.ref}`,
		]);
		expect(pushed.code).not.toBe(0);
		expect(
			refusedWith(pushed.stdout + pushed.stderr, lane.ref, R.landing),
			pushed.stderr,
		).toBe(true);
	});
});

test.describe("S2-rem: rows that are not on this stage", {
	tags: ["gateway", "s2", "pending"],
}, () => {
	for (
		const row of [
			"lane remote L0: a malformed ref, a reserved parent or a case variant of main on a lane remote",
			"lane remote L1: a push to a lane remote while the lane is opening or closed",
			"lane remote L2: a push to a lane remote while the lane is landing",
			"lane remote L3: the owner updates, forces and leases main of its lane remote; a stale old",
			"lane remote L3: another agent's push to a lane remote is not-your-lane",
			"lane remote L4: deleting main of a lane remote is use-lanes-close",
			"lane remote L5: any other ref of a lane remote is lane-main-only",
			"lane remote: a lane-pinned token on another lane's remote",
			"lane remote: anonymous and roleless clones of a lane remote",
			"lane remote: a lane push is forwarded with a token that cannot write the canonical repo",
		]
	) {
		test(row, {
			tags: ["m2-lanes"],
			skip:
				"pending M2: lane remotes need the repo lane backend (LANE_MODE=import)",
		}, async () => {});
	}
	for (
		const row of [
			"public view: an anonymous want of a hidden SHA (identity and gzip) is ERR",
			"public view: a v2 want-ref is refused and object-info is not advertised",
			"public view: a roleless authenticated caller of a public repo gets the public view",
			"public view: an anonymous clone while an Advance lands between ls-refs and fetch",
		]
	) {
		test(row, {
			tags: ["public-view"],
			skip:
				"pending: the e2e groups stay private (the harness creates no public repo)",
		}, async () => {});
	}
	test("a body over MAX_PUSH_BYTES and a 33 MiB object get their ng", {
		tags: ["size"],
		skip:
			"pending: pushes of 30-95 MB per run; covered by the gateway's own size tests until a size tier exists",
	}, async () => {});
	test("row 6: agent notes under refs/notes/lanes/<id>", {
		tags: ["stretch"],
		skip: "pending: lane notes are a stretch item",
	}, async () => {});
});
