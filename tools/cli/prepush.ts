// The git pre-push check (`tartan hooks install --git`; WP11). The edge uploads
// a whole push before the gateway can reject it, so this fails fast,
// before any upload:
//
// - the target: an agent writes only `main` of one of its lane remotes or
//   one of its `branch`-lane refs (`refs/heads/lanes/<id>`); nobody pushes
//   the canonical default branch (woven by Tartan), another principal's
//   lane, kernel refs, or anything but `main` on a lane remote; a human may
//   also push other branches (the gateway still decides);
// - no new object of `MAX_OBJECT_BYTES` (31 MiB) or more (Artifacts rejects
//   32 MiB after the upload);
// - the estimated pack (the on-disk size of the new objects) within
//   `MAX_PUSH_BYTES`.
// The gateway's policy remains the authority; this only saves the upload.

import { LANE_REPO_HEAD_REF, MAX_OBJECT_BYTES } from "@tartan/contract";
import type { Git } from "./git.ts";

export const ZERO = "0000000000000000000000000000000000000000";
/** `TARTAN_MAX_PUSH_MB` default, decimal MB. */
export const DEFAULT_MAX_PUSH_BYTES = 95_000_000;

const LANE_ID = /^ln_[0-7][0-9a-hjkmnp-tv-z]{25}$/;
const LANE_REMOTE =
	/^(.*?)\/-\/lanes\/(ln_[0-7][0-9a-hjkmnp-tv-z]{25})\.git\/?$/;
const KERNEL_REFS = ["refs/tartan/", "refs/heads/tartan/", "refs/tartan-work/"];

export type PushUpdate = {
	readonly localRef: string;
	readonly localSha: string;
	readonly remoteRef: string;
	readonly remoteSha: string;
};

/** git's pre-push stdin: `<local ref> <local sha> <remote ref> <remote sha>` per line. */
export const parsePushLines = (stdin: string): PushUpdate[] =>
	stdin.split(/\r?\n/).filter((l) => l.trim() !== "").map((line) => {
		const [localRef, localSha, remoteRef, remoteSha] = line.trim().split(/\s+/);
		return { localRef, localSha, remoteRef, remoteSha };
	});

export type PushRemote =
	| {
		readonly kind: "lane";
		readonly origin: string;
		readonly repoPath: string;
		readonly laneId: string;
	}
	| {
		readonly kind: "canonical";
		readonly origin: string;
		readonly repoPath: string;
	};

/** A remote URL on a forge: a lane remote or the canonical repo (userinfo dropped). */
export const classifyRemote = (url: string): PushRemote | null => {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
	let decoded = parsed.pathname;
	try {
		decoded = decodeURIComponent(parsed.pathname);
	} catch {
		// A malformed escape cannot name a forge path; keep it as is.
	}
	const path = decoded.replace(/^\/+/, "");
	const lane = LANE_REMOTE.exec(path);
	if (lane !== null) {
		return {
			kind: "lane",
			origin: parsed.origin,
			repoPath: lane[1],
			laneId: lane[2],
		};
	}
	return {
		kind: "canonical",
		origin: parsed.origin,
		repoPath: path.replace(/\/+$/, "").replace(/\.git$/, ""),
	};
};

export type Caller = {
	readonly kind: "agent" | "user";
	/** The default branch of the canonical repo (`refs/heads/<name>`). */
	readonly defaultBranch: string;
};

export type Rejection = {
	readonly ref: string;
	readonly reason: string;
	readonly message: string;
};

/** What a target needs: allowed, refused, or allowed if `laneId` is the caller's. */
export type TargetVerdict =
	| { readonly kind: "allow" }
	| { readonly kind: "reject"; readonly rejection: Rejection }
	| { readonly kind: "lane"; readonly laneId: string };

const reject = (
	ref: string,
	reason: string,
	message: string,
): TargetVerdict => ({
	kind: "reject",
	rejection: { ref, reason, message },
});

