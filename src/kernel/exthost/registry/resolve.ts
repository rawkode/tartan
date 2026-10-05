// Installation resolution at a node (K8). Pure: it takes the installations in
// force at the node (every non-disabled installation at the node or an
// ancestor, nearest first) and decides
//
// - **providers**: for each single-provider interface, the nearest `enforce`
//   provider wins, unless an ancestor provider of it is `locked`, in which
//   case the farthest locked one wins (a nearer lock below it is refused at
//   install time, so there is at most one in practice);
// - **masked** installations: the nearest pack defines a subtree's
//   protocol. Every installation a pack created (the pack row and its
//   members) at a node farther than the nearest pack installation is
//   masked: a Classic pack on `acme/docs` under a Swarm pack on `acme` keeps
//   the Swarm pack's radar, Weave and by-exception review out of
//   `acme/docs` (no radar notices, no second queue), not only the members
//   Classic happens to replace. Installations outside any pack (a FIFO
//   installed alone on one repo, a third-party gate) are never masked;
// - **effective** installations (slots, tools, subscriptions, context,
//   protocol cards, settings): the nearest installation of each extension id
//   and mode (a nearer install of the same extension overrides an ancestor's
//   config), minus masked ones and `enforce` installations whose every
//   provided interface is now served by another installation (they were
//   replaced, e.g. a FIFO installed on a repo replaces the Weave its group's
//   Swarm pack provides). Shadow installations stay effective: a shadow
//   `review@1` provider receives the same events as the live one;
// - **gates**: every installation in force that declares a gate, at any
//   depth and in either mode, masked or replaced or not, never
//   de-duplicated. A gate installed at an ancestor applies to every
//   descendant and nothing below can disable, remove or shadow it (K8,
//   monotonic like roles).
//
// `acting` is what the registry answers as "in force" to the event
// subscribers, dispatchers and cron: the effective installations, then each
// other gate holder reduced to its gates.

import type { Manifest } from "@tartan/contract";
import type {
	ContributionKind,
	InstallationInForce,
} from "@tartan/contract/kernel.ts";

export type Resolution = {
	/** Interface → the provider in force (enforce mode only). */
	readonly providers: ReadonlyMap<string, InstallationInForce>;
	/** Interface → shadow providers in force (only `review@1` can have them). */
	readonly shadowProviders: ReadonlyMap<string, readonly InstallationInForce[]>;
	/** Installations whose non-gate contributions apply here, nearest first. */
	readonly effective: readonly InstallationInForce[];
	/** Installations whose gates apply here (monotonic, K8), nearest first. */
	readonly gates: readonly InstallationInForce[];
	/** Pack installations a nearer pack masks here, nearest first. */
	readonly masked: readonly InstallationInForce[];
};

/** Nearest first; at equal depth the most recent install first. */
export const byNearest = (
	a: InstallationInForce,
	b: InstallationInForce,
): number =>
	b.depth - a.depth ||
	b.installation.installedAt - a.installation.installedAt ||
	(a.installation.id < b.installation.id ? -1 : 1);

const provides = (i: InstallationInForce): readonly string[] =>
	i.manifest.provides ?? [];

const isPackRow = (i: InstallationInForce): boolean =>
	i.manifest.kind === "pack";

/**
 * The depth of the nearest pack installation in force, or -1. Pack rows are
 * always `enforce` (a pack cannot be shadowed, and its mode is never set).
 */
export const nearestPackDepth = (
	inForce: readonly InstallationInForce[],
): number =>
	inForce.reduce(
		(max, i) =>
			isPackRow(i) && i.installation.mode !== "disabled"
				? Math.max(max, i.depth)
				: max,
		-1,
	);

/** True when a nearer pack masks this pack installation (see the header). */
export const isMasked = (
	i: InstallationInForce,
	packDepth: number,
): boolean => i.installation.pack !== undefined && i.depth < packDepth;

