// The repository-config job in the runner image (ADR repo config: the root
// package `tartan`). Local Docker, not part of `deno task test`
// (it never needs Docker), like image.test.ts:
//
//   TARTAN_RUNNER_IMAGE=<image> [CUE_LINUX_BIN=<cue v0.17.1 for the image's arch>] \
//     [CUE_BIN=<cue v0.17.1 for this host>] deno test -A containers/runner/cue-job.test.ts
//
// With `CUE_BIN`, every corpus case's envelope from the container is
// compared with the host CLI evaluator's (same classifier, same bytes in).
//
// `CUE_LINUX_BIN` is mounted at /usr/local/bin/cue for an image built before
// the cue stage; an image from this Dockerfile has its own. The job script
// is always mounted from this checkout. Each case writes the bundle the way
// TartanSandbox's `writeFile` does (root's file in /tmp) and runs the exact
// command `cueJobCommand` builds, then classifies its result line with the
// sandbox's classifier. Under amd64 emulation on an arm64 host RLIMIT_AS is
// not enforced, so this proves fidelity and container health, not the
// memory limit (a native amd64 host does).

import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import {
	DEFAULT_EVAL_LIMITS,
	isEvalOk,
	REPO_CONFIG_LIMITS,
} from "@tartan/contract";
import { createCliEvaluator } from "../../src/kernel/repoconfig/evaluators/cli.ts";
import {
	caseRequest,
	cueBin,
} from "../../src/kernel/repoconfig/testing/corpus.ts";
import {
	buildCueBundle,
	classifyCueJob,
	cueBundlePath,
	cueJobCommand,
} from "../../src/kernel/runs/cue.ts";
import { asUid } from "../../src/kernel/runs/shell.ts";

const IMAGE = Deno.env.get("TARTAN_RUNNER_IMAGE") ?? "";
const CUE = Deno.env.get("CUE_LINUX_BIN") ?? "";
const PLATFORM = Deno.env.get("TARTAN_RUNNER_PLATFORM") ?? "linux/amd64";
const HERE = new URL(".", import.meta.url).pathname;
const HOST_CUE = cueBin();

const sh = async (
	cmd: string,
	args: string[],
	stdin?: string,
): Promise<{ code: number; stdout: string; stderr: string }> => {
	const child = new Deno.Command(cmd, {
		args,
		stdin: stdin === undefined ? "null" : "piped",
		stdout: "piped",
		stderr: "piped",
	}).spawn();
	if (stdin !== undefined) {
		const w = child.stdin.getWriter();
		await w.write(new TextEncoder().encode(stdin));
		await w.close();
	}
	const out = await child.output();
	return {
		code: out.code,
		stdout: new TextDecoder().decode(out.stdout),
		stderr: new TextDecoder().decode(out.stderr),
	};
};

let container = "";
let counter = 0;

const exec = (command: string, stdin?: string) =>
	sh("docker", [
		"exec",
		...(stdin === undefined ? [] : ["-i"]),
		container,
		"bash",
		"-c",
		command,
	], stdin);

/** Writes a bundle as `writeFile` would and runs one job; returns the envelope. */
const runJob = async (bundle: string, limits = DEFAULT_EVAL_LIMITS) => {
	const id = `cj_test${++counter}`;
	const write = await exec(`cat > ${cueBundlePath(id)}`, bundle);
	equal(write.code, 0, write.stderr);
	const started = Date.now();
	const out = await exec(cueJobCommand(id, limits));
	const ms = Date.now() - started;
	const gone = await exec(`test ! -e ${cueBundlePath(id)}`);
	equal(gone.code, 0, "the bundle is removed after the exec");
	return { envelope: classifyCueJob(out.stdout, { limits }), ms, raw: out };
};

const healthy = async () => {
	const r = await exec("true");
	equal(r.code, 0, "the container answers after the job");
};

const bundleOf = async (name: string) => {
	const b = buildCueBundle((await caseRequest(name)).files);
	if (!b.ok) throw new Error(b.message);
	return b.json;
};

