// Positive-evidence reads of a commit's root `*.cue` files (ADR repo
// config, "Positive evidence"; K15). One read sequence
// serves trunk, previews and sign-offs:
//
// 1. `readCommit(sha)` is non-null and names that sha; its tree id is T.
// 2. `readTree(T)` is non-null and non-empty. The root `*.cue` entries are
//    read from T itself, so no further tree read is needed.
// 3. Every sent file is read with `readBlob`; its git blob hash must equal
//    its oid, and its sha256 is recorded.
//
// Any null, empty or mismatched read is `unavailable`: callers change no
// state and retry with backoff. Only positive evidence yields `absent` (T
// has no root `*.cue` entry), so an empty or failed read can never be taken
// for "the config was removed".

import { LEGACY_CONFIG_DIR } from "@tartan/contract";
import {
	gitBlobOid,
	policyDigestOf,
	type PolicyEntry,
	sha256Hex,
} from "./key.ts";
import {
	checkConfigContents,
	type ConfigTreeEntry,
	rootCueEntries,
	selectConfigFiles,
} from "./rules.ts";

/** The SHA reads the reader needs (an Artifacts repo handle, or a fake). */
export type ConfigReads = {
	readCommit(
		sha: string,
	): Promise<{ readonly hash: string; readonly treeHash: string } | null>;
	readTree(sha: string): Promise<readonly ConfigTreeEntry[] | null>;
	readBlob(sha: string): Promise<Uint8Array | null>;
};

export type ConfigFile = {
	readonly name: string;
	readonly oid: string;
	readonly sha256: string;
	readonly text: string;
};

type Read = {
	readonly sha: string;
	/** The root `*.cue` digest (K13.3); null when there is no root `*.cue` entry. */
	readonly policyDigest: string | null;
	/** Every root `*.cue` entry, any kind (what the digest covers). */
	readonly entries: readonly PolicyEntry[];
	/** The root still has a `.tartan` entry (the settings page's migration hint). */
	readonly legacyDir: boolean;
};

export type ConfigSnapshot =
	| {
		readonly kind: "unavailable";
		readonly reason: string;
	}
	/** Positive evidence of no config: the root tree has no `*.cue` entry. */
	| (Read & { readonly kind: "absent" })
	/** A kernel file rule failed (`INVALID_INPUT` naming the path). */
	| (Read & {
		readonly kind: "invalid";
		readonly path: string;
		readonly message: string;
	})
	| (Read & { readonly kind: "files"; readonly files: readonly ConfigFile[] });

const unavailable = (reason: string): ConfigSnapshot => ({
	kind: "unavailable",
	reason,
});

const errorText = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

/** The root tree of a commit, or a reason the read is not positive evidence. */
const readRoot = async (
	reads: Pick<ConfigReads, "readCommit" | "readTree">,
	sha: string,
): Promise<
	{ readonly root: readonly ConfigTreeEntry[] } | { readonly reason: string }
> => {
	const commit = await reads.readCommit(sha);
	if (commit === null) return { reason: `commit ${sha} was not readable` };
	if (commit.hash !== sha) {
		return { reason: `commit read for ${sha} answered ${commit.hash}` };
	}
	const root = await reads.readTree(commit.treeHash);
	if (root === null) return { reason: `root tree of ${sha} was not readable` };
	if (root.length === 0) return { reason: `root tree of ${sha} read empty` };
	return { root };
};

const readOf = (sha: string, root: readonly ConfigTreeEntry[]): Read => {
	const entries = rootCueEntries(root).map((e) => ({
		name: e.name,
		mode: e.mode,
		oid: e.hash,
	}));
	return {
		sha,
		policyDigest: policyDigestOf(entries),
		entries,
		legacyDir: root.some((e) => e.name === LEGACY_CONFIG_DIR),
	};
};

/**
 * The root `*.cue` digest at a commit: `null` when there is none,
 * `undefined` when the reads were not positive evidence (sign-off binding,
 * K13.3).
 */
export const readPolicyDigest = async (
	reads: Pick<ConfigReads, "readCommit" | "readTree">,
	sha: string,
): Promise<string | null | undefined> => {
	try {
		const read = await readRoot(reads, sha);
		return "reason" in read ? undefined : readOf(sha, read.root).policyDigest;
	} catch {
		return undefined;
	}
};

export const readConfigAt = async (
	reads: ConfigReads,
	sha: string,
): Promise<ConfigSnapshot> => {
	try {
		const read = await readRoot(reads, sha);
		if ("reason" in read) return unavailable(read.reason);
		const base = readOf(sha, read.root);
		if (base.entries.length === 0) return { kind: "absent", ...base };
		const selected = selectConfigFiles(read.root);
		if (!selected.ok) {
			return {
				kind: "invalid",
				...base,
				path: selected.path,
				message: selected.message,
			};
		}
		const blobs: { name: string; oid: string; bytes: Uint8Array }[] = [];
		for (const file of selected.files) {
			const bytes = await reads.readBlob(file.oid);
			if (bytes === null) {
				return unavailable(`blob ${file.oid} (${file.name}) was not readable`);
			}
			if (gitBlobOid(bytes) !== file.oid) {
				return unavailable(`blob ${file.oid} (${file.name}) hash mismatch`);
			}
			blobs.push({ ...file, bytes });
		}
		const checked = checkConfigContents(blobs);
		if (!checked.ok) {
			return {
				kind: "invalid",
				...base,
				path: checked.path,
				message: checked.message,
			};
		}
		return {
			kind: "files",
			...base,
			files: checked.files.map((f, i) => ({
				name: f.name,
				oid: f.oid,
				text: f.text,
				sha256: sha256Hex(blobs[i].bytes),
			})),
		};
	} catch (error) {
		return unavailable(`reads failed: ${errorText(error)}`);
	}
};

/** Reads bound to one Artifacts repo handle (blobs as bytes). */
export const artifactsReads = (
	repo: {
		readCommit(
			sha: string,
		): Promise<{ hash: string; treeHash: string } | null>;
		readTree(sha: string): Promise<ConfigTreeEntry[] | null>;
		readBlob(sha: string): Promise<Blob | null>;
	},
): ConfigReads => ({
	readCommit: (sha) => repo.readCommit(sha),
	readTree: (sha) => repo.readTree(sha),
	readBlob: async (sha) => {
		const blob = await repo.readBlob(sha);
		return blob === null ? null : new Uint8Array(await blob.arrayBuffer());
	},
});
