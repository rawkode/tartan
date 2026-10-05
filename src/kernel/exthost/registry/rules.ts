// Install-time rules (K8). Pure: each rule looks at one candidate installation
// and the installations already in force at its node, and returns typed issues.
// The registry turns the first blocking issue into a `TartanError`; the install
// sheet shows warnings.

import {
	extensionToolName,
	type InstallationMode,
	type Manifest,
	manifestPolicyIssues,
	needsOwnerApproval,
	ROLE,
	SHADOWABLE_INTERFACES,
} from "@tartan/contract";
import type { InstallationInForce } from "@tartan/contract/kernel.ts";
import { resolve } from "./resolve.ts";

/** One installation an install request creates (a pack creates several). */
export type InstallCandidate = {
	readonly extId: string;
	readonly version: string;
	readonly manifest: Manifest;
	readonly bundled: boolean;
	readonly mode: "enforce" | "shadow";
	readonly locked: boolean;
	readonly backgroundRole: 10 | 20 | 30 | 40;
	readonly runtimeOverride?: "builtin" | "js" | "wasm";
};

export type InstallTarget = {
	readonly nodeId: string;
	readonly depth: number;
};

export type IssueCode = "invalid" | "conflict";
export type InstallIssue = {
	readonly code: IssueCode;
	readonly rule: string;
	readonly text: string;
};

const issue = (code: IssueCode, rule: string, text: string): InstallIssue => ({
	code,
	rule,
	text,
});

const shadowable: readonly string[] = SHADOWABLE_INTERFACES;

/**
 * Shadow installs are limited to gates and `review@1` routing; a shadow
 * install of a mutating interface (`queue@1`, `work@1`, …) is rejected.
 */
export const shadowIssues = (m: Manifest): InstallIssue[] => {
	const mutating = (m.provides ?? []).filter((p) => !shadowable.includes(p));
	if (mutating.length > 0) {
		return [
			issue(
				"invalid",
				"shadow-mutating",
				`shadow installs of mutating interfaces are rejected: ${
					mutating.join(", ")
				}`,
			),
		];
	}
	const hasGate = (m.gates?.length ?? 0) > 0;
	const routesReview = (m.provides ?? []).includes("review@1");
	return hasGate || routesReview ? [] : [
		issue(
			"invalid",
			"shadow-scope",
			"shadow installs are limited to gates and review@1 routing",
		),
	];
};

/**
 * K8: a gate of an extension enforced at a strict ancestor cannot be
 * shadowed below it. Accumulation already keeps the ancestor gate in force
 * at every descendant (a disabled or shadow copy below changes nothing, see
 * `resolve`); this refuses the attempt explicitly. A shadow install beside
 * the enforce one at the SAME node is the compare-and-promote flow
 * and stays allowed.
 */
export const monotonicGateIssues = (
	extId: string,
	m: Manifest,
	mode: InstallationMode,
	target: Pick<InstallTarget, "nodeId">,
	inForce: readonly InstallationInForce[],
): InstallIssue[] => {
	if (mode !== "shadow" || (m.gates?.length ?? 0) === 0) return [];
	const enforced = inForce.find((i) =>
		i.installation.extId === extId &&
		i.installation.mode === "enforce" &&
		i.installation.nodeId !== target.nodeId &&
		(i.manifest.gates?.length ?? 0) > 0
	);
	return enforced === undefined ? [] : [
		issue(
			"conflict",
			"gate-monotonic",
			`the gates of ${extId} are enforced at ${enforced.installation.nodePath} and cannot be shadowed below it`,
		),
	];
};

/** A locked ancestor (or same-node) provider refuses a nearer provider. */
export const lockedIssues = (
	c: Pick<InstallCandidate, "extId" | "manifest">,
	inForce: readonly InstallationInForce[],
): InstallIssue[] =>
	(c.manifest.provides ?? []).flatMap((iface) => {
		const lock = inForce.find((i) =>
			i.installation.locked && i.installation.mode === "enforce" &&
			(i.manifest.provides ?? []).includes(iface)
		);
		return lock === undefined ? [] : [
			issue(
				"conflict",
				"locked-provider",
				`${iface} is locked to ${lock.installation.extId} at ${lock.installation.nodePath}`,
			),
		];
	});

