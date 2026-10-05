// What the Work tab calls a work item: "work item" by
// default, "issue" when the installation's config says `wording: "classic"`
// (the Classic pack's `tartan.work` member). The interface (`work@1`, its
// tools and events) is the same either way; only the UI nouns change.

export type Wording = {
	/** "work item" / "issue". */
	readonly one: string;
	/** "work items" / "issues". */
	readonly many: string;
};

const DEFAULT: Wording = { one: "work item", many: "work items" };
const CLASSIC: Wording = { one: "issue", many: "issues" };

export const wordingOf = (config: unknown): Wording =>
	config !== null && typeof config === "object" &&
		(config as Record<string, unknown>).wording === "classic"
		? CLASSIC
		: DEFAULT;
