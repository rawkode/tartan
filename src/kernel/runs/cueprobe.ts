// Dev-stage probes of the repository-config evaluator sandboxes (`cue:trunk`,
// `cue:preview:<k>`; ADR repo config, "Live" testing). The
// switch may go on only once the evaluator's isolation is measured on the
// production runtime: no outbound network from `cue:*`, RLIMIT_AS stopping
// an allocation, the instance OOM killer taking `cue` and not the control
// server, and real timings. These probes run fixed commands only (never a
// caller's command): `info`, `net`, one evaluation of the caller's root
// files through the real job (`case`), and the same job without RLIMIT_AS
// (`oom`, the instance memory backstop).
//
//   POST /-/dev/cue {sandbox, probe, files?, limits?}
//
// Dev stages with dev tools only (`TARTAN_STAGE ^dev`, `TARTAN_DEV_TOOLS=1`),
// authorized by `x-tartan-dev-key` = hex(HMAC-SHA256(TARTAN_SECRET,
// "tartan:dev:cue")), which only the operator who set the secret can compute;
// 404 to anything else. The container holds no secret, and the answer
// carries none (job output is classified, then cut to a summary).

import {
	CUE_TRUNK_SANDBOX,
	type EvalLimits,
	type EvalResponse,
	httpStatus,
	invalid,
	isEvalOk,
	notFound,
	toWire,
} from "@tartan/contract";
import { createHash } from "node:crypto";
import type { RouteHandler } from "../../router.ts";

export const DEV_CUE_KEY_LABEL = "tartan:dev:cue";

export type CueProbeKind = "info" | "net" | "case" | "oom";

export type CueProbeInput = {
	readonly probe: CueProbeKind;
	/** `case` and `oom`: the bundle's files (the forge overlay and root `*.cue` files). */
	readonly files?: Readonly<Record<string, string>>;
	readonly limits?: Partial<EvalLimits>;
};

export type CueProbeResult = {
	readonly probe: CueProbeKind;
	readonly sandbox: string;
	/** Wall time of the probe's exec, as the control server saw it. */
	readonly ms: number;
	/**
	 * `info` and `net`: the fixed command's output (capped). `oom`: PID 1's
	 * start time before the job, then the `victim` command's output.
	 */
	readonly output?: string;
	/** `case` and `oom`: the classified envelope, summarized. */
	readonly result?: {
		readonly ok: boolean;
		readonly code?: string;
		readonly message?: string;
		readonly issues: number;
		/** The first issues: CUE path, positions (`file:line:col`), a short message. */
		readonly positioned?: readonly ProbeIssue[];
		readonly keys?: readonly string[];
		/**
		 * sha256 of `JSON.stringify(value)`: compared with a local `cue export`
		 * of the same files (byte-equal), without returning the value.
		 */
		readonly sha256?: string;
		/** The job's own `ms` (cue's run alone). */
		readonly jobMs?: number;
	};
	/** The container answered a trivial exec after the probe. */
	readonly healthy: boolean;
	readonly warm: boolean;
};

const AS_CONTENT =
	"setpriv --reuid=tartan-git --regid=tartan-git --init-groups --";

/** The fixed probe commands (run as root by the control server). */
export const CUE_PROBE_COMMANDS: Readonly<
	Record<"info" | "net" | "pid1" | "victim", string>
> = {
	info: [
		"uname -m",
		"nproc",
		"head -3 /proc/meminfo",
		"cat /sys/fs/cgroup/memory.max 2>/dev/null || echo memory.max=none",
		"cat /etc/tartan-runner.json",
		`${AS_CONTENT} bash -c 'ulimit -a' | tr -s ' ' | head -20`,
	].join("; echo ---; "),
	net: [
		"for who in root content; do",
		'  if [ "$who" = root ]; then p=""; else p="' + AS_CONTENT + '"; fi',
		'  $p bash -c "timeout 5 getent hosts cloudflare.com > /dev/null 2>&1; echo $who dns=\\$?"',
		"  $p bash -c \"timeout 5 bash -c 'exec 3<>/dev/tcp/1.1.1.1/443' 2> /dev/null; echo $who tcp443=\\$?\"",
		"  $p bash -c \"timeout 5 bash -c 'exec 3<>/dev/tcp/8.8.8.8/53' 2> /dev/null; echo $who tcp53=\\$?\"",
		"done",
		"echo ---",
		// The instance's network interfaces (names only; `ip` is not installed).
		"tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d ' '",
	].join("\n"),
	/** The control server's instance: PID 1's start time (clock ticks since boot). */
	pid1: "cut -d' ' -f22 /proc/1/stat",
	/**
	 * After `oom`: the kernel's OOM lines (the victim's name and pid) and
	 * PID 1's start time, which a restarted instance would change.
	 */
	victim: [
		"dmesg 2> /dev/null | grep -iE 'killed process|oom-kill|out of memory' | tail -4 | cut -c1-200",
		"echo ---",
		"cut -d' ' -f22 /proc/1/stat",
		"tr '\\0' ' ' < /proc/1/cmdline | cut -c1-60",
	].join("; "),
};

