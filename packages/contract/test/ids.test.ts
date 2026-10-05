// ULIDs, name builders, refs and capability paths.

import { deepStrictEqual, equal, ok, throws } from "node:assert/strict";
import {
	advanceId,
	agentId,
	ARTIFACTS_NAME_RE,
	ARTIFACTS_NAMESPACE_RE,
	batchId,
	candidateRef,
	CAP_PATH_RE,
	capMacInput,
	capPath,
	changeIdFromBytes,
	changeRef,
	createUlid,
	dynamicWorkerId,
	extDoName,
	extPrincipalId,
	FORGE_DO_NAME,
	gitSandboxName,
	HIDDEN_REF_PREFIXES,
	inboxDoName,
	installationId,
	isChangeId,
	isHiddenRef,
	isKernelRef,
	isPrincipalId,
	isReservedParent,
	isReservedRef,
	isReservedRootSlug,
	isUlid,
	isValidRefName,
	isValidSlug,
	isWorkflowId,
	jobEventType,
	jobSandboxName,
	k5FreeEventType,
	LAND_STEPS,
	landInstanceId,
	landStepName,
	laneArtifactsName,
	laneBranchRef,
	laneId,
	laneIdFromBranchRef,
	laneLocalBranch,
	parseAdvanceId,
	parseArtifactsName,
	parseCapPath,
	parseId,
	pathPrefixes,
	principalKind,
	repoArtifactsName,
	repoDoName,
	RESERVED_REF_PARENTS,
	RESERVED_REF_PREFIXES,
	runInstanceId,
	sanitizeJobId,
	stageName,
	swarmCohortInstanceId,
	swarmInstanceId,
	tokenKind,
	ULID_ALPHABET,
	ulidTime,
	userId,
	verdictEventType,
	workRefs,
	ZERO_SHA,
} from "../src/ids.ts";

const fixedRandom = (byte: number) => (n: number) =>
	new Uint8Array(n).fill(byte);

Deno.test("ulid: 26 lowercase Crockford chars, decodable time", () => {
	const gen = createUlid({ now: () => 1_790_000_000_123 });
	const id = gen();
	equal(id.length, 26);
	ok(isUlid(id), id);
	ok([...id].every((c) => ULID_ALPHABET.includes(c)));
	equal(id, id.toLowerCase());
	ok(!/[ilou]/.test(id), "no I, L, O, U");
	equal(ulidTime(id), 1_790_000_000_123);
	equal(createUlid({ now: () => 0, random: fixedRandom(0) })(), "0".repeat(26));
	equal(
		createUlid({ now: () => 281474976710655, random: fixedRandom(255) })(),
		"7zzzzzzzzzzzzzzzzzzzzzzzzz",
	);
});

Deno.test("ulid: monotonic within one millisecond and across clock regressions", () => {
	let now = 1_790_000_000_000;
	const gen = createUlid({ now: () => now });
	const ids: string[] = [];
	for (let i = 0; i < 2000; i++) ids.push(gen());
	now -= 5_000; // clock steps backwards
	for (let i = 0; i < 100; i++) ids.push(gen());
	now += 60_000;
	for (let i = 0; i < 100; i++) ids.push(gen());
	for (let i = 1; i < ids.length; i++) {
		ok(
			ids[i - 1] < ids[i],
			`not increasing at ${i}: ${ids[i - 1]} >= ${ids[i]}`,
		);
	}
	equal(new Set(ids).size, ids.length);
	equal(
		ulidTime(ids[2050]),
		1_790_000_000_000,
		"regression keeps the last time",
	);
	equal(ulidTime(ids[ids.length - 1]), 1_790_000_055_000);
});

Deno.test("ulid: increments carry and overflow is an error", () => {
	const gen = createUlid({ now: () => 1000, random: fixedRandom(31) });
	const first = gen();
	equal(first.slice(10), "z".repeat(16));
	throws(() => gen(), /overflow/);
	const carry = createUlid({
		now: () => 1000,
		random: (n) =>
			new Uint8Array(n).fill(0).map((_, i) => i === n - 1 ? 31 : 0),
	});
	const a = carry();
	const b = carry();
	equal(a.slice(10), "000000000000000z");
	equal(b.slice(10), "0000000000000010");
});