/** One enforce provider per interface per node (the nearer node replaces). */
export const sameNodeProviderIssues = (
	c: Pick<InstallCandidate, "extId" | "manifest" | "mode">,
	target: InstallTarget,
	inForce: readonly InstallationInForce[],
): InstallIssue[] =>
	c.mode !== "enforce" ? [] : (c.manifest.provides ?? []).flatMap((iface) => {
		const here = inForce.find((i) =>
			i.installation.nodeId === target.nodeId &&
			i.installation.mode === "enforce" &&
			i.installation.extId !== c.extId &&
			(i.manifest.provides ?? []).includes(iface)
		);
		return here === undefined ? [] : [
			issue(
				"conflict",
				"provider-exists",
				`${iface} is already provided at this node by ${here.installation.extId}`,
			),
		];
	});

/** UNIQUE (ext_id, node_id, mode), with a readable message. */
export const duplicateIssues = (
	c: Pick<InstallCandidate, "extId" | "mode">,
	installedHere: readonly { extId: string; mode: InstallationMode }[],
): InstallIssue[] =>
	installedHere.some((i) => i.extId === c.extId && i.mode === c.mode)
		? [
			issue(
				"conflict",
				"duplicate",
				`${c.extId} is already installed at this node in ${c.mode} mode`,
			),
		]
		: [];

/**
 * An install's exposed tool names (`<extshort>_<tool>`) must not
 * collide with tools in force at the node from another extension (kernel
 * and interface names are refused by `manifestPolicyIssues` already).
 */
export const toolCollisionIssues = (
	c: Pick<InstallCandidate, "extId" | "manifest">,
	inForce: readonly InstallationInForce[],
): InstallIssue[] => {
	const mine = (c.manifest.contributes?.tools ?? []).map((t) =>
		extensionToolName(c.extId, t.name)
	);
	if (mine.length === 0) return [];
	const taken = new Map<string, string>();
	for (const i of resolve(inForce).effective) {
		if (i.installation.extId === c.extId) continue;
		for (const t of i.manifest.contributes?.tools ?? []) {
			taken.set(
				extensionToolName(i.installation.extId, t.name),
				i.installation.extId,
			);
		}
	}
	return mine.flatMap((name) => {
		const other = taken.get(name);
		return other === undefined ? [] : [
			issue(
				"conflict",
				"tool-collision",
				`tool ${name} collides with ${other}`,
			),
		];
	});
};

/** `runtimeOverride`. Only `builtin` on a bundled package in v1 M1. */
export const runtimeIssues = (
	c: Pick<InstallCandidate, "bundled" | "manifest" | "runtimeOverride">,
): InstallIssue[] => {
	const o = c.runtimeOverride;
	if (o === undefined || o === c.manifest.runtime) {
		return o === "builtin" && !c.bundled
			? [
				issue(
					"invalid",
					"runtime",
					"runtime builtin is only for bundled packages",
				),
			]
			: [];
	}
	if (o === "builtin") {
		return [
			issue(
				"invalid",
				"runtime",
				"runtime builtin is only for bundled packages",
			),
		];
	}
	return [
		issue(
			"invalid",
			"runtime",
			`runtime override ${o} needs a published ${o} bundle of ${c.manifest.id}`,
		),
	];
};

