// Why-blame's model: the file-level view.
// Each commit that touched the file is a row; its gutter colour is its work
// item (the `Tartan-Work` trailer), so the commits of one intent read as one
// band. The provenance drawer reads the commit's why note (`GET /-/api/why`)
// and shows the kernel section plus the ids of the sections extensions
// contributed. Pure: no DOM, no API.

import type { Envelope } from "@tartan/contract/events.ts";
import type { CommitMeta } from "@tartan/contract/git.ts";
import type { WhyNote } from "@tartan/contract/notes.ts";

/** Gutter colours available (`.why-row--w<n>` in the view). */
export const GUTTER_COLOURS = 6;

const trailer = (commit: CommitMeta, key: string): string | null =>
	commit.trailers.find((t) => t.key.toLowerCase() === key.toLowerCase())
		?.value ?? null;

/** The work item a landed commit names (`Tartan-Work`), if any. */
export const workOf = (commit: CommitMeta): string | null =>
	trailer(commit, "Tartan-Work");

/** `Tartan-Agent: codex-2 (codex/gpt-5-codex)` → the agent and its model. */
export const agentOf = (
	commit: CommitMeta,
): { readonly agent: string; readonly model?: string } | null => {
	const value = trailer(commit, "Tartan-Agent");
	if (value === null) return null;
	const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(value);
	return m ? { agent: m[1]!, model: m[2]! } : { agent: value };
};

export const changeOf = (commit: CommitMeta): string | null =>
	trailer(commit, "Change-Id");

export const advanceOf = (commit: CommitMeta): string | null =>
	trailer(commit, "Tartan-Advance");

/** A stable colour per work item (FNV-1a), or null for commits without one. */
export const gutterOf = (work: string | null): number | null => {
	if (work === null) return null;
	let h = 0x811c9dc5;
	for (let i = 0; i < work.length; i++) {
		h ^= work.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h % GUTTER_COLOURS;
};

export type BlameRow = {
	readonly commit: CommitMeta;
	readonly work: string | null;
	readonly gutter: number | null;
	readonly agent: { readonly agent: string; readonly model?: string } | null;
	readonly advance: string | null;
	/** True for the first row of a run of commits with the same work item. */
	readonly bandStart: boolean;
};

export const blameRows = (commits: readonly CommitMeta[]): BlameRow[] =>
	commits.map((commit, i) => {
		const work = workOf(commit);
		const previous = i > 0 ? workOf(commits[i - 1]!) : undefined;
		return {
			commit,
			work,
			gutter: gutterOf(work),
			agent: agentOf(commit),
			advance: advanceOf(commit),
			bandStart: i === 0 || previous !== work,
		};
	});

/** The work items in the file's history, in first-seen order, with how many commits each. */
export const workLegend = (
	rows: readonly BlameRow[],
): { work: string; gutter: number; commits: number }[] => {
	const out = new Map<
		string,
		{ work: string; gutter: number; commits: number }
	>();
	for (const row of rows) {
		if (row.work === null || row.gutter === null) continue;
		const seen = out.get(row.work);
		if (seen) seen.commits++;
		else out.set(row.work, { work: row.work, gutter: row.gutter, commits: 1 });
	}
	return [...out.values()];
};

/** The extension sections of a why note, by key (`<extId>[@<version>]`), sorted. */
export const noteSections = (note: WhyNote): readonly string[] =>
	Object.keys(note.ext).sort();

/** The reason events a note names, in log order, with the ones the answer carried. */
export const reasonEvents = (
	note: WhyNote,
	events: readonly Envelope[],
): { readonly id: string; readonly event?: Envelope }[] => {
	const byId = new Map(events.map((e) => [e.id, e]));
	return note.kernel.reason.events.map((id) => ({
		id,
		...(byId.has(id) ? { event: byId.get(id)! } : {}),
	}));
};