Deno.test("ulid: deterministic with injected clock and random; rejects bad time", () => {
	const make = () =>
		createUlid({ now: () => 1234567890123, random: fixedRandom(7) });
	equal(make()(), make()());
	throws(() => createUlid({ now: () => -1 })(), /out of range/);
	throws(() => createUlid({ now: () => 2 ** 48 })(), /out of range/);
	throws(() => createUlid({ now: () => 1.5 })(), /out of range/);
	equal(isUlid("01K6AAAAAAAAAAAAAAAAAAAAAA"), false, "uppercase is not ours");
	equal(isUlid("81k6aaaaaaaaaaaaaaaaaaaaaa"), false, "time overflow");
	equal(isUlid("01k6aaaaaaaaaaaaaaaaaaaaal"), false, "no l");
});

const U = createUlid({ now: () => 1_790_000_000_000 });

Deno.test("names: canonical and lane repo names", () => {
	const repo = U();
	const lane = U();
	const r = repoArtifactsName(repo);
	const l1 = laneArtifactsName(repo, lane);
	equal(r, `r-${repo}`);
	equal(r.length, 28);
	equal(l1, `l-${repo}-${lane}`);
	equal(l1.length, 55);
	equal(laneArtifactsName(repo, lane, 1), l1);
	for (let n = 2; n <= 9; n++) {
		const ln = laneArtifactsName(repo, lane, n);
		equal(ln, `l-${repo}-${lane}-${n}`);
		equal(ln.length, 57);
		ok(ARTIFACTS_NAME_RE.test(ln), ln);
		deepStrictEqual(parseArtifactsName(ln), {
			kind: "lane",
			repoUlid: repo,
			laneUlid: lane,
			attempt: n,
		});
	}
	for (const bad of [0, 10, -1, 1.5]) {
		throws(() => laneArtifactsName(repo, lane, bad), /attempt/, String(bad));
	}
	throws(() => laneArtifactsName(repo, "not-a-ulid"));
	ok(ARTIFACTS_NAME_RE.test(r) && ARTIFACTS_NAME_RE.test(l1));
	ok(/^[a-z0-9-]+$/.test(r) && /^[a-z0-9-]+$/.test(l1), "Artifacts charset");
	deepStrictEqual(parseArtifactsName(r), { kind: "repo", repoUlid: repo });
	deepStrictEqual(parseArtifactsName(l1), {
		kind: "lane",
		repoUlid: repo,
		laneUlid: lane,
		attempt: 1,
	});
	// Names fold case [E A2]: an uppercase name from an event parses the same.
	deepStrictEqual(
		parseArtifactsName(l1.toUpperCase()),
		parseArtifactsName(l1),
	);
	deepStrictEqual(parseArtifactsName(r.toUpperCase()), {
		kind: "repo",
		repoUlid: repo,
	});
	for (
		const bad of [
			`l-${lane}`, // the v0.1 28-char lane name
			`${l1}-0`,
			`${l1}-1`,
			`${l1}-10`,
			`l-${repo}`,
			`l-${repo}-${lane}-`,
			`x-${repo}`,
			"r-nope",
		]
	) {
		equal(parseArtifactsName(bad), null, bad);
		equal(ARTIFACTS_NAME_RE.test(bad), false, bad);
	}
	throws(() => repoArtifactsName("not-a-ulid"));
	equal(stageName(), "tartan");
	equal(stageName("dev"), "tartan-dev");
	equal(stageName("dev-wp04"), "tartan-dev-wp04");
	ok(ARTIFACTS_NAMESPACE_RE.test(stageName("dev-wp04")));
	throws(() => stageName("Dev"));
	throws(() => stageName("dev-"));
	throws(() => stageName("x".repeat(60)));
});

