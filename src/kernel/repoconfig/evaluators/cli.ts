// A local `cue` subprocess behind tartan.cue-eval/1, for Deno tests and the
// CLI's `tartan config` helpers (`CUE_BIN`). Never used by the Worker: the
// forge evaluates only in a `cue:*` sandbox (ADR repo config).
//
// It writes the request's files to a temporary module root, adds
// `cue.mod/module.cue` with a module path fresh for the call (as the job
// does), runs the same command the job runs (`cue export -E --out json
// --force -o out.json .:tartan` with `CUE_REGISTRY=none` and an empty
// environment), kills it at the wall clock, caps the output file with
// RLIMIT_FSIZE (`ulimit -f`) and reads at most `stderrBytes` of stderr. It
// then prints the job's result line, with the module path replaced by
// `<module>`, and hands it to the sandbox's own classifier
// (`classifyCueJob`), so a test of this evaluator also tests the production
// classification.
// macOS has no RLIMIT_AS for a shell, so the address-space limit is the
// container's alone; tests keep memory-hungry cases short.

import {
	CUE_JOB_VERSION,
	type EvalRequest,
	type EvalResponse,
	FORGE_BINDING_FILE,
	FORGE_MODULE_PREFIX,
	forgeModuleFile,
	hostEvalError,
	stripForgeModule,
} from "@tartan/contract";
import {
	classifyCueJob,
	CUE_BUNDLE_PATH_RE,
	CUE_JOB_EXIT,
} from "../../runs/cue.ts";

/** A module path fresh for one call (128 random bits), as the job writes. */
export const freshModulePath = (): string => {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return `${FORGE_MODULE_PREFIX}${
		[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")
	}@v0`;
};

export type CliEvaluatorOptions = {
	/** The `cue` binary (`CUE_BIN`). */
	readonly cueBin: string;
	/** `cue version` of the binary; read once when omitted. */
	readonly cueVersion?: string;
};

const readCapped = async (
	stream: ReadableStream<Uint8Array>,
	max: number,
): Promise<{ text: string; bytes: number }> => {
	const reader = stream.getReader();
	const kept: Uint8Array[] = [];
	let keptBytes = 0;
	let bytes = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		bytes += value.byteLength;
		if (keptBytes < max) {
			const take = value.subarray(0, max - keptBytes);
			kept.push(take);
			keptBytes += take.byteLength;
		}
	}
	const all = new Uint8Array(keptBytes);
	let o = 0;
	for (const k of kept) {
		all.set(k, o);
		o += k.byteLength;
	}
	return { text: new TextDecoder().decode(all), bytes };
};

const versionOf = async (cueBin: string): Promise<string | null> => {
	const out = await new Deno.Command(cueBin, {
		args: ["version"],
		stdout: "piped",
		stderr: "null",
		clearEnv: true,
	}).output();
	const first = new TextDecoder().decode(out.stdout).split("\n")[0] ?? "";
	return first.startsWith("cue version ")
		? first.slice("cue version ".length).trim()
		: null;
};

const SIGNAL_EXIT: Readonly<Record<string, number>> = {
	SIGKILL: 137,
	SIGXFSZ: 153,
};

/**
 * Strips a directory from error text as the job does: `<dir>/` goes, a bare
 * `<dir>` reads `.`. The module root first, then the call's root around it
 * (the output file's path), so no temporary path reaches issue text.
 */
export const unhost = (text: string, dir: string): string =>
	dir.length > 1 ? text.split(`${dir}/`).join("").split(dir).join(".") : text;

export const createCliEvaluator = (options: CliEvaluatorOptions) => {
	let version: Promise<string | null> | null = options.cueVersion === undefined
		? null
		: Promise.resolve(options.cueVersion);

	const evaluate = async (request: EvalRequest): Promise<EvalResponse> => {
		for (const path of Object.keys(request.files)) {
			if (!CUE_BUNDLE_PATH_RE.test(path)) {
				return hostEvalError("INVALID_INPUT", `not a bundle path: ${path}`, {
					evaluator: request.evaluator,
				});
			}
		}
		if (!Object.hasOwn(request.files, FORGE_BINDING_FILE)) {
			return hostEvalError("INVALID_INPUT", `no ${FORGE_BINDING_FILE}`, {
				evaluator: request.evaluator,
			});
		}
		version ??= versionOf(options.cueBin);
		const cue = await version;
		const root = await Deno.makeTempDir({ prefix: "tartan-cue-" });
		const dir = `${root}/m`;
		try {
			for (const [path, text] of Object.entries(request.files)) {
				const full = `${dir}/${path}`;
				await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), {
					recursive: true,
				});
				await Deno.writeTextFile(full, text);
			}
			await Deno.mkdir(`${dir}/cue.mod`, { recursive: true });
			await Deno.writeTextFile(
				`${dir}/cue.mod/module.cue`,
				forgeModuleFile(freshModulePath()),
			);
			const out = `${root}/out.json`;
			const started = Date.now();
			const child = new Deno.Command("/bin/bash", {
				args: [
					"-c",
					'ulimit -f "$1" || exit 70; exec "$2" export -E --out json --force -o "$3" .:tartan',
					"cue-job",
					String(request.limits.outputFileKiB),
					options.cueBin,
					out,
				],
				cwd: dir,
				clearEnv: true,
				env: {
					PATH: "/usr/bin:/bin",
					HOME: root,
					XDG_CACHE_HOME: `${root}/cache`,
					CUE_CACHE_DIR: `${root}/cache`,
					CUE_REGISTRY: "none",
				},
				stdin: "null",
				stdout: "null",
				stderr: "piped",
			}).spawn();
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				try {
					child.kill("SIGKILL");
				} catch {
					// already gone
				}
			}, request.limits.wallClockS * 1000);
			const [err, status] = await Promise.all([
				readCapped(child.stderr, request.limits.stderrBytes),
				child.status,
			]);
			clearTimeout(timer);
			const ms = Date.now() - started;
			let rc = status.signal === null
				? status.code
				: SIGNAL_EXIT[status.signal] ?? 128;
			if (timedOut) rc = 124;
			let outText = "";
			let outBytes = 0;
			try {
				outBytes = (await Deno.stat(out)).size;
			} catch {
				outBytes = 0;
			}
			// As the job: cue ignores SIGXFSZ, so an export that reached the
			// file cap failed its write (EFBIG) and exited 1. That is the cap.
			if (
				rc === CUE_JOB_EXIT.cueErrors &&
				outBytes >= request.limits.outputFileKiB * 1024
			) {
				rc = CUE_JOB_EXIT.fileSize;
			}
			if (rc === 0 && outBytes <= request.limits.jsonBytes) {
				outText = await Deno.readTextFile(out).catch(() => "");
			}
			const line = JSON.stringify({
				job: CUE_JOB_VERSION,
				cue,
				rc,
				ms,
				out: outText,
				outBytes,
				err: stripForgeModule(unhost(unhost(err.text, dir), root)),
				errBytes: err.bytes,
			});
			return classifyCueJob(line, {
				evaluator: request.evaluator,
				limits: request.limits,
			});
		} finally {
			await Deno.remove(root, { recursive: true }).catch(() => {});
		}
	};

	return { evaluate };
};
