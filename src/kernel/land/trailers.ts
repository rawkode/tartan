// The squash commit message of one landed change (contract
// `SquashMessageInput`).
//
// Title and summary come from the queue provider's `land.submit` request.
// The kernel trailers (`Change-Id`, `Tartan-Agent`, `Tartan-On-Behalf-Of`,
// `Tartan-Advance`, `Co-authored-by`) come from verified kernel state (the
// push log and lane ownership); a provider trailer that spells one of those
// keys, in any case, is dropped. Provider trailers are validated as syntax
// only (contract `TrailerSchema`) and keep their order, with the documented
// ones first (`Tartan-Change`, `Tartan-Work`, `Tartan-Review`).

import {
	GERRIT_CHANGE_ID_RE,
	invalid,
	isProviderTrailerKey,
	type KernelTrailers,
	type SquashMessageInput,
	SUMMARY_MAX_BYTES,
	TRAILER_KEY_RE,
	type TrailerLine,
} from "@tartan/contract";

const encoder = new TextEncoder();

/** Removes NUL and CR, keeps at most `maxBytes` UTF-8 bytes (never splitting a character). */
const cleanText = (text: string, maxBytes: number): string => {
	const clean = text.replace(/\r\n?/g, "\n").replace(/\0/g, "");
	if (encoder.encode(clean).length <= maxBytes) return clean;
	let out = "";
	let used = 0;
	for (const ch of clean) {
		const size = encoder.encode(ch).length;
		if (used + size > maxBytes) break;
		out += ch;
		used += size;
	}
	return out;
};

const oneLine = (value: string): string =>
	value.replace(/[\r\n\0]+/g, " ").trim();

const PROVIDER_ORDER = ["Tartan-Change", "Tartan-Work"] as const;
const PROVIDER_AFTER_AGENT = ["Tartan-Review"] as const;

const providerTrailers = (
	trailers: readonly TrailerLine[],
): { early: TrailerLine[]; review: TrailerLine[]; rest: TrailerLine[] } => {
	const kept = trailers
		.filter((t) => TRAILER_KEY_RE.test(t.key) && isProviderTrailerKey(t.key))
		.map((t) => ({ key: t.key, value: oneLine(t.value) }))
		.filter((t) => t.value.length > 0);
	const is = (names: readonly string[]) => (t: TrailerLine) =>
		names.some((n) => n.toLowerCase() === t.key.toLowerCase());
	const early = PROVIDER_ORDER.flatMap((name) => kept.filter(is([name])));
	const review = kept.filter(is(PROVIDER_AFTER_AGENT));
	const rest = kept.filter((t) =>
		!is([...PROVIDER_ORDER, ...PROVIDER_AFTER_AGENT])(t)
	);
	return { early, review, rest };
};

/** The trailer block (one `Key: value` per line, no blank lines). */
export const trailerBlock = (
	kernel: KernelTrailers,
	provider: readonly TrailerLine[],
): string[] => {
	if (!GERRIT_CHANGE_ID_RE.test(kernel.changeId)) {
		throw invalid(`not a Change-Id: ${kernel.changeId}`);
	}
	const { early, review, rest } = providerTrailers(provider);
	const line = (key: string, value: string) => `${key}: ${oneLine(value)}`;
	return [
		line("Change-Id", kernel.changeId),
		...early.map((t) => line(t.key, t.value)),
		...(kernel.agent ? [line("Tartan-Agent", kernel.agent)] : []),
		...(kernel.onBehalfOf
			? [line("Tartan-On-Behalf-Of", kernel.onBehalfOf)]
			: []),
		...review.map((t) => line(t.key, t.value)),
		...rest.map((t) => line(t.key, t.value)),
		line("Tartan-Advance", kernel.advance),
		...[...new Set(kernel.coAuthoredBy)].map((who) =>
			line("Co-authored-by", who)
		),
	];
};

/**
 * `<title>\n\n<summary>\n\n<trailers>\n` (the summary paragraph is left out
 * when empty). Deterministic for the same input, so a re-run of `compose-n`
 * produces the same commit.
 */
export const composeSquashMessage = (input: SquashMessageInput): string => {
	const title = oneLine(input.title);
	if (title.length === 0) throw invalid("title is empty");
	const summary = cleanText(input.summary, SUMMARY_MAX_BYTES)
		.split("\n")
		.map((l) => l.replace(/\s+$/, ""))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	const block = trailerBlock(input.kernel, input.provider);
	return [
		title,
		...(summary.length > 0 ? [summary] : []),
		block.join("\n"),
	].join("\n\n") + "\n";
};

/**
 * The Gerrit-style `Change-Id` of a change id: `I` + the SHA-1 of
 * `tartan-change:<changeId>` (stable across attempts and repos).
 */
export const gerritChangeId = async (changeId: string): Promise<string> => {
	const digest = await crypto.subtle.digest(
		"SHA-1",
		encoder.encode(`tartan-change:${changeId}`),
	);
	return `I${
		[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0"))
			.join("")
	}`;
};

/** A principal as the trailers name it. */
export type TrailerPrincipal = {
	readonly id: string;
	readonly kind: "user" | "agent" | "ext" | "system";
	readonly handle: string;
	readonly agentTool?: string | null;
	readonly agentModel?: string | null;
};

/** `codex-2 (codex/gpt-5-codex)`; the handle alone when tool or model is unknown. */
export const agentTrailer = (p: TrailerPrincipal): string => {
	const tool = [p.agentTool, p.agentModel].filter((v): v is string =>
		typeof v === "string" && v.length > 0
	).join("/");
	return tool.length > 0 ? `${p.handle} (${tool})` : p.handle;
};

/** `<handle> <agent+<id>@agents.<host>>`. */
export const coAuthorTrailer = (p: TrailerPrincipal, host: string): string =>
	`${oneLine(p.handle).replace(/[<>]/g, "")} <${
		p.kind === "user" ? `user+${p.id}` : `agent+${p.id}`
	}@${p.kind === "user" ? "users" : "agents"}.${host}>`;