Deno.test("names: Workflow instance ids match ^[a-zA-Z0-9_][a-zA-Z0-9-_]*$ and ≤ 100", () => {
	const repo = U();
	const run = U();
	const batch = U();
	const swarm = U();
	const ids = [
		runInstanceId(repo, run),
		landInstanceId(repo, batch),
		landInstanceId(repo, batchId(batch)),
		swarmInstanceId(swarm),
		swarmCohortInstanceId(swarm, 3),
		swarmCohortInstanceId(swarm, 123),
	];
	for (const id of ids) {
		ok(isWorkflowId(id), id);
		ok(/^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/.test(id) && id.length <= 100, id);
	}
	equal(runInstanceId(repo, run).length, 57);
	equal(landInstanceId(repo, batch).length, 58);
	equal(landInstanceId(repo, batch), landInstanceId(repo, batchId(batch)));
	equal(swarmCohortInstanceId(swarm, 3), `swarm-${swarm}-c03`);
	throws(() => runInstanceId("x", run));
	equal(isWorkflowId("-leading-dash"), false);
	equal(isWorkflowId("a".repeat(101)), false);
});

Deno.test("names: waitForEvent types and loop step names carry attempt/iteration", () => {
	equal(jobEventType("test-api", 1), "job-test-api-a1");
	equal(jobEventType("Test API/Unit", 2), "job-test-api-unit-a2");
	ok(jobEventType("x".repeat(500), 3).length <= 100);
	equal(sanitizeJobId("--"), "job");
	equal(verdictEventType(2), "verdict-2");
	equal(k5FreeEventType(4), "k5-free-4");
	throws(() => verdictEventType(0));
	deepStrictEqual(
		LAND_STEPS.map((s) => landStepName(s, 2)),
		[
			"compose-2",
			"gate-2",
			"test-2",
			"lock-2",
			"restack-2",
			"push-trunk-2",
			"push-notes-2",
			"push-refs-2",
			"complete-2",
		],
	);
	equal(landStepName("k5-wait", 1, 3), "k5-wait-1-3");
	equal(landStepName("poll", 2, 7), "poll-2-7");
	throws(() => landStepName("poll", 1));
});

Deno.test("names: DO names", () => {
	const repo = U();
	const inst = installationId(U());
	equal(FORGE_DO_NAME, "forge");
	equal(repoDoName(repo), `repo:${repo}`);
	equal(inboxDoName(agentId(U())).startsWith("inbox:a_"), true);
	throws(() => inboxDoName("bob"));
	equal(extDoName(inst, { kind: "node" }), `ext:${inst}:node`);
	equal(
		extDoName(inst, { kind: "repo", repoId: repo }),
		`ext:${inst}:repo:${repo}`,
	);
	throws(() => extDoName("weave", { kind: "node" }));
	equal(jobSandboxName(repo), `job:${repo}`);
	equal(gitSandboxName(repo), `git:${repo}`);
	for (
		const name of [
			repoDoName(repo),
			extDoName(inst, { kind: "repo", repoId: repo }),
		]
	) {
		ok(new TextEncoder().encode(name).length <= 1024);
	}
	const dw = dynamicWorkerId("acme.no-secrets", "0.1.0", "ab".repeat(32), inst);
	equal(dw, `x:acme.no-secrets@0.1.0#${"ab".repeat(8)}:${inst}`);
});

