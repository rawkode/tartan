// The dev-only evaluator probes: 404 unless
// on a dev stage with dev tools and the dev key, fixed probes only, and a
// summary that carries no repository text beyond a short message.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	CUE_EVAL_CONTRACT,
	CUE_EVALUATOR_ID,
	hostEvalError,
} from "@tartan/contract";
import type { RouteContext } from "../../router.ts";
import {
	CUE_PROBE_COMMANDS,
	type CueProbeInput,
	devCueKey,
	handleDevCue,
	summarize,
} from "./cueprobe.ts";

const SECRET = "s".repeat(43);

const ctx = (
	env: Record<string, string>,
	headers: Record<string, string>,
	body: unknown,
	probes: { sandbox: string; input: CueProbeInput }[],
) =>
	({
		env: {
			TARTAN_SECRET: SECRET,
			...env,
			SANDBOX: {
				getByName: (sandbox: string) => ({
					cueProbe: (input: CueProbeInput) => {
						probes.push({ sandbox, input });
						return Promise.resolve({ probe: input.probe, healthy: true });
					},
				}),
			},
		},
		req: new Request("https://forge.test/-/dev/cue", {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		}),
		params: {},
		auth: null,
	}) as unknown as RouteContext;

Deno.test("dev cue probes: 404 off dev stages, without dev tools or without the dev key; the key forwards one fixed probe", async () => {
	const key = await devCueKey(SECRET);
	const probes: { sandbox: string; input: CueProbeInput }[] = [];
	const body = { sandbox: "cue:preview:0", probe: "net" };
	const dev = { TARTAN_STAGE: "dev-wp23", TARTAN_DEV_TOOLS: "1" };
	for (
		const [env, headers] of [
			[{ TARTAN_STAGE: "prod", TARTAN_DEV_TOOLS: "1" }, {
				"x-tartan-dev-key": key,
			}],
			[{ TARTAN_STAGE: "dev-wp23", TARTAN_DEV_TOOLS: "0" }, {
				"x-tartan-dev-key": key,
			}],
			[dev, {}],
			[dev, { "x-tartan-dev-key": "0".repeat(64) }],
		] as const
	) {
		equal(
			(await handleDevCue(ctx(env, headers, body, probes))).status,
			404,
		);
	}
	equal(probes.length, 0);
	const res = await handleDevCue(
		ctx(dev, { "x-tartan-dev-key": key }, body, probes),
	);
	equal(res.status, 200);
	deepStrictEqual(probes, [{
		sandbox: "cue:preview:0",
		input: { probe: "net" },
	}]);
	// Another sandbox or an unknown probe is refused.
	equal(
		(await handleDevCue(
			ctx(dev, { "x-tartan-dev-key": key }, {
				sandbox: "git:x",
				probe: "net",
			}, probes),
		)).status,
		400,
	);
	equal(
		(await handleDevCue(
			ctx(dev, { "x-tartan-dev-key": key }, {
				sandbox: "cue:trunk",
				probe: "sh -c id",
			}, probes),
		)).status,
		400,
	);
	equal(probes.length, 1);
});

Deno.test("dev cue probes: fixed commands; a summary keeps a short message and no values", () => {
	ok(CUE_PROBE_COMMANDS.net.includes("/dev/tcp/1.1.1.1/443"));
	ok(CUE_PROBE_COMMANDS.net.includes("setpriv --reuid=tartan-git"));
	ok(CUE_PROBE_COMMANDS.net.includes("/proc/net/dev"));
	// The OOM victim and the control server's instance, read after the job.
	ok(CUE_PROBE_COMMANDS.victim.includes("dmesg"));
	ok(CUE_PROBE_COMMANDS.victim.includes("/proc/1/stat"));
	equal(CUE_PROBE_COMMANDS.pid1, "cut -d' ' -f22 /proc/1/stat");
	const failed = summarize(hostEvalError("TIMEOUT", "x".repeat(5000)));
	equal(failed.ok, false);
	equal(failed.code, "TIMEOUT");
	ok((failed.message ?? "").length <= 300);
	const passed = summarize({
		version: CUE_EVAL_CONTRACT,
		evaluator: CUE_EVALUATOR_ID,
		cueVersion: "v0.17.1",
		ok: { extensions: { secret: "value" }, projects: {} },
		issues: [],
	});
	deepStrictEqual(passed.keys, ["extensions", "projects"]);
	ok(!JSON.stringify(passed).includes("value"));
	// The value only as a digest of its JSON (compared with a local export).
	equal(
		passed.sha256,
		createHash("sha256").update(
			JSON.stringify({ extensions: { secret: "value" }, projects: {} }),
		).digest("hex"),
	);
	// Issues keep their positions, a short message and at most eight entries.
	const issues = Array.from({ length: 12 }, (_, i) => ({
		path: `extensions."tartan.weave".settings.batch${i}`,
		msg: "m".repeat(400),
		pos: ["tartan.cue:3:40", "tartan.cue:4:1", "a.cue:1:1", "b.cue:2:2"],
	}));
	const invalid = summarize({
		version: CUE_EVAL_CONTRACT,
		evaluator: CUE_EVALUATOR_ID,
		cueVersion: "v0.17.1",
		error: { code: "BUILD_VALUE", message: "conflicting values" },
		issues,
	});
	equal(invalid.issues, 12);
	equal(invalid.positioned?.length, 8);
	deepStrictEqual(invalid.positioned?.[0].pos, [
		"tartan.cue:3:40",
		"tartan.cue:4:1",
		"a.cue:1:1",
	]);
	equal(invalid.positioned?.[0].msg.length, 160);
	equal(invalid.sha256, undefined);
});
