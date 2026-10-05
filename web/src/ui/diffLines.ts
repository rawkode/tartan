// Unified-patch text → typed lines for display (no parsing beyond the line
// prefix; the text is shown as text).

export type DiffLineKind = "add" | "del" | "hunk" | "meta" | "context";

export type DiffLine = {
	readonly kind: DiffLineKind;
	readonly text: string;
	readonly oldNo: number | null;
	readonly newNo: number | null;
};

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const META_RE =
	/^(?:diff --git |index |--- |\+\+\+ |new file mode |deleted file mode |similarity index |rename from |rename to |old mode |new mode |Binary files )/;

/**
 * At most `limit` lines (the rest is reported as truncated by the caller).
 * File header lines (`--- a/x`, `+++ b/x`, `index …`) count as such only
 * before a file's first hunk: inside a hunk, a removed `-- x` or an added
 * `++ x` is content.
 */
export const diffLines = (patch: string, limit = 5000): DiffLine[] => {
	const lines: DiffLine[] = [];
	let oldNo = 0;
	let newNo = 0;
	let inHunk = false;
	for (const text of patch.replace(/\r\n?/g, "\n").split("\n")) {
		if (lines.length >= limit) break;
		const hunk = HUNK_RE.exec(text);
		if (text.startsWith("diff --git ")) inHunk = false;
		if (hunk) {
			oldNo = Number(hunk[1]);
			newNo = Number(hunk[2]);
			inHunk = true;
			lines.push({ kind: "hunk", text, oldNo: null, newNo: null });
		} else if (!inHunk && META_RE.test(text)) {
			lines.push({ kind: "meta", text, oldNo: null, newNo: null });
		} else if (text.startsWith("+")) {
			lines.push({ kind: "add", text, oldNo: null, newNo: newNo++ });
		} else if (text.startsWith("-")) {
			lines.push({ kind: "del", text, oldNo: oldNo++, newNo: null });
		} else if (text.startsWith("\\")) {
			lines.push({ kind: "meta", text, oldNo: null, newNo: null });
		} else if (text !== "" || lines.length > 0) {
			lines.push({ kind: "context", text, oldNo: oldNo++, newNo: newNo++ });
		}
	}
	while (lines.length > 0 && lines[lines.length - 1]?.text === "") lines.pop();
	return lines;
};