Deno.test("ids: prefixed ids, principals, advances, change ids", () => {
	const u = U();
	equal(userId(u), `u_${u}`);
	equal(parseId("user", userId(u)), u);
	equal(parseId("agent", userId(u)), null);
	const inst = installationId(u);
	equal(extPrincipalId(inst), `x_i_${u}`);
	equal(parseId("ext", `x_i_${u}`), u);
	ok(
		isPrincipalId(`x_i_${u}`) && isPrincipalId("sys_kernel") &&
			isPrincipalId(agentId(u)),
	);
	equal(isPrincipalId(`z_${u}`), false);
	equal(principalKind(`x_i_${u}`), "ext");
	equal(principalKind("sys_kernel"), "system");
	equal(laneId(u), `ln_${u}`);
	equal(advanceId(batchId(u), 2), `adv_${u}_2`);
	deepStrictEqual(parseAdvanceId(`adv_${u}_2`), { batchUlid: u, attempt: 2 });
	const change = changeIdFromBytes(new Uint8Array(16).map((_, i) => i * 17));
	ok(isChangeId(change), change);
	equal(change.length, 32);
	equal(changeIdFromBytes(new Uint8Array(16)), "z".repeat(32));
	equal(tokenKind(`tagt_${"a".repeat(43)}`), "agent");
	equal(tokenKind(`tpat_${"a".repeat(43)}`), "pat");
	equal(tokenKind(`tpat_${"a".repeat(42)}`), null);
});

Deno.test("refs: kernel ref constants and builders", () => {
	const batch = U();
	equal(candidateRef(batchId(batch)), `refs/tartan/candidates/${batch}`);
	equal(candidateRef(batch), `refs/tartan/candidates/${batch}`);
	const change = "zkqv".repeat(8);
	equal(changeRef(change), `refs/tartan/changes/${change}`);
	const lane = laneId(U());
	equal(laneBranchRef(lane), `refs/heads/lanes/${lane}`);
	equal(laneLocalBranch(lane), `lanes/${lane}`);
	equal(laneIdFromBranchRef(laneBranchRef(lane)), lane);
	for (
		const notLane of [
			`refs/heads/lanes/${lane.toUpperCase()}`,
			`refs/heads/lanes/${lane}/x`,
			"refs/heads/lanes/ln_nope",
			`refs/heads/Lanes/${lane}`,
			"refs/heads/main",
		]
	) {
		equal(laneIdFromBranchRef(notLane), null, notLane);
	}
	const w = workRefs(batchId(batch));
	equal(w.trunk, `refs/tartan-work/${batch}/trunk`);
	equal(w.lane(2), `refs/tartan-work/${batch}/lane-2`);
	equal(ZERO_SHA.length, 40);
	for (
		const ref of [
			candidateRef(batch),
			changeRef(change),
			laneBranchRef(lane),
			w.tip,
			"refs/notes/tartan",
		]
	) {
		ok(isValidRefName(ref), ref);
	}
	for (
		const bad of [
			"main",
			"refs/heads/a..b",
			"refs/heads/x.lock",
			"refs/heads/.x",
			"refs/heads/a b",
			"refs/heads/a~1",
			"refs/heads/",
			"refs/heads/a@{1}",
			"refs//x",
		]
	) {
		equal(isValidRefName(bad), false, bad);
	}
});

Deno.test("hierarchy: slugs and path prefixes", () => {
	ok(isValidSlug("acme") && isValidSlug("edge-1") && isValidSlug("0x"));
	equal(isValidSlug("-x"), false);
	equal(isValidSlug("Acme"), false);
	equal(isValidSlug("x".repeat(65)), false);
	ok(isReservedRootSlug("api") && isReservedRootSlug("-"));
	deepStrictEqual(pathPrefixes("acme/platform/edge/router"), [
		"acme",
		"acme/platform",
		"acme/platform/edge",
		"acme/platform/edge/router",
	]);
});

