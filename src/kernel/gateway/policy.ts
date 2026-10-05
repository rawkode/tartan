// The canonical repo's receive-pack policy (WP4): pure functions over RepoDO's
// `pushContext` and the caller facts the gateway derives. No I/O, no clock:
// every input is an argument, so the table and its property tests run anywhere.
//
// - `canonicalPushPolicy` classifies every command; the first matching row
//   decides, and the gateway rejects the whole push when any command is
//   rejected (nothing is forwarded upstream).
// - `canonicalWritePrecheck` is an independent check: before a
//   canonical write token is requested, a user needs a write credential and
//   an agent an own active `branch`-backend lane in the repo.
// - `publicView` / `memberView` decide the upload-pack view.
//
// Rows 4–6 match only `branch`-backend lanes (`mode = 'branch'`); a `repo`
// lane's id under `refs/heads/lanes/` falls to row 5 on the canonical repo.
// - `laneRepoPolicy` is the lane-repo table of the `repo`
//   backend's lane remotes; layer 2 (the lane-repo-scoped upstream token)
//   holds even when it is wrong.

import {
	type EffectiveRole,
	isIdOf,
	isKernelRef,
	isReservedParent,
	isReservedRef,
	LANE_BRANCH_PREFIX,
	LANE_NOTES_PREFIX,
	LANE_REPO_HEAD_REF,
	laneIdFromBranchRef,
	type LaneState,
	NOTES_REF,
	RESERVED_REF_PARENTS,
	RESERVED_REF_PREFIXES,
	ROLE,
	scopesAllow,
	trunkRef,
	ZERO_SHA,
} from "@tartan/contract";
import type {
	AuthContext,
	CanonicalPushPolicy,
	CanonicalWritePrecheck,
	LaneRepoPushPolicy,
	PublicView,
	PushCaller,
	PushCommand,
	PushContext,
	RefPolicyDecision,
	RefPolicyReason,
} from "@tartan/contract/kernel.ts";
import { isValidPushRefname } from "@tartan/gitproto";

/** The longest refname the gateway accepts, in UTF-8 bytes. */
export const MAX_REFNAME_BYTES = 255;

/** Lane states in which a lane counts as active on the canonical repo. */
export const ACTIVE_LANE_STATES: ReadonlySet<LaneState> = new Set([
	"open",
	"submitted",
	"landing",
	"lost",
]);

/** The agent-notes refs of a `branch` lane (stretch). */
const LANE_NOTE_NAMES = new Set(["agent-trace", "ai"]);

/**
 * `PushContext` plus the exact spellings of the index's refs (RepoDO's
 * `refs()`), which the case-collision rule of row 0 needs to tell an update
 * of an existing ref from a different spelling of it. Absent: the policy
 * assumes the index holds lowercase names (conservative for mixed case).
 */
export type GatewayPushContext = PushContext & {
	readonly refNames?: readonly string[];
};

/** Case folding for the collision rules (repo names fold case too). */
export const fold = (ref: string): string => ref.toLowerCase();

const utf8Length = (text: string): number =>
	new TextEncoder().encode(text).length;

// ---------------------------------------------------------------------------
// Protected patterns: globs, `*` within a segment, `**` across segments; a
// bare pattern means `refs/heads/<pattern>` (the same grammar as RepoDO's
// `isProtectedRef`). Matched by a linear state-set simulation, never a
// backtracking RegExp.
// ---------------------------------------------------------------------------

type GlobToken =
	| { readonly kind: "char"; readonly char: string }
	| { readonly kind: "star" }
	| { readonly kind: "globstar" };

const tokenize = (pattern: string): GlobToken[] => {
	const full = pattern.startsWith("refs/") ? pattern : `refs/heads/${pattern}`;
	const chars = [...full];
	const tokens: GlobToken[] = [];
	for (let i = 0; i < chars.length; i++) {
		if (chars[i] === "*") {
			if (chars[i + 1] === "*") {
				tokens.push({ kind: "globstar" });
				i++;
			} else tokens.push({ kind: "star" });
		} else tokens.push({ kind: "char", char: chars[i] });
	}
	return tokens;
};

/** Adds `state` and every state reachable from it through stars (they match empty). */
const close = (tokens: readonly GlobToken[], states: Set<number>): void => {
	for (const state of [...states]) {
		let at = state;
		while (at < tokens.length && tokens[at].kind !== "char") {
			at++;
			states.add(at);
		}
	}
};

