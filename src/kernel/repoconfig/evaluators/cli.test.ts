// The CLI evaluator's file cap and path stripping, without a real `cue`: a
// fake binary behaves as cue's Go runtime does when its output file reaches
// RLIMIT_FSIZE (SIGXFSZ ignored, the write fails with EFBIG, exit 1), which
// must be reported as the file cap, not as BUILD_VALUE with the job
// directory in its message.

import { equal, ok } from "node:assert/strict";
import {
	CUE_EVAL_CONTRACT,
	CUE_EVALUATOR_ID,
	DEFAULT_EVAL_LIMITS,
	FORGE_BINDING_FILE,
	isEvalOk,
} from "@tartan/contract";
import { createCliEvaluator, unhost } from "./cli.ts";

const FAKE_CUE = `#!/bin/bash
if [ "$1" = version ]; then echo "cue version v0.17.1"; exit 0; fi
out=""
while [ $# -gt 0 ]; do
	if [ "$1" = "-o" ]; then out=$2; shift; fi
	shift
done
trap '' XFSZ
if ! head -c 1048576 /dev/zero > "$out" 2> /dev/null; then
	echo "write $out: file too large" >&2
	exit 1
fi
exit 0
`;

const withFakeCue = async (fn: (bin: string) => Promise<void>) => {
	const dir = await Deno.makeTempDir({ prefix: "tartan-fake-cue-" });
	try {
		const bin = `${dir}/cue`;
		await Deno.writeTextFile(bin, FAKE_CUE);
		await Deno.chmod(bin, 0o755);
		await fn(bin);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
};

const request = (outputFileKiB: number) => ({
	version: CUE_EVAL_CONTRACT,
	evaluator: CUE_EVALUATOR_ID,
	inputKey: "0".repeat(64),
	files: {
		[FORGE_BINDING_FILE]: "package tartan\n",
		"tartan.cue": "package tartan\n",
	},
	limits: { ...DEFAULT_EVAL_LIMITS, outputFileKiB },
});

Deno.test({
	name:
		"cli evaluator: an export that reaches the file cap is LIMIT_EXCEEDED (cue ignores SIGXFSZ and exits 1), with no temporary path",
	ignore: Deno.build.os === "windows",
	fn: () =>
		withFakeCue(async (bin) => {
			const r = await createCliEvaluator({ cueBin: bin }).evaluate(
				request(64),
			);
			ok(!isEvalOk(r), JSON.stringify(r));
			if (isEvalOk(r)) return;
			equal(r.error.code, "LIMIT_EXCEEDED");
			equal(r.error.message, "output or error text reached the file cap");
			equal(r.issues.length, 0);
			ok(!/tartan-cue-|\/tmp\/|\/var\//.test(JSON.stringify(r)));
		}),
});

Deno.test({
	name: "cli evaluator: under the cap the same fake export is not the file cap",
	ignore: Deno.build.os === "windows",
	fn: () =>
		withFakeCue(async (bin) => {
			// 1 MiB fits a 2 MiB cap: cue exited 0, and the output is over the
			// JSON limit (LIMIT_EXCEEDED by its size), never the file cap.
			const r = await createCliEvaluator({ cueBin: bin }).evaluate(
				request(2048),
			);
			ok(!isEvalOk(r));
			if (isEvalOk(r)) return;
			equal(r.error.code, "LIMIT_EXCEEDED");
			ok(/exported JSON of 1048576 bytes/.test(r.error.message));
		}),
});

Deno.test("unhost: the module root, then the call's root around it, as the job strips them", () => {
	const root = "/tmp/tartan-cue-1000/job.XXXXXXXXXX";
	const text =
		`write ${root}/out.json: file too large\n${root}/m/tartan.cue:1:2\nat ${root}/m`;
	equal(
		unhost(unhost(text, `${root}/m`), root),
		"write out.json: file too large\ntartan.cue:1:2\nat .",
	);
	equal(unhost("a/b", "/"), "a/b", "a root path is never stripped");
	equal(unhost("x", ""), "x");
});
