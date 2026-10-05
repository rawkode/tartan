// The launcher's run plumbing: every request bounded (http.ts), the drift
// guard between the deployed commit and this checkout (drift.ts), what a run
// skipped and why, and a private output directory (report.ts).

import { deepStrictEqual, equal, match, ok, rejects } from "node:assert/strict";
import * as path from "node:path";
import type { Run } from "../preflight.ts";
import { assertNoDrift, DRIFT_PATHS, driftLine, driftOf } from "./drift.ts";
import { evidenceFiles } from "./evidence.ts";
import { GuardError } from "./guards.ts";
import { FetchTimeoutError, timedFetch } from "./http.ts";
import {
	groupSkipped,
	SKIPPED_FILE,
	skippedLines,
	skippedMarkdown,
	skippedOf,
	tightenOutput,
} from "./report.ts";

/** A fetch that answers only when its signal aborts (a request that never ends). */
const hangingFetch =
	((_input: string | URL | Request, init?: RequestInit) =>
		new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener(
				"abort",
				() => reject(init.signal?.reason ?? new Error("aborted")),
			);
		})) as typeof fetch;

Deno.test("a launcher request that never ends fails with its method and path, not its query", async () => {
	const bounded = timedFetch(hangingFetch, 30);
	await rejects(
		bounded(
			"https://tartan-dev-e2e.acme.workers.dev/-/auth/login?invite=s3cret",
			{
				method: "GET",
			},
		),
		(e: unknown) =>
			e instanceof FetchTimeoutError &&
			e.message === "GET /-/auth/login: no answer after 0.03 s" &&
			!e.message.includes("s3cret"),
	);
	await rejects(
		timedFetch(hangingFetch, 30)("https://x.test/-/health/warm", {
			method: "post",
		}),
		/POST \/-\/health\/warm/,
	);
});

Deno.test("a bounded request passes through answers, errors and the caller's own signal", async () => {
	const answering = (() => Promise.resolve(new Response("ok"))) as typeof fetch;
	equal(
		await (await timedFetch(answering, 1000)("https://x.test/")).text(),
		"ok",
	);
	const failing = (() => Promise.reject(new TypeError("dns"))) as typeof fetch;
	await rejects(timedFetch(failing, 1000)("https://x.test/"), TypeError);
	const own = new AbortController();
	const pending = timedFetch(hangingFetch, 50)("https://x.test/", {
		signal: own.signal,
	});
	own.abort(new Error("the caller gave up"));
	await rejects(pending, /the caller gave up/);
	// Let the deadline's own timer run out inside the test.
	await new Promise((resolve) => setTimeout(resolve, 80));
});

const gitRun = (answer: { code: number; stdout: string }): {
	run: Run;
	calls: (readonly string[])[];
} => {
	const calls: (readonly string[])[] = [];
	return {
		calls,
		run: (_cmd, args) => {
			calls.push(args);
			return Promise.resolve({ ...answer, stderr: "" });
		},
	};
};

Deno.test("the drift guard compares the deployed commit with this checkout's forge paths", async () => {
	const commit = "c".repeat(40);
	const clean = gitRun({ code: 0, stdout: "" });
	const none = await driftOf({ run: clean.run, root: "/repo" }, commit);
	deepStrictEqual(none.paths, []);
	deepStrictEqual(clean.calls[0], [
		"diff",
		"--name-only",
		commit,
		"--",
		...DRIFT_PATHS,
	]);
	assertNoDrift(none, { allow: false, log: () => {} });

	const changed = gitRun({
		code: 0,
		stdout: "extensions/weave/tartan.json\nsrc/router.ts\n",
	});
	const drift = await driftOf({ run: changed.run, root: "/repo" }, commit);
	deepStrictEqual(drift.paths, [
		"extensions/weave/tartan.json",
		"src/router.ts",
	]);
	let error: unknown = null;
	try {
		assertNoDrift(drift, { allow: false, log: () => {} });
	} catch (e) {
		error = e;
	}
	ok(error instanceof GuardError);
	match(
		(error as Error).message,
		/cccccccccccc.*extensions\/weave\/tartan\.json.*--allow-drift/,
	);
	const warned: string[] = [];
	assertNoDrift(drift, { allow: true, log: (l) => warned.push(l) });
	match(warned[0], /^warning: .*\(--allow-drift\)$/);

	const unknown = await driftOf(
		{ run: gitRun({ code: 128, stdout: "" }).run, root: "/repo" },
		commit,
	);
	match(unknown.paths[0], /not in this checkout/);
	const noCommit = await driftOf({ run: clean.run, root: "/repo" }, null);
	match(noCommit.paths[0], /names no commit/);
	match(
		driftLine({ commit, paths: Array.from({ length: 12 }, (_, i) => `f${i}`) }),
		/f7 and 4 more$/,
	);
});

