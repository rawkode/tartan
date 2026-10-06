// Labels the suites look for, read from the extensions in this checkout at
// collection time instead of written as literals:
//
// - `slotLabel(ext, slot, id)`: a static contribution's label from the
//   extension's manifest (a tab's "Weave", "Radar", "Diff");
// - `actionLabel(ext, action)`: the text of the button that runs a slot
//   action, read from the extension's UI source (`ui.button("<label>",
//   ui.action("<action>", …))`), so the M1 loop's reviewer presses whatever
//   the review extension calls its approve button.
//
// A label that cannot be found fails collection with the extension and the
// id, so a renamed action or tab is a clear error, not a silent skip.
//
// Pure module (no e2e runtime import): the Deno unit tests import it too.

import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { EXTENSIONS_DIR } from "./tabs.ts";

type Manifest = {
	readonly id?: string;
	readonly contributes?: {
		readonly slots?: readonly {
			readonly slot?: string;
			readonly id?: string;
			readonly label?: string;
		}[];
	};
};

/** The directory of the extension whose manifest has `id`. */
export const extensionDir = (
	ext: string,
	root: string = EXTENSIONS_DIR,
): string => {
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const dir = path.join(root, entry.name);
		try {
			const manifest = JSON.parse(
				readFileSync(path.join(dir, "tartan.json"), "utf8"),
			) as Manifest;
			if (manifest.id === ext) return dir;
		} catch {
			// No manifest here (shared code, packs' sources).
		}
	}
	throw new Error(`no extension ${ext} under ${root}`);
};

/**
 * What a pack's Work tab calls a work item: `issue` when the pack configures
 * `tartan.work` with `wording: "classic"` (the Classic pack), else
 * `work item` (extensions/work/src/wording.ts).
 */
export const workNoun = (
	pack: "swarm" | "classic",
	root: string = EXTENSIONS_DIR,
): string => {
	const manifest = JSON.parse(
		readFileSync(path.join(root, "packs", pack, "tartan.json"), "utf8"),
	) as {
		readonly members?: readonly {
			readonly id: string;
			readonly config?: { readonly wording?: string };
		}[];
	};
	return manifest.members?.find((m) => m.id === "tartan.work")?.config
			?.wording === "classic"
		? "issue"
		: "work item";
};

/** A static slot contribution's label (its id when it has none). */
export const slotLabel = (
	ext: string,
	slot: string,
	id: string,
	root: string = EXTENSIONS_DIR,
): string => {
	const manifest = JSON.parse(
		readFileSync(path.join(extensionDir(ext, root), "tartan.json"), "utf8"),
	) as Manifest;
	const c = manifest.contributes?.slots?.find((s) =>
		s.slot === slot && s.id === id
	);
	if (c === undefined) throw new Error(`${ext} contributes no ${slot} ${id}`);
	return c.label ?? id;
};

const escapeRegExp = (text: string): string =>
	text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every `.ts` file under `dir` (sources only, no tests). */
const sources = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) return sources(p);
		return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [p] : [];
	});

/** The label of the button that runs slot action `action` of extension `ext`. */
export const actionLabel = (
	ext: string,
	action: string,
	root: string = EXTENSIONS_DIR,
): string => {
	const re = new RegExp(
		`ui\\.button\\(\\s*"([^"\\\\]{1,80})",\\s*ui\\.action\\(\\s*"${
			escapeRegExp(action)
		}"`,
	);
	const labels = new Set<string>();
	for (const file of sources(path.join(extensionDir(ext, root), "src"))) {
		const m = re.exec(readFileSync(file, "utf8"));
		if (m !== null) labels.add(m[1]);
	}
	if (labels.size !== 1) {
		throw new Error(
			`${ext} has ${labels.size} buttons for action ${action}, not exactly one`,
		);
	}
	return [...labels][0];
};
