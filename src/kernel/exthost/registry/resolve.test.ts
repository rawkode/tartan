// Pure resolution (K8) and install rules on hand-built `InstallationInForce`
// lists.

import { deepStrictEqual, equal } from "node:assert/strict";
import { type InstallationDto, parseManifest } from "@tartan/contract";
import type { InstallationInForce } from "@tartan/contract/kernel.ts";
import { planReplacement } from "./replace.ts";
import { acting, gatesOnly, providerOf, resolve } from "./resolve.ts";
import {
	monotonicGateIssues,
	permissionLines,
	requiredRole,
	shadowIssues,
} from "./rules.ts";
import { manifest } from "./test/fakes.ts";

let seq = 0;
const inst = (
	extId: string,
	depth: number,
	extra: Partial<InstallationDto> = {},
	m: Record<string, unknown> = {},
): InstallationInForce => {
	const parsed = parseManifest(manifest(extId, m));
	if (!parsed.ok) throw new Error(parsed.errors.join("; "));
	seq += 1;
	return {
		depth,
		manifest: parsed.manifest,
		installation: {
			id: `i_${seq}`,
			extId,
			version: "0.1.0",
			nodeId: `n${depth}`,
			nodePath: ["a", "a/b", "a/b/c"][depth],
			mode: "enforce",
			storageScope: "repo",
			config: {},
			grants: {} as InstallationDto["grants"],
			backgroundRole: 20,
			locked: false,
			backfill: "none",
			installedBy: "u_x",
			installedAt: seq,
			...extra,
		},
	};
};

const queue = {
	provides: ["queue@1"],
	permissions: { land: ["refs/heads/main"] },
};

Deno.test("resolve: nearest wins; the farthest locked provider wins over nearer ones", () => {
	const root = inst("tartan.weave", 0, {}, queue);
	const mid = inst("tartan.fifo", 1, {}, queue);
	equal(providerOf("queue@1", [root, mid])?.installation.extId, "tartan.fifo");
	const lockedRoot = inst("tartan.weave", 0, { locked: true }, queue);
	const lockedMid = inst("tartan.fifo", 1, { locked: true }, queue);
	const leaf = inst("tartan.other", 2, {}, queue);
	equal(
		providerOf("queue@1", [leaf, lockedMid, lockedRoot])?.installation.id,
		lockedRoot.installation.id,
	);
	// Shadow and disabled installations never provide.
	equal(
		providerOf("queue@1", [inst("tartan.fifo", 2, { mode: "shadow" }, queue)]),
		null,
	);
});

Deno.test("resolve: same extension nearer overrides; replaced providers drop out; gates accumulate", () => {
	const boardRoot = inst("tartan.board", 0);
	const boardMid = inst("tartan.board", 1);
	const weave = inst("tartan.weave", 0, {}, {
		...queue,
		gates: [{ point: "ref.advance" }],
	});
	const fifo = inst("tartan.fifo", 1, {}, queue);
	const r = resolve([boardRoot, weave, boardMid, fifo]);
	// Nearest first; at equal depth the most recent install first.
	deepStrictEqual(r.effective.map((i) => i.installation.id), [
		fifo.installation.id,
		boardMid.installation.id,
	]);
	// The replaced weave's gate still applies (K8).
	deepStrictEqual(r.gates.map((i) => i.installation.id), [
		weave.installation.id,
	]);
	equal(r.providers.get("queue@1")?.installation.id, fifo.installation.id);
});

Deno.test("rules: shadow scope, monotonic gates, roles and sheet lines", () => {
	const m = (extra: Record<string, unknown>) => {
		const p = parseManifest(manifest("tartan.x", extra));
		if (!p.ok) throw new Error(p.errors.join(";"));
		return p.manifest;
	};
	equal(shadowIssues(m(queue))[0].rule, "shadow-mutating");
	equal(shadowIssues(m({}))[0].rule, "shadow-scope");
	deepStrictEqual(shadowIssues(m({ gates: [{ point: "push" }] })), []);
	deepStrictEqual(shadowIssues(m({ provides: ["review@1"] })), []);
	const gate = inst("tartan.x", 0, {}, { gates: [{ point: "ref.advance" }] });
	const gm = gate.manifest;
	equal(
		monotonicGateIssues("tartan.x", gm, "shadow", { nodeId: "n1" }, [gate])
			.length,
		1,
	);
	equal(
		monotonicGateIssues("tartan.x", gm, "shadow", { nodeId: "n0" }, [gate])
			.length,
		0,
	);
	equal(
		monotonicGateIssues("tartan.x", gm, "enforce", { nodeId: "n1" }, [gate])
			.length,
		0,
	);
	equal(
		requiredRole([{ manifest: m({}), locked: false, backgroundRole: 20 }], {
			nodeId: "n",
			depth: 1,
		}),
		40,
	);
	equal(
		requiredRole([{ manifest: m({}), locked: false, backgroundRole: 20 }], {
			nodeId: "n",
			depth: 0,
		}),
		50,
	);
	equal(
		requiredRole([{
			manifest: m({ provides: ["checks@1"] }),
			locked: false,
			backgroundRole: 20,
		}], { nodeId: "n", depth: 2 }),
		50,
	);
	deepStrictEqual(
		permissionLines(m({ ...queue, gates: [{ point: "ref.advance" }] })),
		[
			"can land changes into refs/heads/main",
			"can veto advances of trunk",
			"provides queue@1",
		],
	);
});

