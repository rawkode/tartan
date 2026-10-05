// Provider replacement (WP7a M2): an Owner swaps the provider of one
// single-provider interface at a node in one transaction, for example `queue@1`
// on `acme/platform/router` from the Swarm pack's `tartan.weave` to
// `tartan.fifo`, and back.
//
// The request and answer shapes are the contract's (`api.ts`).
// `planReplacement` is pure: it decides on the installations at the node or an
// ancestor (the registry query, unresolved) what the swap disables, re-enables
// or installs; the registry applies the plan inside its transaction.

import type {
	InstallationDto,
	InstallationMode,
	Manifest,
} from "@tartan/contract";
import type { InstallationInForce } from "@tartan/contract/kernel.ts";
import { providerOf } from "./resolve.ts";

export type ReplacementPlan =
	| { readonly kind: "noop"; readonly current: InstallationInForce }
	| {
		readonly kind: "swap";
		readonly current: InstallationInForce | null;
		/** The node's own provider, disabled by the swap. */
		readonly disable: InstallationInForce | null;
		/** What provides `iface` afterwards. */
		readonly then:
			| { readonly kind: "inherit"; readonly provider: InstallationInForce }
			| { readonly kind: "enable"; readonly installation: InstallationDto }
			| { readonly kind: "install" };
	};

export type PlanIssue = {
	readonly code: "invalid" | "conflict";
	readonly rule: string;
	readonly text: string;
};

/** A row of the target extension at the node itself, any mode (`installations` table). */
export type HereRow = {
	readonly installation: InstallationDto;
	readonly mode: InstallationMode;
};

/**
 * Decides a swap. `inForce` is every non-disabled installation at the node
 * or an ancestor; `here` every installation of `extId` at the node itself,
 * disabled ones included.
 */
export const planReplacement = (
	input: {
		readonly nodeId: string;
		readonly iface: string;
		readonly extId: string;
		readonly version: string;
		readonly manifest: Manifest;
	},
	inForce: readonly InstallationInForce[],
	here: readonly HereRow[],
): { ok: true; plan: ReplacementPlan } | { ok: false; issue: PlanIssue } => {
	const fail = (code: PlanIssue["code"], rule: string, text: string) => ({
		ok: false as const,
		issue: { code, rule, text },
	});
	if (input.manifest.kind !== "extension") {
		return fail("invalid", "not-extension", `${input.extId} is a pack`);
	}
	if (!(input.manifest.provides ?? []).includes(input.iface as never)) {
		return fail(
			"invalid",
			"not-provider",
			`${input.extId}@${input.version} does not provide ${input.iface}`,
		);
	}
	const current = providerOf(input.iface, inForce);
	if (current?.installation.extId === input.extId) {
		return { ok: true, plan: { kind: "noop", current } };
	}
	if (current?.installation.locked) {
		return fail(
			"conflict",
			"locked-provider",
			`${input.iface} is locked to ${current.installation.extId} at ${current.installation.nodePath}`,
		);
	}
	let disable: InstallationInForce | null = null;
	if (current !== null && current.installation.nodeId === input.nodeId) {
		const others = (current.manifest.provides ?? []).filter((p) =>
			p !== input.iface
		);
		if (others.length > 0) {
			return fail(
				"conflict",
				"provides-more",
				`${current.installation.extId} also provides ${
					others.join(", ")
				} here; disable it explicitly`,
			);
		}
		disable = current;
	}
	const after = disable === null
		? inForce
		: inForce.filter((i) => i.installation.id !== disable!.installation.id);
	const inherited = providerOf(input.iface, after);
	if (inherited?.installation.extId === input.extId) {
		return {
			ok: true,
			plan: {
				kind: "swap",
				current,
				disable,
				then: { kind: "inherit", provider: inherited },
			},
		};
	}
	if (inherited?.installation.locked) {
		return fail(
			"conflict",
			"locked-provider",
			`${input.iface} is locked to ${inherited.installation.extId} at ${inherited.installation.nodePath}`,
		);
	}
	const enforced = here.find((r) => r.mode === "enforce");
	if (enforced !== undefined) {
		return fail(
			"conflict",
			"not-in-force",
			`${input.extId} is installed here (${enforced.installation.id}) but does not provide ${input.iface}`,
		);
	}
	const disabled = here.find((r) => r.mode === "disabled");
	if (disabled !== undefined) {
		if (disabled.installation.version !== input.version) {
			return fail(
				"conflict",
				"version",
				`${input.extId}@${disabled.installation.version} is installed here (disabled); re-enable or uninstall it first`,
			);
		}
		return {
			ok: true,
			plan: {
				kind: "swap",
				current,
				disable,
				then: { kind: "enable", installation: disabled.installation },
			},
		};
	}
	return {
		ok: true,
		plan: { kind: "swap", current, disable, then: { kind: "install" } },
	};
};
