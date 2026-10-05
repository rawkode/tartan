// What the Changes tab calls a change: "change" by
// default, "pull request" when the installation's config says
// `wording: "classic"` (the Classic pack's `tartan.changes` member). The
// interface (`changes@1`, its tools and events) is the same either way;
// only the UI nouns change.

export type Wording = {
	/** "change" / "pull request". */
	readonly one: string;
	/** "changes" / "pull requests". */
	readonly many: string;
	/** "Work" / "Issue": the column naming the linked work item. */
	readonly work: string;
};

const DEFAULT: Wording = { one: "change", many: "changes", work: "Work" };
const CLASSIC: Wording = {
	one: "pull request",
	many: "pull requests",
	work: "Issue",
};

export const wordingOf = (config: unknown): Wording =>
	config !== null && typeof config === "object" &&
		(config as Record<string, unknown>).wording === "classic"
		? CLASSIC
		: DEFAULT;

/** "pull request" → "Pull request". */
export const capital = (s: string): string =>
	s.length === 0 ? s : `${s[0].toUpperCase()}${s.slice(1)}`;
