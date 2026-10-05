// Setup wizard steps. The kernel's `setup_state` decides
// the phase; within a phase the wizard advances as the owner completes steps.
//
//   fresh     → unlock (setup token from the URL fragment, or the logs code)
//   unlocked  → environment checks → name and origin → identity provider
//   idp       → claim ("sign in to become owner", a sign-in with purpose bootstrap)
//   done      → (signed-in admin) lane self-test → protocol pack → content →
//               people and agents → root key (button path only) → finished
//   done      → (anyone else) "this forge is set up" + sign in

export type WizardStep =
	| "unlock"
	| "checks"
	| "name"
	| "idp"
	| "claim"
	| "selftest"
	| "pack"
	| "content"
	| "people"
	| "secret"
	| "finished"
	| "already-set-up";

export type SetupPhase = "fresh" | "unlocked" | "idp" | "done";

export const PRE_CLAIM: readonly WizardStep[] = [
	"unlock",
	"checks",
	"name",
	"idp",
	"claim",
];

export const postClaimSteps = (rootKeyFallback: boolean): WizardStep[] => [
	"selftest",
	"pack",
	"content",
	"people",
	...(rootKeyFallback ? ["secret" as const] : []),
	"finished",
];

export const STEP_LABELS: Readonly<Record<WizardStep, string>> = {
	unlock: "Unlock",
	checks: "Environment",
	name: "Name and address",
	idp: "Identity provider",
	claim: "Claim ownership",
	selftest: "Lane self-test",
	pack: "Protocol",
	content: "Content",
	people: "People and agents",
	secret: "Root key",
	finished: "Done",
	"already-set-up": "Set up",
};

/** The first step for a phase (where the wizard lands on load). */
export const entryStep = (
	phase: SetupPhase,
	signedInAdmin: boolean,
): WizardStep => {
	switch (phase) {
		case "fresh":
			return "unlock";
		case "unlocked":
			return "checks";
		case "idp":
			return "claim";
		case "done":
			return signedInAdmin ? "selftest" : "already-set-up";
	}
};

/** The step after `step` in its phase (`finished` at the end). */
export const nextStep = (
	step: WizardStep,
	rootKeyFallback: boolean,
): WizardStep => {
	const order = PRE_CLAIM.includes(step)
		? PRE_CLAIM
		: postClaimSteps(rootKeyFallback);
	const index = order.indexOf(step);
	return index === -1 || index + 1 >= order.length
		? "finished"
		: order[index + 1] ?? "finished";
};

/** Whether `step` may be shown in `phase` (guards against stale UI state). */
export const stepAllowed = (step: WizardStep, phase: SetupPhase): boolean => {
	switch (step) {
		case "unlock":
			// Also after unlock, when the 30-minute setup session has expired.
			return phase !== "done";
		case "checks":
		case "name":
		case "idp":
			return phase === "unlocked" || phase === "idp";
		case "claim":
			return phase === "idp";
		case "already-set-up":
			return phase === "done";
		default:
			return phase === "done";
	}
};
