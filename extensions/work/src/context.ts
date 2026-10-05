// `context@1` section of tartan.work: the work
// item's contract (title, why, acceptance, footprint, parent). The same
// section rides in the `work_claim` result's `context`.
// Text written by people or agents is defused (no code fence can be closed
// from inside it); the kernel fences the whole section as untrusted when it
// quotes it.

import {
	type ContextSection,
	defuseFences,
	stripControl,
	truncateBytes,
	type WorkItem,
} from "@tartan/contract";

const clean = (text: string): string =>
	defuseFences(stripControl(text, { keepNewlines: true }));

const footprintLine = (f: WorkItem["footprint"]): string => {
	const parts = [
		f.projects.length > 0 ? `projects ${f.projects.join(", ")}` : "",
		f.prefixes.length > 0 ? `paths ${f.prefixes.join(", ")}` : "",
	].filter((p) => p !== "");
	return parts.length > 0 ? parts.join("; ") : "none declared";
};

export const itemMarkdown = (item: WorkItem): string => {
	const lines = [
		`### ${item.ref}: ${clean(item.title)}`,
		`${item.kind}, ${item.state}`,
	];
	if (item.why.trim() !== "") lines.push("", "**Why**", clean(item.why));
	if (item.acceptance.length > 0) {
		lines.push(
			"",
			"**Acceptance**",
			...item.acceptance.map((a) => `- ${clean(a)}`),
		);
	}
	lines.push("", `**Footprint**: ${footprintLine(item.footprint)}`);
	if (item.parent) lines.push(`**Parent**: ${item.parent}`);
	return lines.join("\n");
};

/** The section for one item within `maxBytes`. */
export const itemSections = (
	item: WorkItem,
	maxBytes: number,
): ContextSection[] => [{
	id: "work-item",
	title: `${item.ref}`.slice(0, 120),
	priority: "protocol",
	md: truncateBytes(itemMarkdown(item), maxBytes),
	data: { ref: item.ref, state: item.state, footprint: item.footprint },
}];
