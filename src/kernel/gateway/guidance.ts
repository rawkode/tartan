// Band-2 guidance for synthesized rejections (WP4): the `remote:` lines git
// prints under `! [remote rejected] …`. They are only sent when side-band was
// negotiated and `ECHO_ENABLED` is on (S3 pending); without them the `ng`
// reason alone reaches the client. Every line is plain text: the synthesizer
// strips control characters again.

import { type LaneState, trunkRef } from "@tartan/contract";
import type { RefPolicyReason } from "@tartan/contract/kernel.ts";

/** At most this many guidance lines per rejection (the echo budget's line cap). */
export const GUIDANCE_MAX_LINES = 10;
/** Each line is cut to this many characters. */
export const GUIDANCE_MAX_CHARS = 200;

/** The `ng` text of an allowed command in a push that was rejected as a whole. */
export const ATOMIC_REASON = "atomic: another ref was rejected";

export type GuidanceInput = {
	/** The repo's node path (`acme/shop`). */
	readonly repoPath: string;
	/** The canonical origin (`https://git.example.com`), for lane remote URLs. */
	readonly origin?: string;
	/** The lane remote the rejected push went to (`repo` backend). */
	readonly laneRemote?: string;
	readonly caller: { readonly kind: "user" | "agent" };
	readonly defaultBranch: string;
	/** The caller's lanes on this repo (`pushContext.ownLanes`). */
	readonly ownLanes: readonly {
		readonly laneId: string;
		readonly mode: string;
		readonly ref: string;
		readonly state: LaneState;
	}[];
	/** The distinct rejection reasons, in command order. */
	readonly reasons: readonly RefPolicyReason[];
	/** `MAX_PUSH_BYTES`, for `push-too-large`. */
	readonly maxPushBytes: number;
};

const PREFIX = "tartan ▸ ";

const branchName = (ref: string): string => ref.replace(/^refs\/heads\//, "");

/** A lane remote's URL (`laneRemotePath` under the canonical origin). */
export const laneRemoteUrl = (
	input: Pick<GuidanceInput, "origin" | "repoPath">,
	laneId: string,
): string => `${input.origin ?? ""}/${input.repoPath}/-/lanes/${laneId}.git`;

/**
 * How the caller pushes its lane (the lane handle's command): its lane
 * remote's `main` on the `repo` backend, `refs/heads/lanes/<id>` of the
 * canonical repo on the `branch` backend.
 */
const laneLines = (input: GuidanceInput): string[] => {
	const open = input.ownLanes.filter((lane) =>
		lane.state !== "landing" && lane.state !== "opening"
	);
	if (open.length === 0) {
		return input.caller.kind === "agent"
			? [
				`  no lane yet? MCP work_claim, or: tartan lane open --work ${input.repoPath}#<n>`,
			]
			: [
				"  push a branch:  git push origin HEAD:refs/heads/<name>, then: tartan submit",
			];
	}
	const [first] = open;
	const ids = open.slice(0, 3).map((lane) => lane.laneId).join(", ");
	const more = open.length > 3 ? ", …" : "";
	const command = first.mode === "repo"
		? `git push ${laneRemoteUrl(input, first.laneId)} HEAD:main`
		: `git push origin HEAD:${first.ref}`;
	return [`  push your lane:  ${command}    (open lanes: ${ids}${more})`];
};

/** The push command of the lane remote a rejected push went to. */
const laneRemoteLine = (input: GuidanceInput): string[] =>
	input.laneRemote === undefined ? [] : [
		`  push this lane:  git push ${
			laneRemoteUrl(input, input.laneRemote)
		} HEAD:main`,
	];

const reasonLines = (
	reason: RefPolicyReason,
	input: GuidanceInput,
): string[] => {
	const main = branchName(trunkRef(input.defaultBranch));
	switch (reason) {
		case "woven-by-tartan":
			return [
				`${PREFIX}${main} is woven by Tartan; nobody pushes it directly.`,
				...laneLines(input),
			];
		case "agents-lanes-only":
			return [
				`${PREFIX}agents push only to their own lanes.`,
				...laneLines(input),
			];
		case "not-your-lane":
			return [
				`${PREFIX}that lane is not yours (or does not exist); push your own lane.`,
				...laneLines(input),
			];
		case "lane-closed":
			return [`${PREFIX}that lane is closed; open a new lane to continue.`];
		case "lane-landing":
			return [
				`${PREFIX}your lane is landing and frozen until its batch ends; push again afterwards.`,
			];
		case "lane-owned":
			return [
				`${PREFIX}that branch is an adopted lane; only its owner and delegates push it.`,
			];
		case "stale-old":
			return [
				`${PREFIX}your lane moved on the server; fetch, rebase onto it, then push again.`,
			];
		case "use-lanes-close":
			return [
				`${PREFIX}lanes are not deleted by push; close them with MCP lanes_close or: tartan lane close <laneId>`,
			];
		case "kernel-only":
			return [
				`${PREFIX}refs/tartan/*, refs/heads/tartan/* and refs/notes/tartan are written only by Tartan.`,
			];
		case "tags-maintainer":
			return [`${PREFIX}tags need the Maintainer role (agents never tag).`];
		case "no-write-credential":
			return [
				`${PREFIX}this credential cannot write here (it needs the lanes or repo:write scope and Developer+).`,
			];
		case "case-collision":
			return [
				`${PREFIX}that ref differs only in letter case from an existing or reserved ref.`,
			];
		case "reserved-parent":
			return [
				`${PREFIX}that ref name is reserved: it would block a namespace Tartan uses.`,
			];
		case "repo-importing":
			return [
				`${PREFIX}this repo is being imported; only the forge Owner pushes until import completes.`,
			];
		case "push-too-large":
			return [
				`${PREFIX}this push is over the ${
					Math.floor(input.maxPushBytes / 1_000_000)
				} MB limit; push history in smaller segments.`,
			];
		case "object-too-large":
			return [
				`${PREFIX}a git object of 32 MiB or more cannot be stored; check before pushing: tartan hooks install --git`,
			];
		case "too-many-commands":
			return [
				`${PREFIX}too many refs in one push (agents: 8, people: 1,000); push fewer at a time.`,
			];
		case "malformed-push":
			return [
				`${PREFIX}the push request was refused (signed pushes, shallow pushes and push options are not accepted).`,
			];
		case "lane-opening":
			return [
				`${PREFIX}this lane is still opening (its repository is being seeded); push again in a few seconds.`,
			];
		case "lane-main-only":
			return [
				`${PREFIX}a lane remote has one branch, main; nothing else is pushed to it.`,
				...laneRemoteLine(input),
			];
		case "invalid-ref":
		case "unsupported-ref":
			return [`${PREFIX}${reason}`];
	}
};

/** The guidance lines for one rejected push (≤ `GUIDANCE_MAX_LINES`, each ≤ `GUIDANCE_MAX_CHARS`). */
export const guidanceLines = (input: GuidanceInput): string[] => {
	const lines: string[] = [];
	for (const reason of new Set(input.reasons)) {
		for (const line of reasonLines(reason, input)) {
			if (!lines.includes(line)) lines.push(line);
		}
	}
	return lines.slice(0, GUIDANCE_MAX_LINES).map((line) =>
		line.length > GUIDANCE_MAX_CHARS
			? `${line.slice(0, GUIDANCE_MAX_CHARS - 1)}…`
			: line
	);
};
