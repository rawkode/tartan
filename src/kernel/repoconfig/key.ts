// Content addressing for repository config (ADR repo config, "Cache and
// state"). Pure and synchronous (`node:crypto` under `nodejs_compat`), so
// keys are computed inside `transactionSync`.
//
//   inputKey     = sha256(JSON.stringify(["tartan.cue-eval/1", evaluatorId,
//                         schemaKey, [[name, blobOid], …sorted by name]]))
//                  over every root `*.cue` file, of any package
//   policyDigest = sha256(JSON.stringify([[name, mode, oid], …sorted]))
//                  over every root `*.cue` entry (K13.3, K13.2)
//
// An Advance that leaves the root `*.cue` files and the schema unchanged
// gives the same key, so nothing is evaluated again; an edit to any of them
// (another package's included) gives a new key. A lane head and a trunk
// commit with the same files give the same key; trunk still re-checks the
// sha256 of the canonical bytes before it uses a cache entry.

import { createHash } from "node:crypto";
import { CUE_EVAL_CONTRACT } from "@tartan/contract";

export const sha256Hex = (data: string | Uint8Array): string =>
	createHash("sha256").update(data).digest("hex");

/** Git's blob id: `sha1("blob <len>\0" + bytes)`. */
export const gitBlobOid = (bytes: Uint8Array): string =>
	createHash("sha1")
		.update(`blob ${bytes.byteLength}\0`)
		.update(bytes)
		.digest("hex");

const byName = <T extends readonly [string, ...unknown[]]>(a: T, b: T) =>
	a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;

export type FileRef = { readonly name: string; readonly oid: string };

/** `[[name, oid], …]` sorted by name. */
export const fileList = (
	files: readonly FileRef[],
): [string, string][] =>
	files.map((f): [string, string] => [f.name, f.oid]).sort(byName);

export const inputKeyOf = (input: {
	readonly evaluator: string;
	readonly schemaKey: string;
	readonly files: readonly FileRef[];
}): string =>
	sha256Hex(JSON.stringify([
		CUE_EVAL_CONTRACT,
		input.evaluator,
		input.schemaKey,
		fileList(input.files),
	]));

export type PolicyEntry = {
	readonly name: string;
	readonly mode: string;
	readonly oid: string;
};

/** Git modes without leading zeros (`040000` and `40000` are one mode). */
const normalMode = (mode: string): string => mode.replace(/^0+(?=\d)/, "");

/**
 * The sign-off's and the candidate's `policyDigest` (K13.3, K13.2): sha256
 * of the sorted `[name, mode, oid]` of every root `*.cue` entry, of any
 * kind; `null` when there is none.
 */
export const policyDigestOf = (
	entries: readonly PolicyEntry[],
): string | null =>
	entries.length === 0 ? null : sha256Hex(JSON.stringify(
		entries
			.map((e): [string, string, string] => [e.name, normalMode(e.mode), e.oid])
			.sort(byName),
	));

/** The schema key: sha256 of the generated files, sorted by path. */
export const schemaKeyOf = (files: Readonly<Record<string, string>>): string =>
	sha256Hex(JSON.stringify(
		Object.entries(files).sort((a, b) =>
			a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
		),
	));

/** Canonical JSON (sorted keys) for hashing resolved configs. */
export const canonicalJson = (value: unknown): string => {
	const norm = (v: unknown): unknown => {
		if (Array.isArray(v)) return v.map(norm);
		if (typeof v === "object" && v !== null) {
			return Object.fromEntries(
				Object.entries(v as Record<string, unknown>)
					.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
					.map(([k, x]) => [k, norm(x)]),
			);
		}
		return v;
	};
	return JSON.stringify(norm(value));
};