export type ProbeIssue = {
	readonly path: string;
	readonly pos: readonly string[];
	readonly msg: string;
};

/** Issues a summary carries, and how much of each. */
export const PROBE_ISSUES = { count: 8, positions: 3, path: 200, msg: 160 };

/**
 * A summary of an envelope: no repository text beyond short messages (the
 * caller's own files), and the value only as a digest.
 */
export const summarize = (
	envelope: EvalResponse,
): NonNullable<CueProbeResult["result"]> =>
	isEvalOk(envelope)
		? {
			ok: true,
			issues: 0,
			keys: typeof envelope.ok === "object" && envelope.ok !== null
				? Object.keys(envelope.ok).sort()
				: [],
			sha256: createHash("sha256").update(JSON.stringify(envelope.ok))
				.digest("hex"),
			...(envelope.ms === undefined ? {} : { jobMs: envelope.ms }),
		}
		: {
			ok: false,
			code: envelope.error.code,
			message: envelope.error.message.slice(0, 300),
			issues: envelope.issues.length,
			positioned: envelope.issues.slice(0, PROBE_ISSUES.count).map((i) => ({
				path: i.path.slice(0, PROBE_ISSUES.path),
				pos: i.pos.slice(0, PROBE_ISSUES.positions),
				msg: i.msg.slice(0, PROBE_ISSUES.msg),
			})),
			...(envelope.ms === undefined ? {} : { jobMs: envelope.ms }),
		};

const hex = (buffer: ArrayBuffer): string =>
	[...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0"))
		.join("");

/** `hex(HMAC-SHA256(secret, "tartan:dev:cue"))`. */
export const devCueKey = async (secret: string): Promise<string> => {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return hex(
		await crypto.subtle.sign(
			"HMAC",
			key,
			new TextEncoder().encode(DEV_CUE_KEY_LABEL),
		),
	);
};

const constantTimeEqual = (a: string, b: string): boolean => {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
};

const SANDBOX_RE = /^cue:(?:trunk|preview:[0-9]{1,2})$/;
const PROBES: readonly CueProbeKind[] = ["info", "net", "case", "oom"];

/** `POST /-/dev/cue`: one probe in one evaluator sandbox (dev stages only). */
export const handleDevCue: RouteHandler = async (c) => {
	const json = (body: unknown, status = 200) =>
		Response.json(body, {
			status,
			headers: { "cache-control": "no-store" },
		});
	try {
		const given = c.req.headers.get("x-tartan-dev-key");
		const secret = c.env.TARTAN_SECRET;
		const enabled = /^dev/.test(c.env.TARTAN_STAGE) &&
			c.env.TARTAN_DEV_TOOLS === "1";
		if (
			!enabled || given === null || !secret ||
			!constantTimeEqual(given, await devCueKey(secret))
		) {
			throw notFound("no such endpoint");
		}
		if (c.req.method !== "POST") throw notFound("use POST");
		let body: Record<string, unknown>;
		try {
			body = await c.req.json() as Record<string, unknown>;
		} catch {
			throw invalid("the body must be JSON");
		}
		const sandbox = typeof body.sandbox === "string"
			? body.sandbox
			: CUE_TRUNK_SANDBOX;
		if (!SANDBOX_RE.test(sandbox)) {
			throw invalid("sandbox: cue:trunk or cue:preview:<k>");
		}
		const probe = body.probe as CueProbeKind;
		if (!PROBES.includes(probe)) throw invalid(`probe: ${PROBES.join(", ")}`);
		const input: CueProbeInput = {
			probe,
			...(typeof body.files === "object" && body.files !== null
				? { files: body.files as Record<string, string> }
				: {}),
			...(typeof body.limits === "object" && body.limits !== null
				? { limits: body.limits as Partial<EvalLimits> }
				: {}),
		};
		const stub = c.env.SANDBOX.getByName(sandbox) as unknown as {
			cueProbe(input: CueProbeInput): Promise<CueProbeResult>;
		};
		return json(await stub.cueProbe(input));
	} catch (error) {
		const wire = toWire(error);
		return json(wire, httpStatus(wire.error));
	}
};
