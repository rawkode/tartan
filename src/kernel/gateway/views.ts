// Ref views of the canonical repo (WP4): which advertised refs a caller sees.
// Hidden namespaces (`refs/heads/lanes/`, `refs/notes/lanes/`, `refs/tartan/`)
// never appear in a default advertisement; the member view sees the caller's
// own `branch` lanes always and other hidden refs only under a protocol-v2
// `ref-prefix` that itself lies inside a hidden namespace; the public view
// never sees them.

import { isHiddenRef } from "@tartan/contract";
import { decodePktLines } from "@tartan/gitproto";

/** Visible refs only (the public view). */
export const publicRefs = (ref: string): boolean => !isHiddenRef(ref);

/** Visible refs plus the caller's own `branch`-lane refs (v0/v1, receive-pack). */
export const memberRefs =
	(own: ReadonlySet<string>) => (ref: string): boolean =>
		!isHiddenRef(ref) || own.has(ref);

/**
 * A member-view v2 `ls-refs` answer: as `memberRefs`, plus hidden refs under
 * a requested `ref-prefix` inside a hidden namespace (`git fetch origin
 * refs/heads/lanes/ln_7` sends `ref-prefix refs/heads/lanes/ln_7`; a clone's
 * `refs/heads/` does not reach into them).
 */
export const memberLsRefs = (
	own: ReadonlySet<string>,
	refPrefixes: readonly string[],
) => {
	const hiddenPrefixes = refPrefixes.filter(isHiddenRef);
	return (ref: string): boolean =>
		!isHiddenRef(ref) || own.has(ref) ||
		hiddenPrefixes.some((prefix) => ref.startsWith(prefix));
};

const decoder = new TextDecoder();

/** Whether an `info/refs` body is a protocol-v2 capability advertisement. */
export const isV2Advertisement = (body: Uint8Array): boolean => {
	let lines;
	try {
		lines = decodePktLines(body).lines;
	} catch {
		return false;
	}
	let i = 0;
	const text = (index: number): string | null => {
		const line = lines[index];
		return line?.kind === "data"
			? decoder.decode(line.data).replace(/\n$/, "")
			: null;
	};
	if (text(i)?.startsWith("# service=")) i += 2;
	return text(i) === "version 2";
};