/** Whether `text` matches the glob `pattern` (anchored at both ends). */
export const globMatch = (pattern: string, text: string): boolean => {
	const tokens = tokenize(pattern);
	let states = new Set([0]);
	close(tokens, states);
	for (const char of text) {
		const next = new Set<number>();
		for (const state of states) {
			const token = tokens[state];
			if (token === undefined) continue;
			if (token.kind === "char") {
				if (token.char === char) next.add(state + 1);
			} else if (token.kind === "globstar" || char !== "/") {
				next.add(state);
			}
		}
		if (next.size === 0) return false;
		close(tokens, next);
		states = next;
	}
	return states.has(tokens.length);
};

/** Row 2: the default branch always, plus the inherited patterns; never a lane ref. */
export const isProtected = (
	ref: string,
	ctx: Pick<PushContext, "defaultBranch" | "protectedPatterns" | "importState">,
): boolean => {
	if (ctx.importState === "importing") return false;
	if (ref.startsWith(LANE_BRANCH_PREFIX)) return false;
	if (ref === trunkRef(ctx.defaultBranch)) return true;
	return ctx.protectedPatterns.some((pattern) => globMatch(pattern, ref));
};

/** A protected match only under another spelling. */
const protectedCaseVariant = (
	ref: string,
	ctx: Pick<PushContext, "defaultBranch" | "protectedPatterns" | "importState">,
): boolean => {
	if (ref.startsWith(LANE_BRANCH_PREFIX)) return false;
	const folded = fold(ref);
	const patterns = [trunkRef(ctx.defaultBranch), ...ctx.protectedPatterns];
	return patterns.some((pattern) =>
		globMatch(fold(pattern), folded) && !globMatch(pattern, ref)
	);
};

/** A reserved prefix, parent or `refs/notes/tartan` under another spelling. */
const reservedCaseVariant = (ref: string): boolean => {
	const folded = fold(ref);
	if (folded === NOTES_REF && ref !== NOTES_REF) return true;
	if (
		RESERVED_REF_PARENTS.some((parent) => folded === parent && ref !== parent)
	) {
		return true;
	}
	return RESERVED_REF_PREFIXES.some((prefix) =>
		folded.startsWith(prefix) && !ref.startsWith(prefix)
	);
};

/**
 * An existing ref of the index (or a live lane ref) under another spelling.
 * Lane refs are always lowercase (`refs/heads/lanes/ln_<ulid>`), so their
 * folded form is their spelling.
 */
const existingCaseVariant = (
	ref: string,
	ctx: GatewayPushContext,
	folded: ReadonlySet<string>,
): boolean => {
	const key = fold(ref);
	if (!folded.has(key)) return false;
	const exact = [
		...(ctx.refNames ?? []),
		...ctx.caseFoldedRefs.filter((name) => name.startsWith(LANE_BRANCH_PREFIX)),
	].filter((name) => fold(name) === key);
	if (exact.length === 0) return ref !== key;
	return exact.some((name) => name !== ref);
};

const adoptedCaseVariant = (ref: string, ctx: PushContext): boolean => {
	const key = fold(ref);
	return ctx.adopted.some((lane) => fold(lane.ref) === key && lane.ref !== ref);
};

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

type Verdict = RefPolicyReason | null;

const isDelete = (command: PushCommand): boolean => command.new === ZERO_SHA;

/** A lane the caller may write now: active, and a `lost` lane only inside its resume window. */
const writableState = (
	lane: { readonly state: LaneState; readonly resumable: boolean },
): boolean =>
	ACTIVE_LANE_STATES.has(lane.state) &&
	(lane.state !== "lost" || lane.resumable);

/** Row 0. */
const malformed = (
	command: PushCommand,
	ctx: GatewayPushContext,
	folded: ReadonlySet<string>,
): Verdict => {
	const { ref } = command;
	// Before validity: `refs/tartan` and `refs/tartan-work` have a single
	// component after `refs/`, which receive-pack would refuse as well.
	if (isReservedParent(ref)) return "reserved-parent";
	if (!isValidPushRefname(ref) || utf8Length(ref) > MAX_REFNAME_BYTES) {
		return "invalid-ref";
	}
	if (
		reservedCaseVariant(ref) ||
		existingCaseVariant(ref, ctx, folded) ||
		adoptedCaseVariant(ref, ctx) ||
		protectedCaseVariant(ref, ctx)
	) {
		return "case-collision";
	}
	return null;
};