/** What the container and the host CLI evaluator must agree on. */
const comparable = (r: ReturnType<typeof classifyCueJob>) =>
	isEvalOk(r)
		? { ok: r.ok }
		: { code: r.error.code, message: r.error.message, issues: r.issues };

/** Cases whose result does not depend on limits or timing. */
const STABLE_CASES = [
	"valid",
	"package-selection",
	"other-only",
	"import-registry",
	"import-repo-module",
	"import-job-module",
	"import-stdlib",
	"embed-parent",
	"embed-nonroot",
	"invalid",
	"invalid-closed",
	"pathological-string",
] as const;

Deno.test({
	name:
		"cue-job.sh in the runner image: the corpus, container health, no token, stale directories wiped",
	ignore: IMAGE === "",
	sanitizeResources: false,
	sanitizeOps: false,
	fn: async () => {
		const mounts = [
			"-v",
			`${HERE}cue-job.sh:/opt/tartan-cue/cue-job.sh:ro`,
			...(CUE === "" ? [] : ["-v", `${CUE}:/usr/local/bin/cue:ro`]),
		];
		const run = await sh("docker", [
			"run",
			"-d",
			"--rm",
			"--platform",
			PLATFORM,
			"--network",
			"none",
			"--memory",
			"4g",
			...mounts,
			"--entrypoint",
			"sleep",
			IMAGE,
			"infinity",
		]);
		equal(run.code, 0, run.stderr);
		container = run.stdout.trim();
		try {
			const version = await exec("cue version | head -1");
			equal(version.stdout.trim(), "cue version v0.17.1");
			// An image built before job 3 has no bundle directory yet.
			await exec("install -d -m 0755 -o root -g root /opt/tartan-cue/bundles");

			// A process a job left behind (code execution in cue) is
			// killed after the job, so it never sees the next repo's job.
			const sleeper = await exec(
				"setpriv --reuid=tartan-git --regid=tartan-git --init-groups -- sleep 600 > /dev/null 2>&1 &",
			);
			equal(sleeper.code, 0, sleeper.stderr);
			equal(
				(await exec("pgrep -u tartan-git sleep")).code,
				0,
				"a sleeper runs",
			);
			const first = await runJob(await bundleOf("valid"));
			ok(isEvalOk(first.envelope), JSON.stringify(first.envelope));
			// (A killed process stays a zombie under this test's `sleep` PID 1.)
			equal(
				(await exec("pgrep -u tartan-git -r R,S,D,T")).code,
				1,
				"no tartan-git process outlives the job",
			);
			// The bundle directory is root's: tartan-git cannot create entries.
			const plant = await exec(
				"setpriv --reuid=tartan-git --regid=tartan-git --init-groups -- ln -s /etc/shadow /opt/tartan-cue/bundles/bundle-cj_guess.json",
			);
			ok(plant.code !== 0, "no planted symlink in the bundle directory");

			// valid: package tartan beside another package's root file (env.cue).
			const valid = await runJob(await bundleOf("valid"));
			ok(isEvalOk(valid.envelope), JSON.stringify(valid.envelope));
			if (isEvalOk(valid.envelope)) {
				equal(valid.envelope.cueVersion, "v0.17.1");
				const value = valid.envelope.ok as Record<string, unknown>;
				deepStrictEqual(Object.keys(value).sort(), [
					"extensions",
					"global",
					"projects",
				]);
				deepStrictEqual(
					Object.keys(value.extensions as object).sort(),
					[
						"acme.labels",
						"acme.no-secrets",
						"tartan.ci",
						"tartan.review",
						"tartan.weave",
					],
				);
			}
			console.log(`valid: ${valid.ms} ms through docker exec`);

			// invalid-closed: positions point at the root file, no job path leaks.
			const closed = await runJob(await bundleOf("invalid-closed"));
			ok(!isEvalOk(closed.envelope));
			if (!isEvalOk(closed.envelope)) {
				equal(closed.envelope.error.code, "BUILD_VALUE");
				deepStrictEqual(
					closed.envelope.issues.map((i) => i.pos[0]),
					["tartan.cue:3:13", "tartan.cue:5:29", "tartan.cue:7:39"],
				);
				ok(!JSON.stringify(closed.envelope).includes("/tmp/tartan-cue"));
			}
			const invalid = await runJob(await bundleOf("invalid"));
			ok(!isEvalOk(invalid.envelope) && invalid.envelope.issues.length === 7);

			// The import rule: the job's module path is fresh per job and never
			// reaches issue text; a registry import is refused by name.
			const registry = await runJob(await bundleOf("import-registry"));
			ok(!isEvalOk(registry.envelope));
			if (!isEvalOk(registry.envelope)) {
				equal(registry.envelope.error.code, "INVALID_INPUT");
				equal(
					registry.envelope.error.message,
					"package tartan may import only the CUE standard library and tartan.dev/ext: `ci.cue:3:8` imports `github.com/acme/schemas/ci`",
				);
				ok(!/tartan\.local\/j/.test(JSON.stringify(registry.envelope)));
			}
			const other = await runJob(await bundleOf("other-only"));
			ok(
				isEvalOk(other.envelope) && JSON.stringify(other.envelope.ok) === "{}",
			);

			// Fidelity: the container and the host CLI evaluator agree.
			if (HOST_CUE !== null) {
				const host = createCliEvaluator({ cueBin: HOST_CUE });
				for (const name of STABLE_CASES) {
					const req = await caseRequest(name);
					const there = await runJob(await bundleOf(name));
					const here = await host.evaluate(req);
					deepStrictEqual(
						comparable(there.envelope),
						comparable(here as ReturnType<typeof classifyCueJob>),
						name,
					);
				}
				console.log(
					`fidelity: ${STABLE_CASES.length} cases equal to the host CLI evaluator`,
				);
			} else {
				console.warn("CUE_BIN is not set: the host fidelity check is skipped");
			}

			// CUE's own guards.
			const nesting = await runJob(await bundleOf("pathological-nesting"));
			ok(
				!isEvalOk(nesting.envelope) &&
					nesting.envelope.error.code === "LOAD_INSTANCE",
			);
			const str = await runJob(await bundleOf("pathological-string"));
			ok(!isEvalOk(str.envelope));
			if (!isEvalOk(str.envelope)) {
				match(str.envelope.issues[0].msg, /strings\.Repeat/);
			}
			await healthy();

			// The wall clock: SIGKILL at 10 s.
			const comp = await runJob(await bundleOf("pathological-comprehension"));
			ok(
				!isEvalOk(comp.envelope) && comp.envelope.error.code === "TIMEOUT",
				JSON.stringify(comp.envelope),
			);
			ok(comp.ms < 20_000, `${comp.ms} ms`);
			await healthy();

			// Doubling: the wall clock, RLIMIT_AS or the memory cgroup.
			const dbl = await runJob(await bundleOf("pathological-doubling"));
			ok(
				!isEvalOk(dbl.envelope) &&
					["TIMEOUT", "LIMIT_EXCEEDED"].includes(dbl.envelope.error.code),
				JSON.stringify(dbl.envelope),
			);
			console.log(
				`comprehension: ${
					isEvalOk(comp.envelope) ? "ok" : comp.envelope.error.code
				} in ${comp.ms} ms; doubling: ${
					isEvalOk(dbl.envelope)
						? "ok"
						: `${dbl.envelope.error.code} (${dbl.envelope.error.message})`
				} in ${dbl.ms} ms`,
			);
			await healthy();

			// An export over the file cap: cue ignores SIGXFSZ, its write fails
			// and it exits 1; the job reports the cap, with no job directory.
			const big = await runJob(await bundleOf("pathological-export"));
			ok(
				!isEvalOk(big.envelope) &&
					big.envelope.error.code === "LIMIT_EXCEEDED" &&
					big.envelope.error.message ===
						"output or error text reached the file cap",
				JSON.stringify(big.envelope),
			);
			ok(!/tartan-cue-|job\./.test(big.raw.stdout), big.raw.stdout);
			await healthy();

			// The error flood, inside the wall clock: the host reads ≤ 64 KiB.
			const flood = await runJob(await bundleOf("flood"));
			ok(!isEvalOk(flood.envelope));
			if (!isEvalOk(flood.envelope)) {
				ok(
					["LIMIT_EXCEEDED", "BUILD_VALUE"].includes(
						flood.envelope.error.code,
					),
					flood.envelope.error.code,
				);
				ok(flood.raw.stdout.length < REPO_CONFIG_LIMITS.stderrBytes * 3);
				console.log(
					`flood: ${flood.envelope.error.code} in ${flood.ms} ms, ${flood.raw.stdout.length} bytes of result line`,
				);
			}
			await healthy();

			// The unpacker re-checks every name before writing anything: a parent
			// path, a module file of the bundle's own (the job writes it) and a
			// bundle without the binding file are refused.
			const refusedBundles = [
				{
					"~tartan.cue": btoa("package tartan\n"),
					"../../etc/evil.cue": btoa("package tartan\n"),
				},
				{
					"~tartan.cue": btoa("package tartan\n"),
					"cue.mod/module.cue": btoa('module: "tartan.local/repo@v0"\n'),
				},
				{ "tartan.cue": btoa("package tartan\n") },
			];
			for (const files of refusedBundles) {
				const refused = await runJob(JSON.stringify({ v: 1, files }));
				ok(
					!isEvalOk(refused.envelope) &&
						refused.envelope.error.code === "INVALID_INPUT",
					JSON.stringify(Object.keys(files)),
				);
			}

			// No token or secret: the job sees an empty environment.
			const dump = [
				"#!/bin/sh",
				'if [ "$1" = version ]; then echo "cue version v0.17.1"; exit 0; fi',
				'while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done',
				'env | sort | node -e \'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s.trim().split("\\n").map(l=>l.split("=")[0]))))\' > "$out"',
				"",
			].join("\n");
			equal(
				(await exec("cat > /tmp/envdump.sh && chmod 755 /tmp/envdump.sh", dump))
					.code,
				0,
			);
			const id = `cj_env${++counter}`;
			await exec(`cat > ${cueBundlePath(id)}`, await bundleOf("valid"));
			const envRun = await exec(
				`${
					asUid("tartan-git", [
						"env",
						"-i",
						"PATH=/usr/local/bin:/usr/bin:/bin",
						"CUE_BIN=/tmp/envdump.sh",
						"/opt/tartan-cue/cue-job.sh",
						cueBundlePath(id),
					])
				}`,
				undefined,
			);
			const line = JSON.parse(envRun.stdout.trim().split("\n").pop()!);
			const names: string[] = JSON.parse(line.out);
			const allowed = new Set([
				"PATH",
				"HOME",
				"XDG_CACHE_HOME",
				"CUE_CACHE_DIR",
				"CUE_REGISTRY",
				"PWD",
				"SHLVL",
				"_",
			]);
			deepStrictEqual(
				names.filter((n) => !allowed.has(n)),
				[],
				names.join(","),
			);

			// Stale job directories of killed runs are wiped.
			const uid = (await exec("id -u tartan-git")).stdout.trim();
			const stale = `/tmp/tartan-cue-${uid}/job.stale`;
			await exec(
				asUid("tartan-git", [
					"bash",
					"-c",
					`mkdir -p ${stale} && touch -d '-10 minutes' ${stale}`,
				]),
			);
			await runJob(await bundleOf("valid"));
			equal(
				(await exec(`test ! -e ${stale}`)).code,
				0,
				"the stale directory is gone",
			);
			const left = await exec(`ls /tmp/tartan-cue-${uid} | wc -l`);
			equal(left.stdout.trim(), "0", "no job directory is left behind");
		} finally {
			await sh("docker", ["rm", "-f", container]);
		}
	},
});