const REPORT = {
	schemaVersion: "report-1",
	run: {
		results: [
			{ status: "passed", file: "tests/a.e2e.ts", titlePath: ["a"] },
			{
				status: "skipped",
				file: "tests/loop/m1-loop.e2e.ts",
				titlePath: ["M1 loop", "5. CI runs in containers and goes green"],
				skip: {
					cause: "explicit",
					reason: "the M1 loop needs containers | off",
				},
			},
			{
				status: "skipped",
				file: "tests/loop/m1-loop.e2e.ts",
				titlePath: ["M1 loop", "7. the Weave lands both"],
				skip: {
					cause: "explicit",
					reason: "the M1 loop needs containers | off",
				},
			},
			{
				status: "skipped",
				file: "tests/claim/claim.e2e.ts",
				titlePath: ["claims"],
				skip: { cause: "filtered", reason: "carries an excluded tag" },
			},
			{ status: "skipped", file: "tests/x.e2e.ts", titlePath: ["no reason"] },
		],
	},
};

Deno.test("the run summary lists every skipped test, grouped by reason", () => {
	const skipped = skippedOf(REPORT);
	equal(skipped.length, 4);
	deepStrictEqual(skipped[0], {
		file: "tests/loop/m1-loop.e2e.ts",
		title: "M1 loop › 5. CI runs in containers and goes green",
		cause: "explicit",
		reason: "the M1 loop needs containers | off",
	});
	equal(skipped[3].reason, "(no reason given)");
	equal(skipped[3].cause, "unknown");
	const groups = groupSkipped(skipped);
	equal(groups[0].tests.length, 2);
	deepStrictEqual(skippedLines(skipped), [
		"skipped: 4 test(s)",
		"  2 × the M1 loop needs containers | off [explicit]",
		"  1 × (no reason given) [unknown]",
		"  1 × carries an excluded tag [filtered]",
	]);
	const md = skippedMarkdown("r202610051200abcd", skipped);
	match(md, /^### Skipped in r202610051200abcd: 4/);
	match(md, /\*\*the M1 loop needs containers \\\| off\*\* \(explicit, 2\)/);
	match(
		md,
		/- `tests\/loop\/m1-loop\.e2e\.ts` M1 loop › 7\. the Weave lands both/,
	);
	deepStrictEqual(skippedOf(null), []);
	deepStrictEqual(skippedOf({ run: {} }), []);
	deepStrictEqual(skippedLines([]), ["skipped: none"]);
	match(skippedMarkdown("r1", []), /Nothing was skipped/);
});

Deno.test("evidence carries the skipped list next to the summary", async () => {
	const files = await evidenceFiles({
		readText: () => Promise.resolve(null),
		list: () => Promise.resolve([]),
		write: () => Promise.resolve(),
	}, "/out");
	ok(files.includes(path.join("/out", SKIPPED_FILE)));
});

Deno.test("the output directory is made private: directories 0700, files 0600", async () => {
	const dir = await Deno.makeTempDir({ prefix: "tartan-e2e-out-" });
	try {
		await Deno.chmod(dir, 0o755);
		await Deno.mkdir(path.join(dir, "artifacts", "t"), {
			recursive: true,
			mode: 0o755,
		});
		await Deno.writeTextFile(path.join(dir, "report.json"), "{}", {
			mode: 0o644,
		});
		await Deno.writeTextFile(
			path.join(dir, "artifacts", "t", "trace.zip"),
			"z",
			{
				mode: 0o644,
			},
		);
		ok(await tightenOutput(dir) >= 4);
		const mode = async (p: string) => (await Deno.stat(p)).mode! & 0o777;
		equal(await mode(dir), 0o700);
		equal(await mode(path.join(dir, "artifacts", "t")), 0o700);
		equal(await mode(path.join(dir, "report.json")), 0o600);
		equal(await mode(path.join(dir, "artifacts", "t", "trace.zip")), 0o600);
		equal(await tightenOutput(dir), 0, "idempotent");
		equal(await tightenOutput(path.join(dir, "missing")), 0);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});