/** Row 1: import mode; only the forge Owner, only heads and tags outside the reserved prefixes. */
const importing = (command: PushCommand, caller: PushCaller): Verdict => {
	const { ref } = command;
	const target = ref.startsWith("refs/heads/") || ref.startsWith("refs/tags/");
	return caller.kind === "user" && caller.forgeOwner && target &&
			!isReservedRef(ref)
		? null
		: "repo-importing";
};

/** Rows 4 and 5: `refs/heads/lanes/**`. */
const laneRef = (
	command: PushCommand,
	ctx: PushContext,
): Verdict => {
	const laneId = laneIdFromBranchRef(command.ref);
	const own = laneId === null
		? undefined
		: ctx.ownLanes.find((lane) =>
			lane.laneId === laneId && lane.mode === "branch" &&
			lane.ref === command.ref
		);
	if (own === undefined) return "not-your-lane";
	if (isDelete(command)) return "use-lanes-close";
	if (!writableState(own)) return "lane-closed";
	if (own.state === "landing") return "lane-landing";
	if (!ctx.caller.writeCredential) return "no-write-credential";
	if (own.leased) return "stale-old";
	const expected = own.headSha ?? ZERO_SHA;
	return command.old === expected ? null : "stale-old";
};

/** Row 6 (stretch): `refs/notes/lanes/<laneId>/{agent-trace,ai}` as row 4, no `old` check. */
const laneNotes = (command: PushCommand, ctx: PushContext): Verdict => {
	const rest = command.ref.slice(LANE_NOTES_PREFIX.length).split("/");
	const [laneId, name] = rest;
	const own = rest.length === 2 && isIdOf("lane", laneId) &&
			LANE_NOTE_NAMES.has(name)
		? ctx.ownLanes.find((lane) =>
			lane.laneId === laneId && lane.mode === "branch"
		)
		: undefined;
	if (own === undefined) return "not-your-lane";
	if (isDelete(command)) return "use-lanes-close";
	if (!writableState(own)) return "lane-closed";
	if (own.state === "landing") return "lane-landing";
	return ctx.caller.writeCredential ? null : "no-write-credential";
};

/** Row 7: the head ref of an active adopted lane; its owner and delegates only (users). */
const adoptedRef = (
	command: PushCommand,
	ctx: PushContext,
	caller: PushCaller,
): Verdict | undefined => {
	const adopted = ctx.adopted.find((lane) => lane.ref === command.ref);
	if (adopted === undefined) return undefined;
	if (caller.kind === "agent") return "lane-owned";
	const mine = adopted.owner === caller.principal ||
		adopted.delegates.includes(caller.principal);
	if (!mine) return "lane-owned";
	if (isDelete(command)) return "use-lanes-close";
	const lane = ctx.ownLanes.find((own) => own.ref === command.ref);
	if (lane?.state === "landing") return "lane-landing";
	return ctx.caller.writeCredential ? null : "no-write-credential";
};

const classify = (
	command: PushCommand,
	ctx: GatewayPushContext,
	caller: PushCaller,
	folded: ReadonlySet<string>,
): Verdict => {
	const row0 = malformed(command, ctx, folded);
	if (row0 !== null) return row0;
	if (ctx.importState === "importing") return importing(command, caller);
	const { ref } = command;
	if (isProtected(ref, ctx)) return "woven-by-tartan";
	if (isKernelRef(ref)) return "kernel-only";
	if (ref.startsWith(LANE_BRANCH_PREFIX)) return laneRef(command, ctx);
	if (ref.startsWith(LANE_NOTES_PREFIX)) return laneNotes(command, ctx);
	const adopted = adoptedRef(command, ctx, caller);
	if (adopted !== undefined) return adopted;
	if (ref.startsWith("refs/heads/")) {
		if (caller.kind === "agent") return "agents-lanes-only";
		return ctx.caller.writeCredential ? null : "no-write-credential";
	}
	if (ref.startsWith("refs/tags/")) {
		if (caller.kind === "agent" || caller.role < ROLE.maintainer) {
			return "tags-maintainer";
		}
		return ctx.caller.writeCredential ? null : "no-write-credential";
	}
	return "unsupported-ref";
};

/** The ref-policy table: one decision per command, in order. One rejection rejects the whole push. */
export const canonicalPushPolicy: CanonicalPushPolicy = (
	ctx: GatewayPushContext,
	commands,
	caller,
) => {
	const folded = new Set(ctx.caseFoldedRefs);
	return commands.map((command): RefPolicyDecision => {
		const reason = classify(command, ctx, caller, folded);
		return reason === null
			? { ref: command.ref, allow: true }
			: { ref: command.ref, allow: false, reason };
	});
};

