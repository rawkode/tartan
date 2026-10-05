// Why notes (K15): one JSON document per landed commit in `refs/notes/tartan`,
// with the kernel section written from verified kernel state and the extension
// sections contributed through `notes.contribute` (`note_sections`, keyed by
// extension id).
//
// - `buildWhyNote` validates against the contract (`WhyNoteSchema`), so a
//   note the kernel writes is always one readers accept.
// - `encodeNote` is the exact blob text (`git notes add -F -` keeps it).
// - `readNote` reads a note by SHA only (K15): the notes tip commit and the
//   annotated commit as the path, then git's fan-out paths (`ab/cdef…`,
//   `ab/cd/ef…`) when the plain path misses.

import {
	internal,
	type WhyNote,
	type WhyNoteKernel,
	WhyNoteSchema,
} from "@tartan/contract";

/** One extension section as stored (`note_sections.section_json`). */
export type NoteSection = { readonly extId: string; readonly json: string };

export const buildWhyNote = (
	kernel: WhyNoteKernel,
	sections: readonly NoteSection[],
): WhyNote => {
	const ext: Record<string, unknown> = {};
	for (const s of [...sections].sort((a, b) => a.extId < b.extId ? -1 : 1)) {
		try {
			ext[s.extId] = JSON.parse(s.json);
		} catch {
			// A section that is not JSON was refused at contribute time; skip.
		}
	}
	const parsed = WhyNoteSchema.safeParse({ v: 1, kernel, ext });
	if (!parsed.success) {
		throw internal(
			`why note invalid: ${
				parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`)
					.slice(0, 3).join("; ")
			}`,
		);
	}
	return parsed.data;
};

/** The note blob: compact JSON and a newline. */
export const encodeNote = (note: WhyNote): string =>
	`${JSON.stringify(note)}\n`;

/** Parses a note blob; null when it is not a v1 why note. */
export const decodeNote = (text: string): WhyNote | null => {
	try {
		const parsed = WhyNoteSchema.safeParse(JSON.parse(text.trim()));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
};

/** The tree paths a note for `commit` may live at (plain, then fan-out). */
export const notePaths = (commit: string): readonly string[] => [
	commit,
	`${commit.slice(0, 2)}/${commit.slice(2)}`,
	`${commit.slice(0, 2)}/${commit.slice(2, 4)}/${commit.slice(4)}`,
];

/** The binding read a note needs (`RepoReader.readFile` shape, by SHA only). */
export type NoteReader = {
	readFile(commit: string, path: string): Promise<Blob | string | null>;
};

export const readNote = async (
	reader: NoteReader,
	notesTip: string,
	commit: string,
): Promise<WhyNote | null> => {
	for (const path of notePaths(commit)) {
		const found = await reader.readFile(notesTip, path);
		if (found === null) continue;
		const text = typeof found === "string" ? found : await found.text();
		return decodeNote(text);
	}
	return null;
};
