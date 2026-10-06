// The tabs a pack adds, read from the manifests in the repository at
// collection time (never hard-coded): `extensions/packs/<pack>/tartan.json`
// members, each member's `repo.tab` and `node.tab` contributions. Renamed
// labels and removed extensions change the generated tests without a test
// edit.
//
// Pure module (no e2e runtime import): the Deno unit tests import it too.

import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type Pack, PACKS } from "./names.ts";

export type TabSpec = {
	readonly pack: Pack;
	readonly ext: string;
	readonly slot: "repo.tab" | "node.tab";
	/** The contribution id (SlotTabView's `only`). */
	readonly id: string;
	readonly label: string;
	/** The URL segment after `/-/`, as RepoFrame builds it. */
	readonly route: string;
};

type SlotContribution = {
	readonly slot?: string;
	readonly id?: string;
	readonly label?: string;
	readonly route?: string;
	readonly when?: string;
};

type Manifest = {
	readonly id?: string;
	readonly kind?: string;
	readonly members?: readonly {
		readonly id: string;
		/** The pack's config for the member: `labels` rename its tabs (Classic). */
		readonly config?: { readonly labels?: Readonly<Record<string, string>> };
	}[];
	readonly contributes?: { readonly slots?: readonly SlotContribution[] };
};

/** `extensions/` of this checkout. */
export const EXTENSIONS_DIR = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"extensions",
);

const readManifest = (file: string): Manifest =>
	JSON.parse(readFileSync(file, "utf8")) as Manifest;

/** RepoFrame's route segment for a static tab (`route ?? id`, minus `*` and a trailing `/`). */
export const tabRoute = (c: { route?: string; id: string }): string =>
	(c.route ?? c.id).replace(/\*.*$/, "").replace(/\/$/, "");

/** The manifests of a pack's members, in member order. */
const packMembers = (root: string, pack: Pack): [string, Manifest][] => {
	const byId = new Map<string, Manifest>();
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name === "packs") continue;
		try {
			const manifest = readManifest(path.join(root, entry.name, "tartan.json"));
			if (manifest.id !== undefined) byId.set(manifest.id, manifest);
		} catch {
			// A directory without a manifest (shared code).
		}
	}
	const manifest = readManifest(path.join(root, "packs", pack, "tartan.json"));
	return (manifest.members ?? []).map((member) => {
		const ext = byId.get(member.id);
		if (ext === undefined) {
			throw new Error(`pack ${pack} names ${member.id}, which has no manifest`);
		}
		return [member.id, ext];
	});
};

/** A pack's contributions to one slot (`repo.sidebar`, `change.panel`, …). */
export const packSlots = (
	pack: Pack,
	slot: string,
	root: string = EXTENSIONS_DIR,
): { readonly ext: string; readonly id: string }[] =>
	packMembers(root, pack).flatMap(([ext, manifest]) =>
		(manifest.contributes?.slots ?? [])
			.filter((c) => c.slot === slot && c.id !== undefined)
			.map((c) => ({ ext, id: c.id as string }))
	);

/** Every pack's `repo.tab` and `node.tab` contributions, in manifest order. */
export const packTabs = (root: string = EXTENSIONS_DIR): TabSpec[] => {
	const byId = new Map<string, Manifest>();
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name === "packs") continue;
		try {
			const manifest = readManifest(path.join(root, entry.name, "tartan.json"));
			if (manifest.id !== undefined) byId.set(manifest.id, manifest);
		} catch {
			// A directory without a manifest (shared code).
		}
	}
	const tabs: TabSpec[] = [];
	for (const pack of PACKS) {
		const manifest = readManifest(
			path.join(root, "packs", pack, "tartan.json"),
		);
		for (const member of manifest.members ?? []) {
			const ext = byId.get(member.id);
			if (ext === undefined) {
				throw new Error(
					`pack ${pack} names ${member.id}, which has no manifest`,
				);
			}
			for (const c of ext.contributes?.slots ?? []) {
				if (
					(c.slot !== "repo.tab" && c.slot !== "node.tab") ||
					c.id === undefined
				) {
					continue;
				}
				tabs.push({
					pack,
					ext: member.id,
					slot: c.slot,
					id: c.id,
					// The pack renames a member's tabs by contribution id (the view
					// API applies `config.labels`: Classic's Issues, Pull requests).
					label: member.config?.labels?.[c.id] ?? c.label ?? c.id,
					route: tabRoute({ id: c.id, ...(c.route ? { route: c.route } : {}) }),
				});
			}
		}
	}
	return tabs;
};
