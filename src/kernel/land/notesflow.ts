// Pushing why notes to `refs/notes/tartan` (the K5 repair): read the remote
// notes tip; if it already is our tip, done; if it is the base our tip was
// built on, push with `--force-with-lease=refs/notes/tartan:<base>`; if it
// moved (another ref's advance wrote notes meanwhile), fetch it, re-add our
// notes on top (notes are additive, keyed by landed commit), register a fresh
// intent that supersedes the previous one, and push again, at most
// `NOTES_TRIES` times.
//
// Notes commits are deterministic (fixed identity and date), so a step that
// re-runs after a container restart rebuilds exactly the tip it registered.

import { NOTES_REF, unavailable, ZERO_SHA } from "@tartan/contract";
import type { Credential, LandGit } from "./git.ts";
import type { GitIdentity } from "./gitcmd.ts";

export const NOTES_TRIES = 5;

export type NotesPlan = {
	/** The mirror's own notes work ref (never pushed under that name). */
	readonly workRef: string;
	readonly notes: readonly { readonly commit: string; readonly text: string }[];
	readonly identity: GitIdentity;
	readonly date: number;
};

export type NotesFlowDeps = {
	readonly git: LandGit;
	/** The remote notes tip (null: no notes yet). */
	readonly remoteTip: () => Promise<string | null>;
	readonly readCred: () => Promise<Credential & { revoke(): Promise<void> }>;
	readonly writeCred: () => Promise<Credential & { revoke(): Promise<void> }>;
	/** Registers the K1 intent `base → tip` before a push. */
	readonly register: (base: string, tip: string) => Promise<void>;
};

/** Builds the notes on `base` (fetching `base` into the mirror first). */
export const buildNotesOn = async (
	deps: Pick<NotesFlowDeps, "git" | "readCred">,
	plan: NotesPlan,
	base: string,
): Promise<string> => {
	if (base !== ZERO_SHA && !(await deps.git.has(base))) {
		const cred = await deps.readCred();
		try {
			await deps.git.fetch(cred, [{ sha: base, ref: `${plan.workRef}-base` }]);
		} finally {
			await cred.revoke();
		}
	}
	return await deps.git.buildNotes({
		notesRef: plan.workRef,
		base,
		notes: plan.notes,
		identity: plan.identity,
		date: plan.date,
	});
};

export type NotesPushResult = {
	readonly base: string;
	readonly tip: string;
	readonly tries: number;
};

/**
 * Pushes `plan` given the base and tip already registered (`registered`, or
 * null when nothing was registered yet). Returns the tip that is now
 * upstream.
 */
export const pushNotes = async (
	deps: NotesFlowDeps,
	plan: NotesPlan,
	registered: { readonly base: string; readonly tip: string } | null,
): Promise<NotesPushResult> => {
	let current = registered;
	for (let tries = 1; tries <= NOTES_TRIES; tries++) {
		const remote = (await deps.remoteTip()) ?? ZERO_SHA;
		if (current !== null && remote === current.tip) {
			return { ...current, tries };
		}
		if (current === null || remote !== current.base) {
			const tip = await buildNotesOn(deps, plan, remote);
			current = { base: remote, tip };
			await deps.register(remote, tip);
		} else if (!(await deps.git.has(current.tip))) {
			// The container restarted since the tip was built: rebuild it (the
			// same objects, since notes commits are deterministic).
			const tip = await buildNotesOn(deps, plan, current.base);
			if (tip !== current.tip) {
				current = { base: current.base, tip };
				await deps.register(current.base, tip);
			}
		}
		const cred = await deps.writeCred();
		let outcome;
		try {
			outcome = await deps.git.push(cred, [{
				src: current.tip,
				dst: NOTES_REF,
				expect: current.base,
			}]);
		} finally {
			await cred.revoke();
		}
		const ref = outcome.refs.find((r) => r.ref === NOTES_REF);
		if (ref?.kind === "ok" || ref?.kind === "uptodate") {
			return { ...current, tries };
		}
		if (ref?.kind === "rejected") {
			throw unavailable(`notes push rejected: ${ref.reason}`);
		}
		// `stale`: the remote notes tip moved; rebase on it and try again.
	}
	throw unavailable(`the notes ref moved ${NOTES_TRIES} times; retry later`);
};