Deno.test("refs: hidden, reserved and kernel-only namespaces", () => {
	const lane = laneId(U());
	deepStrictEqual([...HIDDEN_REF_PREFIXES], [
		"refs/heads/lanes/",
		"refs/notes/lanes/",
		"refs/tartan/",
	]);
	for (const p of HIDDEN_REF_PREFIXES) {
		ok(RESERVED_REF_PREFIXES.includes(p), p);
	}
	ok(isHiddenRef(laneBranchRef(lane)));
	ok(isHiddenRef(`refs/notes/lanes/${lane}/ai`));
	equal(isHiddenRef("refs/heads/main"), false);
	equal(isHiddenRef("refs/notes/tartan"), false, "visible: the Q4 beat");
	for (
		const ref of [
			"refs/notes/tartan",
			"refs/notes/tartan/x",
			"refs/heads/tartan/x",
			"refs/tartan-work/b/trunk",
			"refs/tartan/changes/x",
			laneBranchRef(lane),
		]
	) {
		ok(isReservedRef(ref), ref);
	}
	equal(isReservedRef("refs/notes/tartanx"), false);
	equal(isReservedRef("refs/heads/feat"), false);
	deepStrictEqual([...RESERVED_REF_PARENTS], [
		"refs/heads/lanes",
		"refs/heads/tartan",
		"refs/notes/lanes",
		"refs/tartan",
		"refs/tartan-work",
	]);
	ok(RESERVED_REF_PARENTS.every(isReservedParent));
	equal(isReservedParent("refs/heads/lanes/x"), false);
	// isKernelRef has no fallback flag: refs/heads/tartan/ is always kernel-only.
	for (
		const ref of [
			"refs/notes/tartan",
			"refs/notes/tartan/sub",
			"refs/tartan/attic/ln_x",
			"refs/heads/tartan/x",
			"refs/tartan-work/b/tip",
		]
	) {
		ok(isKernelRef(ref), ref);
	}
	for (const ref of ["refs/heads/main", laneBranchRef(lane), "refs/tags/v1"]) {
		equal(isKernelRef(ref), false, ref);
	}
	equal(isKernelRef.length, 1, "no fallbackActive parameter");
});

Deno.test("capability paths: v1 round trip, MAC input over every segment", () => {
	const repoId = U();
	const lane = laneId(U());
	const fields = {
		exp: 1_790_000_120,
		laneId: lane,
		nonce: "0123456789abcdef0123456789abcdef",
		repoId,
	};
	const mac = "ab".repeat(32);
	const path = capPath({ ...fields, mac });
	equal(
		path,
		`/-/cap/v1/1790000120/${lane}/${fields.nonce}/${mac}/${repoId}.git`,
	);
	for (const op of ["info/refs", "git-upload-pack"] as const) {
		ok(CAP_PATH_RE.test(`${path}/${op}`), op);
		deepStrictEqual(parseCapPath(`${path}/${op}`), { ...fields, mac, op });
	}
	equal(
		capMacInput(fields),
		`v1|1790000120|${lane}|${fields.nonce}|${repoId}`,
	);
	// Every segment is in the MAC input: changing any one changes it.
	const base = capMacInput(fields);
	for (
		const changed of [
			{ ...fields, exp: fields.exp + 1 },
			{ ...fields, laneId: laneId(U()) },
			{ ...fields, nonce: "f".repeat(32) },
			{ ...fields, repoId: U() },
		]
	) {
		ok(capMacInput(changed) !== base);
	}
	for (
		const bad of [
			`${path}/git-receive-pack`,
			`${path}/HEAD`,
			path,
			path.replace("/v1/", "/v2/") + "/info/refs",
			path.replace("/v1/", "/") + "/info/refs",
			path.replace(lane, lane.toUpperCase()) + "/info/refs",
			path.replace(mac, mac.slice(2)) + "/info/refs",
			path.replace(mac, mac.toUpperCase()) + "/info/refs",
			path.replace(fields.nonce, fields.nonce.slice(1)) + "/info/refs",
			path.replace("1790000120", "179000012") + "/info/refs",
			path.replace(repoId, `r-${repoId}`) + "/info/refs",
			`${path}/info/refs?x=1`,
		]
	) {
		equal(parseCapPath(bad), null, bad);
	}
	throws(() => capPath({ ...fields, mac: "short" }), /mac/);
	throws(() => capPath({ ...fields, exp: 123, mac }), /exp/);
	throws(() => capMacInput({ ...fields, laneId: "ln_nope" }), /lane/);
	throws(() => capMacInput({ ...fields, nonce: "XYZ" }), /nonce/);
	throws(() => capMacInput({ ...fields, repoId: "nope" }), /repo id/);
});