/** The provider of `iface` among `inForce` (enforce only; locked ancestors win). */
export const providerOf = (
	iface: string,
	inForce: readonly InstallationInForce[],
): InstallationInForce | null => {
	const packDepth = nearestPackDepth(inForce);
	const candidates = inForce
		.filter((i) =>
			i.installation.mode === "enforce" && provides(i).includes(iface) &&
			// A locked provider is never masked: the lock is what keeps a
			// subtree on it, and installs below it are refused anyway.
			(i.installation.locked || !isMasked(i, packDepth))
		)
		.sort(byNearest);
	const locked = candidates.filter((i) => i.installation.locked);
	if (locked.length > 0) return locked[locked.length - 1];
	return candidates[0] ?? null;
};

export const resolve = (
	inForce: readonly InstallationInForce[],
): Resolution => {
	const sorted = [...inForce]
		.filter((i) => i.installation.mode !== "disabled")
		.sort(byNearest);
	const packDepth = nearestPackDepth(sorted);
	const masked = sorted.filter((i) =>
		isMasked(i, packDepth) && !i.installation.locked
	);
	const maskedIds = new Set(masked.map((i) => i.installation.id));
	const ifaces = new Set(sorted.flatMap(provides));
	const providers = new Map<string, InstallationInForce>();
	const shadowProviders = new Map<string, InstallationInForce[]>();
	for (const iface of ifaces) {
		const winner = providerOf(iface, sorted);
		if (winner !== null) providers.set(iface, winner);
		const shadows = sorted.filter((i) =>
			i.installation.mode === "shadow" && provides(i).includes(iface) &&
			!maskedIds.has(i.installation.id)
		);
		if (shadows.length > 0) shadowProviders.set(iface, shadows);
	}
	const winners = new Set(
		[...providers.values()].map((i) => i.installation.id),
	);
	const seen = new Set<string>();
	const effective = sorted.filter((i) => {
		if (maskedIds.has(i.installation.id)) return false;
		const key = `${i.installation.extId}\u0000${i.installation.mode}`;
		if (seen.has(key)) return false;
		seen.add(key);
		if (i.installation.mode !== "enforce" || provides(i).length === 0) {
			return true;
		}
		return winners.has(i.installation.id);
	});
	const gates = sorted.filter((i) => (i.manifest.gates?.length ?? 0) > 0);
	return { providers, shadowProviders, effective, gates, masked };
};

/**
 * A manifest reduced to its gates (K8): what a replaced or masked gate
 * holder still does at a node. It keeps the gate inputs and its identity,
 * and drops every other surface (interfaces, subscriptions, echo, slots,
 * tools, context, cards, settings).
 */
export const gatesOnly = (m: Manifest): Manifest => {
	const {
		provides: _provides,
		requires: _requires,
		subscribe: _subscribe,
		echo: _echo,
		contributes: _contributes,
		...rest
	} = m;
	return rest;
};

/**
 * What acts at a node, nearest first: the effective installations as they
 * are, then every other gate holder in force with its manifest reduced to
 * its gates (`gatesOnly`). This is the registry's answer to "in force"
 * (`RegistryFacade.inForce`), so every consumer that reads subscriptions,
 * echo hooks, context contributors, extension tools or gates from it
 * applies the resolution without knowing it.
 */
export const acting = (
	inForce: readonly InstallationInForce[],
): InstallationInForce[] => {
	const r = resolve(inForce);
	const effective = new Set(r.effective.map((i) => i.installation.id));
	return [
		...r.effective,
		...r.gates
			.filter((i) => !effective.has(i.installation.id))
			.map((i) => ({ ...i, manifest: gatesOnly(i.manifest) })),
	].sort(byNearest);
};

/** Which installations' rows of `kind` apply at the node (see the header). */
export const installationsFor = (
	kind: ContributionKind,
	r: Resolution,
): readonly InstallationInForce[] =>
	kind === "gate"
		? r.gates
		: kind === "provides"
		? [...r.providers.values()].sort(byNearest).filter((i, n, all) =>
			all.findIndex((j) => j.installation.id === i.installation.id) === n
		)
		: r.effective;