// ---------------------------------------------------------------------------
// A lane remote (the `repo` backend)
// ---------------------------------------------------------------------------

/** L0: a case variant of `refs/heads/main` or of a canonical reserved name. */
const laneRepoCaseVariant = (ref: string): boolean =>
	(fold(ref) === LANE_REPO_HEAD_REF && ref !== LANE_REPO_HEAD_REF) ||
	reservedCaseVariant(ref);

const classifyLaneRepo = (
	command: PushCommand,
	ctx: PushContext,
	caller: PushCaller,
): Verdict => {
	const { ref } = command;
	// L0.
	if (isReservedParent(ref)) return "reserved-parent";
	if (!isValidPushRefname(ref) || utf8Length(ref) > MAX_REFNAME_BYTES) {
		return "invalid-ref";
	}
	if (laneRepoCaseVariant(ref)) return "case-collision";
	// Fail closed when the URL's lane is not a `repo` lane of this repo.
	const target = ctx.target;
	if (target === undefined || target.mode !== "repo") return "not-your-lane";
	// L1, L2: the lane's state decides before any ref does.
	if (target.state === "opening") return "lane-opening";
	if (!writableState(target)) return "lane-closed";
	if (target.state === "landing") return "lane-landing";
	// L5, L4.
	if (ref !== LANE_REPO_HEAD_REF) return "lane-main-only";
	if (isDelete(command)) return "use-lanes-close";
	// L3: the owner or a delegate, with a write credential, at the recorded head.
	const mine = target.owner === caller.principal ||
		target.delegates.includes(caller.principal);
	if (!mine) return "not-your-lane";
	if (caller.laneId !== null && caller.laneId !== target.laneId) {
		return "not-your-lane";
	}
	if (!ctx.caller.writeCredential) return "no-write-credential";
	if (target.leased) return "stale-old";
	// A create only while the lane repo has no `main` (never after a seed).
	if (command.old === ZERO_SHA) {
		return target.headSha === null ? null : "stale-old";
	}
	return command.old === target.headSha ? null : "stale-old";
};

/**
 * The lane-remote table: one decision per command of a push to a lane remote,
 * in order. Only `refs/heads/main` is ever writable, only by the lane's owner
 * or a delegate with a write credential, only while the lane is active and
 * neither `opening` nor `landing`, and only from the head the index records.
 * One rejection rejects the whole push.
 */
export const laneRepoPolicy: LaneRepoPushPolicy = (ctx, commands, caller) =>
	commands.map((command): RefPolicyDecision => {
		const reason = classifyLaneRepo(command, ctx, caller);
		return reason === null
			? { ref: command.ref, allow: true }
			: { ref: command.ref, allow: false, reason };
	});

/**
 * Independent of `canonicalPushPolicy`: a user needs a write credential, an
 * agent an own active `branch`-backend lane in this repo.
 * False ⇒ every command gets `agents-lanes-only` and no upstream token is
 * requested.
 */
export const canonicalWritePrecheck: CanonicalWritePrecheck = (ctx, caller) =>
	caller.kind === "user"
		? ctx.caller.writeCredential
		: ctx.ownLanes.some((lane) =>
			lane.mode === "branch" && writableState(lane)
		);

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** The scopes of a credential for `scopesAllow` (a session is unrestricted). */
const scopesOf = (auth: AuthContext) =>
	auth.via === "session" ? null : auth.scopes;

/**
 * The member view: an authenticated caller whose credential-bounded role is
 * at least Reporter and whose token scopes allow reading code.
 */
export const memberView = (
	auth: AuthContext | null,
	role: EffectiveRole,
): boolean =>
	auth !== null && role >= ROLE.reporter && scopesAllow(scopesOf(auth), "read");

/**
 * The one definition of the public view: a public repo read by
 * anyone who is not a member (anonymous, roleless or Guest, or a token whose
 * scopes or node subtree do not cover the repo).
 */
export const publicView: PublicView = (auth, repo) =>
	repo.node.visibility === "public" && !memberView(auth, repo.role);

/**
 * Step 5 for receive-pack: Developer+ on the repo (credential-bounded) and a
 * token carrying `lanes` or `repo:write`; everything else is decided per
 * command.
 */
export const mayReceivePack = (
	auth: AuthContext,
	role: EffectiveRole,
): boolean => {
	if (role < ROLE.developer) return false;
	const scopes = scopesOf(auth);
	return scopes === null || scopes.includes("lanes") ||
		scopes.includes("repo:write");
};