/** The target rule for one update, before lane ownership and sizes. */
export const checkTarget = (
	update: PushUpdate,
	remote: PushRemote,
	caller: Caller,
): TargetVerdict => {
	const ref = update.remoteRef;
	const deleting = update.localSha === ZERO;
	if (remote.kind === "lane") {
		if (ref !== LANE_REPO_HEAD_REF) {
			return reject(
				ref,
				"lane-main-only",
				`a lane remote has one writable ref: push HEAD:${LANE_REPO_HEAD_REF}`,
			);
		}
		if (deleting) {
			return reject(ref, "use-lanes-close", "close a lane with lanes_close");
		}
		return { kind: "lane", laneId: remote.laneId };
	}
	const trunk = `refs/heads/${caller.defaultBranch}`;
	if (ref === trunk) {
		return reject(
			ref,
			"woven-by-tartan",
			`${caller.defaultBranch} is woven by Tartan: push your lane (lanes_open / work_claim give the command)`,
		);
	}
	if (
		KERNEL_REFS.some((p) => ref.startsWith(p)) || ref === "refs/notes/tartan" ||
		ref.startsWith("refs/notes/tartan/")
	) {
		return reject(ref, "kernel-only", `${ref} is written by Tartan only`);
	}
	if (ref.startsWith("refs/heads/lanes/")) {
		const laneId = ref.slice("refs/heads/lanes/".length);
		if (!LANE_ID.test(laneId)) {
			return reject(ref, "not-your-lane", `${ref} is not a lane ref`);
		}
		if (deleting) {
			return reject(ref, "use-lanes-close", "close a lane with lanes_close");
		}
		return { kind: "lane", laneId };
	}
	if (caller.kind === "agent") {
		return reject(
			ref,
			"agents-lanes-only",
			"agents push only to their lanes: open one with lanes_open or work_claim",
		);
	}
	if (ref.startsWith("refs/heads/") || ref.startsWith("refs/tags/")) {
		return { kind: "allow" };
	}
	return reject(ref, "unsupported-ref", `${ref} is not a branch or a tag`);
};

export type NewObject = {
	readonly sha: string;
	readonly type: string;
	readonly size: number;
	readonly disk: number;
	readonly path?: string;
};

/**
 * Objects the push would send: reachable from the new tip and from no
 * remote-tracking ref (every remote: a lane remote's base is trunk) nor the
 * remote's current tip.
 */
export const newObjects = async (
	git: Git,
	update: PushUpdate,
): Promise<NewObject[]> => {
	const exclude = ["--not", "--remotes"];
	if (update.remoteSha !== ZERO) {
		const known = await git(["cat-file", "-e", `${update.remoteSha}^{commit}`]);
		if (known.code === 0) exclude.push(update.remoteSha);
	}
	const listed = await git([
		"rev-list",
		"--objects",
		update.localSha,
		...exclude,
	]);
	if (listed.code !== 0) {
		throw new Error(`git rev-list failed: ${listed.stderr.trim()}`);
	}
	const paths = new Map<string, string>();
	for (const line of listed.stdout.split("\n")) {
		if (line === "") continue;
		const space = line.indexOf(" ");
		const sha = space < 0 ? line : line.slice(0, space);
		paths.set(sha, space < 0 ? "" : line.slice(space + 1));
	}
	if (paths.size === 0) return [];
	const checked = await git(
		[
			"cat-file",
			"--batch-check=%(objectname) %(objecttype) %(objectsize) %(objectsize:disk)",
		],
		{ stdin: [...paths.keys()].join("\n") + "\n" },
	);
	if (checked.code !== 0) {
		throw new Error(`git cat-file failed: ${checked.stderr.trim()}`);
	}
	return checked.stdout.split("\n").filter((l) => l !== "").map((line) => {
		const [sha, type, size, disk] = line.split(" ");
		const path = paths.get(sha);
		return {
			sha,
			type,
			size: Number(size),
			disk: Number(disk),
			...(path ? { path } : {}),
		};
	});
};

const mib = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;

/** The size rules for one update's new objects. */
export const checkSizes = (
	ref: string,
	objects: readonly NewObject[],
	limits: { readonly maxPushBytes: number; readonly maxObjectBytes?: number },
): Rejection[] => {
	const maxObject = limits.maxObjectBytes ?? MAX_OBJECT_BYTES;
	const out: Rejection[] = [];
	for (const o of objects) {
		if (o.size >= maxObject) {
			out.push({
				ref,
				reason: "object-too-large",
				message: `${o.path || o.sha} is ${
					mib(o.size)
				}; each object must stay under ${
					mib(maxObject)
				} (Artifacts refuses 32 MiB)`,
			});
		}
	}
	const estimate = objects.reduce((n, o) => n + o.disk, 0);
	if (estimate > limits.maxPushBytes) {
		out.push({
			ref,
			reason: "push-too-large",
			message: `the push is about ${
				(estimate / 1e6).toFixed(1)
			} MB; the forge takes at most ${
				(limits.maxPushBytes / 1e6).toFixed(0)
			} MB per push: push it in smaller steps`,
		});
	}
	return out;
};