/** Every blocking rule for one candidate at a node. */
export const candidateIssues = (
	c: InstallCandidate,
	target: InstallTarget,
	inForce: readonly InstallationInForce[],
	installedHere: readonly { extId: string; mode: InstallationMode }[],
): InstallIssue[] => [
	...manifestPolicyIssues(c.manifest, { bundled: c.bundled }).map((text) =>
		issue("invalid", "policy", text)
	),
	...(c.manifest.kind === "pack" ? [] : runtimeIssues(c)),
	...(c.mode === "shadow" ? shadowIssues(c.manifest) : []),
	...(c.mode === "shadow" && c.locked
		? [
			issue(
				"invalid",
				"locked-shadow",
				"only an enforce install can be locked",
			),
		]
		: []),
	...monotonicGateIssues(c.extId, c.manifest, c.mode, target, inForce),
	...(c.mode === "enforce" ? lockedIssues(c, inForce) : []),
	...sameNodeProviderIssues(c, target, inForce),
	...duplicateIssues(c, installedHere),
	...toolCollisionIssues(c, inForce),
];

/** Unresolved `requires` only warn. */
export const requiresWarnings = (
	m: Manifest,
	inForce: readonly InstallationInForce[],
	alsoProvided: readonly string[] = [],
): string[] => {
	const r = resolve(inForce);
	return (m.requires ?? [])
		.filter((iface) =>
			!r.providers.has(iface) && !alsoProvided.includes(iface) &&
			!(m.provides as readonly string[] | undefined ?? []).includes(iface)
		)
		.map((iface) => `requires ${iface}, which has no provider at this node`);
};

/** The role an installer needs at the node: Maintainer, or Owner. */
export const requiredRole = (
	candidates: readonly Pick<
		InstallCandidate,
		"manifest" | "locked" | "backgroundRole"
	>[],
	target: InstallTarget,
): 40 | 50 =>
	candidates.some((c) =>
			needsOwnerApproval(c.manifest, {
				backgroundRole: c.backgroundRole,
				locked: c.locked,
				atRoot: target.depth === 0,
			})
		)
		? ROLE.owner
		: ROLE.maintainer;

/** Human-readable permission lines for the install sheet. */
export const permissionLines = (m: Manifest): string[] => {
	const p = m.permissions;
	const lines: string[] = [];
	if (p.repo === "read") lines.push("reads repository contents and diffs");
	if ((p.land?.length ?? 0) > 0) {
		lines.push(`can land changes into ${p.land!.join(", ")}`);
	}
	if (p["land.report"]) lines.push("reports CI verdicts that gate landing");
	if ((p.lanes?.length ?? 0) > 0) {
		lines.push(`manages lanes: ${p.lanes!.join(", ")}`);
	}
	if ((p.runs?.length ?? 0) > 0) lines.push(`runs jobs: ${p.runs!.join(", ")}`);
	if (p.notes) lines.push("writes git notes");
	if (p.notify) lines.push("notifies members of this subtree");
	if ((p["events.read"]?.length ?? 0) > 0) {
		lines.push(`reads events: ${p["events.read"]!.join(", ")}`);
	}
	if ((p["interfaces.call"]?.length ?? 0) > 0) {
		lines.push(`calls interfaces: ${p["interfaces.call"]!.join(", ")}`);
	}
	if ((p["agents.dispatch"]?.length ?? 0) > 0) {
		lines.push(`dispatches agents: ${p["agents.dispatch"]!.join(", ")}`);
	}
	if (p.ai) lines.push("uses Workers AI");
	for (const g of m.gates ?? []) {
		lines.push(
			g.point === "ref.advance"
				? "can veto advances of trunk"
				: `can veto ${g.point}`,
		);
	}
	if ((m.echo?.length ?? 0) > 0) lines.push("adds lines to push output");
	for (const iface of m.provides ?? []) lines.push(`provides ${iface}`);
	const slots = m.contributes?.slots ?? [];
	if (slots.length > 0) {
		lines.push(
			`adds UI to ${[...new Set(slots.map((s) => s.slot))].join(", ")}`,
		);
	}
	const tools = m.contributes?.tools ?? [];
	if (tools.length > 0) {
		lines.push(
			`adds agent tools: ${
				tools.map((t) => extensionToolName(m.id, t.name)).join(", ")
			}`,
		);
	}
	return lines;
};
