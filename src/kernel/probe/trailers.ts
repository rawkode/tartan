// Commit subject and trailers (`Key: value` lines in the last paragraph of
// the message, as `git interpret-trailers` reads them), for `push.diffed`.

import type { Trailer } from "@tartan/contract";

const TRAILER = /^([A-Za-z0-9][A-Za-z0-9-]*)\s*:\s?(.*)$/;

export const subjectOf = (message: string): string =>
	message.split("\n", 1)[0].trim();

/** Trailers of a commit message; none when the last paragraph has a non-trailer line. */
export const trailersOf = (message: string): Trailer[] => {
	const paragraphs = message.trimEnd().split(/\n[ \t]*\n/);
	if (paragraphs.length < 2) return [];
	const last = paragraphs.at(-1)!.split("\n");
	const out: { key: string; value: string }[] = [];
	for (const line of last) {
		const m = TRAILER.exec(line);
		if (m) out.push({ key: m[1], value: m[2].trim() });
		else if (/^\s+\S/.test(line) && out.length > 0) {
			out[out.length - 1].value += ` ${line.trim()}`;
		} else return [];
	}
	return out;
};