const packRow = (extId: string, depth: number): InstallationInForce =>
	inst(extId, depth, { pack: extId }, {
		kind: "pack",
		storage: { scope: "node" },
		members: [{ id: "tartan.x", version: "0.1.0" }],
	});

Deno.test("resolve: a nearer pack masks a farther pack's members, never their gates (K8)", () => {
	const swarm = packRow("tartan.pack.swarm", 0);
	const radar = inst("tartan.radar", 0, { pack: "tartan.pack.swarm" }, {
		provides: ["conflicts@1"],
		subscribe: [{ event: "push.diffed" }],
	});
	const weave = inst("tartan.weave", 0, { pack: "tartan.pack.swarm" }, queue);
	const review = inst("tartan.review", 0, { pack: "tartan.pack.swarm" }, {
		provides: ["review@1"],
		gates: [{ point: "ref.advance" }],
		subscribe: [{ event: "changes.submitted" }],
	});
	const guard = inst("tartan.guard", 0, {}, {
		gates: [{ point: "ref.advance" }],
		subscribe: [{ event: "push.accepted" }],
	});
	const classic = packRow("tartan.pack.classic", 1);
	const fifo = inst("tartan.fifo", 1, { pack: "tartan.pack.classic" }, queue);
	const all = [swarm, radar, weave, review, guard, classic, fifo];
	const r = resolve(all);
	equal(r.providers.get("queue@1")?.installation.id, fifo.installation.id);
	equal(r.providers.has("conflicts@1"), false);
	equal(r.providers.has("review@1"), false);
	deepStrictEqual(
		r.masked.map((i) => i.installation.extId).sort(),
		["tartan.pack.swarm", "tartan.radar", "tartan.review", "tartan.weave"],
	);
	// The standalone guard is not masked: it stays effective.
	deepStrictEqual(
		r.effective.map((i) => i.installation.extId).sort(),
		["tartan.fifo", "tartan.guard", "tartan.pack.classic"],
	);
	deepStrictEqual(
		r.gates.map((i) => i.installation.extId).sort(),
		["tartan.guard", "tartan.review"],
	);
	// What acts: the effective ones as they are, the masked review reduced
	// to its gate.
	const a = acting(all);
	deepStrictEqual(
		a.map((i) => i.installation.extId).sort(),
		["tartan.fifo", "tartan.guard", "tartan.pack.classic", "tartan.review"],
	);
	const gateOnly = a.find((i) => i.installation.extId === "tartan.review")!;
	deepStrictEqual(gateOnly.manifest.gates, review.manifest.gates);
	equal(gateOnly.manifest.subscribe, undefined);
	equal(gateOnly.manifest.provides, undefined);
	equal(gateOnly.manifest.id, "tartan.review");
	// The guard keeps its subscription.
	equal(
		a.find((i) => i.installation.extId === "tartan.guard")?.manifest.subscribe
			?.length,
		1,
	);
	// Without the nearer pack nothing is masked.
	deepStrictEqual(resolve([swarm, radar, weave, review]).masked, []);
	// `acting` is stable under a second resolution (consumers resolve again).
	equal(
		resolve(a).providers.get("queue@1")?.installation.id,
		fifo.installation.id,
	);
});

Deno.test("gatesOnly keeps the gate inputs and drops every other surface", () => {
	const m = inst("tartan.scan", 0, {}, {
		gates: [{ point: "ref.advance" }],
		inputs: ["added-lines"],
		echo: [{ event: "push.accepted" }],
		contributes: {
			slots: [{ slot: "repo.tab", id: "scan", label: "Scan", route: "scan" }],
		},
	}).manifest;
	const g = gatesOnly(m);
	deepStrictEqual(g.gates, m.gates);
	deepStrictEqual(g.inputs, ["added-lines"]);
	equal(g.echo, undefined);
	equal(g.contributes, undefined);
});

Deno.test("planReplacement: the node's provider must provide only the swapped interface", () => {
	const combo = inst("tartan.combo", 1, { nodeId: "n1" }, {
		provides: ["queue@1", "checks@1"],
		permissions: { land: ["refs/heads/main"] },
	});
	const fifo = inst("tartan.fifo", 0, {}, queue);
	const input = {
		nodeId: "n1",
		iface: "queue@1",
		extId: "tartan.fifo",
		version: "0.1.0",
		manifest: fifo.manifest,
	};
	const out = planReplacement(input, [combo, fifo], []);
	equal(out.ok, false);
	if (!out.ok) equal(out.issue.rule, "provides-more");
	// A disabled installation of the target here at another version blocks.
	const weave = inst("tartan.weave", 1, { nodeId: "n1" }, queue);
	const v = planReplacement(input, [weave], [{
		installation: { ...fifo.installation, version: "0.0.9" },
		mode: "disabled",
	}]);
	equal(v.ok, false);
	if (!v.ok) equal(v.issue.rule, "version");
});
