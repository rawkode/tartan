// WP5b live acceptance: the `repo` lane backend against real Artifacts, with
// lanes seeded by the real importer through a capability URL.
//
//   deno task live -- wp05b [--keep] [--evidence <file>]
//
// deploys `scripts/live/wp05b-harness.worker.ts` as the Worker
// `tartan-dev-wp05b` (Artifacts namespace `tartan-dev-wp05b`, nothing else;
// no containers), then:
//
//   1. a canonical repo (index row, create, genesis, one content commit);
//   2. 10 lanes opened concurrently by 10 agents: each `opening` at once,
//      then `open` on its own lane repo seeded with `import()` (seed p50/p95,
//      and any fallback taken);
//   3. a lane repo carries exactly `HEAD` → `refs/heads/main` at the base,
//      its seed intent is marked, its commit is readable by SHA;
//   4. pushes through the lane's own upstream token move the lane head; the
//      same token is refused by the canonical repo and another lane repo
//      (layer 2 of the lane-remote isolation);
//   5. a canonical repo whose default branch is `master`: the lane repo
//      still holds exactly `refs/heads/main`;
//   6. forged, malformed and receive-pack capability requests answer 404;
//   7. closed lanes are deleted by lane GC (gone from `ARTIFACTS.list()`);
//      an `l-*` repo with no lane is deleted by the orphan sweep;
//   8. the post-claim self-test passes, and with `/-/cap/*` blocked reports
//      `importer-unreachable`;
//   9. lane-repo reconciliation finds nothing to observe;
//  10. every response is leak-scanned; every repo and the Worker are
//      deleted (unless `--keep`).
//
// Credentials: the admin key is generated here, passed to `wrangler secret
// put` on stdin and never printed. No Artifacts token leaves the Worker.

const ROOT = new URL("../../", import.meta.url);
const WORKER = "tartan-dev-wp05b";
const NAMESPACE = "tartan-dev-wp05b";
const CONFIG = new URL(".wrangler/deploy/wrangler.wp05b-harness.jsonc", ROOT);
const LANES = 10;
const DAY = 24 * 60 * 60 * 1000;

const arg = (name: string): string | undefined => {
	const i = Deno.args.indexOf(`--${name}`);
	return i === -1 ? undefined : Deno.args[i + 1];
};
const keep = Deno.args.includes("--keep");
const evidencePath = arg("evidence");

type Step = { name: string; ok: boolean; detail: string; ms: number };
const steps: Step[] = [];
const evidence: Record<string, unknown> = {
	worker: WORKER,
	startedAt: new Date().toISOString(),
};

const step = async (
	name: string,
	run: () => Promise<true | string>,
): Promise<boolean> => {
	const started = performance.now();
	let ok = false;
	let detail = "";
	try {
		const result = await run();
		ok = result === true;
		if (typeof result === "string") detail = result;
	} catch (error) {
		detail = error instanceof Error ? error.message : String(error);
	}
	const ms = Math.round(performance.now() - started);
	steps.push({ name, ok, detail, ms });
	console.log(
		`${ok ? "PASS" : "FAIL"} ${name} (${ms} ms)${detail ? `: ${detail}` : ""}`,
	);
	return ok;
};

const decoder = new TextDecoder();
const run = async (
	cmd: string,
	args: string[],
	stdin?: string,
): Promise<{ code: number; out: string }> => {
	const child = new Deno.Command(cmd, {
		args,
		cwd: ROOT,
		stdin: stdin === undefined ? "null" : "piped",
		stdout: "piped",
		stderr: "piped",
	}).spawn();
	if (stdin !== undefined) {
		const writer = child.stdin.getWriter();
		await writer.write(new TextEncoder().encode(stdin));
		await writer.close();
	}
	const out = await child.output();
	return {
		code: out.code,
		out: decoder.decode(out.stdout) + decoder.decode(out.stderr),
	};
};

const renderConfig = async (): Promise<void> => {
	await Deno.mkdir(new URL(".wrangler/deploy/", ROOT), { recursive: true });
	await Deno.writeTextFile(
		CONFIG,
		JSON.stringify(
			{
				name: WORKER,
				main: "../../scripts/live/wp05b-harness.worker.ts",
				compatibility_date: "2026-08-15",
				compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
				workers_dev: true,
				observability: { enabled: false },
				artifacts: [{ binding: "ARTIFACTS", namespace: NAMESPACE }],
				durable_objects: {
					bindings: [
						{ name: "REPO", class_name: "HarnessRepo" },
						{ name: "FORGE", class_name: "HarnessForge" },
					],
				},
				migrations: [{
					tag: "v1",
					new_sqlite_classes: ["HarnessRepo", "HarnessForge"],
				}],
			},
			null,
			"\t",
		),
	);
};

const deploy = async (key: string): Promise<string> => {
	await renderConfig();
	const deployed = await run("npx", [
		"wrangler",
		"deploy",
		"-c",
		CONFIG.pathname,
	]);
	if (deployed.code !== 0) {
		throw new Error(`wrangler deploy failed:\n${deployed.out.slice(-3000)}`);
	}
	const url = /https:\/\/tartan-dev-wp05b\.[a-z0-9-]+\.workers\.dev/.exec(
		deployed.out,
	)?.[0];
	if (!url) throw new Error("no workers.dev URL in the deploy output");
	const secret = await run(
		"npx",
		["wrangler", "secret", "put", "HARNESS_KEY", "-c", CONFIG.pathname],
		key,
	);
	if (secret.code !== 0) throw new Error("wrangler secret put failed");
	return url;
};

const destroy = async (): Promise<void> => {
	const deleted = await run("npx", [
		"wrangler",
		"delete",
		"--name",
		WORKER,
		"--force",
	]);
	console.log(`worker ${WORKER} deleted: ${deleted.code === 0}`);
	await Deno.remove(CONFIG).catch(() => {});
};

// ---------------------------------------------------------------------------
// Leak scan of everything the driver sees
// ---------------------------------------------------------------------------

const LEAK = /art_v[0-9]+_(?!<redacted>)|\/-\/cap\/v1\/\d{10}\//;
const leaks: string[] = [];

const ulidChars = "0123456789abcdefghjkmnpqrstvwxyz";
const ulid = (): string => {
	let time = Date.now();
	let out = "";
	for (let i = 0; i < 10; i++) {
		out = ulidChars[time % 32] + out;
		time = Math.floor(time / 32);
	}
	const random = crypto.getRandomValues(new Uint8Array(16));
	for (const byte of random) out += ulidChars[byte % 32];
	return out;
};

const percentile = (values: readonly number[], p: number): number => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
};

// deno-lint-ignore no-explicit-any
type Json = any;

const main = async (): Promise<void> => {
	const key = [...crypto.getRandomValues(new Uint8Array(32))].map((b) =>
		b.toString(16).padStart(2, "0")
	).join("");
	let base = "";
	const deployed = await step("deploy the harness Worker", async () => {
		base = await deploy(key);
		return true;
	});
	if (!deployed) return;

	const call = async (op: string, body: unknown = {}): Promise<Json> => {
		const res = await fetch(`${base}/-/harness/${op}`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${key}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
		});
		const text = await res.text();
		if (LEAK.test(text)) leaks.push(op);
		if (!res.ok) throw new Error(`${op}: ${res.status} ${text.slice(0, 500)}`);
		return JSON.parse(text);
	};

	// The Worker and its secret take a few seconds to roll out.
	for (let i = 0; i < 30; i++) {
		const ok = await call("names").then(() => true, () => false);
		if (ok) break;
		await new Promise((r) => setTimeout(r, 2_000));
	}

	try {
		let repoId = "";
		let trunk = "";
		await step(
			"a canonical repo: index row, create, genesis, a content commit",
			async () => {
				const setup = await call("setup", {});
				repoId = setup.repoId;
				trunk = setup.trunk;
				evidence.repo = { repoId, trunk };
				return /^[0-9a-f]{40}$/.test(trunk) ||
					`no trunk: ${JSON.stringify(setup)}`;
			},
		);
		const agents = Array.from({ length: LANES }, () => `a_${ulid()}`);
		let lanes: Json[] = [];
		await step(
			`${LANES} lanes open concurrently: opening at once, then open on their own lane repos via import()`,
			async () => {
				const opened = await call("open", { repoId, owners: agents });
				lanes = opened.lanes;
				const opening = lanes.filter((l: Json) => l.state === "opening").length;
				evidence.openMs = opened.ms;
				const waited = await call("wait", {
					repoId,
					laneIds: lanes.map((l: Json) => l.id),
					ms: 60_000,
				});
				lanes = waited.lanes;
				const repoLanes = lanes.filter((l: Json) =>
					l.state === "open" && l.mode === "repo" && l.seed === "import"
				);
				const seedMs = repoLanes.map((l: Json) => l.seedMs as number);
				evidence.seed = {
					opening,
					openedOnImport: repoLanes.length,
					fallbacks: lanes.filter((l: Json) => l.mode !== "repo").map((
						l: Json,
					) => l.id),
					p50: seedMs.length ? percentile(seedMs, 0.5) : null,
					p95: seedMs.length ? percentile(seedMs, 0.95) : null,
					seedMs,
				};
				return opening === LANES && repoLanes.length === LANES ||
					`opening ${opening}, open on import ${repoLanes.length}: ${
						JSON.stringify(evidence.seed)
					}`;
			},
		);
		const first = lanes[0];
		await step(
			"a lane repo: exactly HEAD → refs/heads/main at the base, seed intent marked, commit readable by SHA",
			async () => {
				const seen = await call("inspect", { repoId, laneId: first.id });
				evidence.inspect = seen;
				const refs = seen.refs as {
					ref: string;
					sha: string;
					symrefTarget?: string;
				}[];
				const names = refs.map((r) => r.ref).sort();
				const main = refs.find((r) => r.ref === "refs/heads/main");
				const head = refs.find((r) => r.ref === "HEAD");
				const seed = (seen.intents as Json[]).find((i) =>
					i.purpose === "lane-seed"
				);
				const name = seen.detail.lane.repo_name as string;
				const expectedName = `l-${repoId}-${first.id.slice(3)}`;
				const ok = main?.sha === trunk && seen.lane.base === trunk &&
					seen.lane.head === trunk && name === expectedName &&
					(head === undefined || head.symrefTarget === "refs/heads/main") &&
					names.filter((n) => n !== "HEAD").join() === "refs/heads/main" &&
					["pushed", "observed"].includes(seed?.state) &&
					seen.commit?.hash === trunk;
				return ok ||
					JSON.stringify({
						names,
						main,
						head,
						seed,
						name,
						commit: seen.commit,
					});
			},
		);
		await step(
			"pushes through each lane's own upstream token move the lane heads",
			async () => {
				const results = [];
				for (const lane of lanes.slice(0, 3)) {
					const pushed = await call("push", {
						repoId,
						laneId: lane.id,
						owner: lane.owner,
					});
					const seen = await call("inspect", { repoId, laneId: lane.id });
					results.push(seen.lane.head === pushed.pushed.commit);
				}
				return results.every(Boolean) || JSON.stringify(results);
			},
		);
		await step(
			"layer 2: a lane's write token is refused by trunk and by another lane repo",
			async () => {
				const { statuses } = await call("layer2", {
					repoId,
					laneId: lanes[0].id,
					otherLaneId: lanes[1].id,
				});
				evidence.layer2 = statuses;
				return statuses.own === 200 &&
						[401, 403].includes(statuses.canonical) &&
						[401, 403].includes(statuses.otherLane) ||
					JSON.stringify(statuses);
			},
		);
		await step(
			"a canonical repo on master: the lane repo still holds exactly refs/heads/main",
			async () => {
				const setup = await call("setup", { defaultBranch: "master" });
				const opened = await call("open", {
					repoId: setup.repoId,
					owners: [`a_${ulid()}`],
				});
				const waited = await call("wait", {
					repoId: setup.repoId,
					laneIds: [opened.lanes[0].id],
					ms: 60_000,
				});
				const lane = waited.lanes[0];
				const seen = await call("inspect", {
					repoId: setup.repoId,
					laneId: lane.id,
				});
				const names = (seen.refs as Json[]).map((r) => r.ref).filter((
					n: string,
				) => n !== "HEAD");
				evidence.master = { lane, refs: seen.refs };
				return lane.mode === "repo" && names.join() === "refs/heads/main" &&
						(seen.refs as Json[]).find((r) => r.ref === "refs/heads/main")
								?.sha ===
							setup.trunk ||
					JSON.stringify({ lane, refs: seen.refs });
			},
		);
		await step(
			"forged, malformed and receive-pack capability requests answer a plain 404",
			async () => {
				const nowS = Math.floor(Date.now() / 1000) + 60;
				const forged = `/-/cap/v1/${nowS}/${first.id}/${"0".repeat(32)}/${
					"0".repeat(64)
				}/${repoId}.git`;
				const statuses = [];
				for (
					const path of [
						`${forged}/info/refs?service=git-upload-pack`,
						`${forged}/git-upload-pack`,
						`${forged}/info/refs?service=git-receive-pack`,
						"/-/cap/v1/nonsense",
					]
				) {
					const res = await fetch(`${base}${path}`, {
						method: path.endsWith("git-upload-pack") ? "POST" : "GET",
					});
					await res.body?.cancel();
					statuses.push(res.status);
				}
				return statuses.every((s) => s === 404) || JSON.stringify(statuses);
			},
		);
		await step(
			"lane GC deletes the repos of closed lanes (gone from ARTIFACTS.list)",
			async () => {
				const closing = lanes.slice(5);
				const names: string[] = [];
				for (const lane of closing) {
					const seen = await call("inspect", { repoId, laneId: lane.id });
					names.push(seen.detail.lane.repo_name);
					await call("close", { repoId, laneId: lane.id, owner: lane.owner });
				}
				const run = await call("gc", { repoId, at: Date.now() + DAY + 60_000 });
				const left = (await call("names")).names as string[];
				evidence.gc = { run, names };
				return run.deleted.length === closing.length &&
						names.every((n) => !left.includes(n)) ||
					JSON.stringify({
						run,
						stillListed: names.filter((n) => left.includes(n)),
					});
			},
		);
		await step(
			"the orphan sweep deletes an l-* repo with no lane (after 15 minutes)",
			async () => {
				const { name } = await call("orphan", { repoId });
				const firstPass = await call("sweep", { at: Date.now() });
				const secondPass = await call("sweep", {
					at: Date.now() + 16 * 60_000,
				});
				const left = (await call("names")).names as string[];
				evidence.sweep = {
					name,
					firstPass: firstPass.swept,
					secondPass: secondPass.swept,
				};
				return !firstPass.swept.deleted.includes(name) &&
						secondPass.swept.deleted.includes(name) && !left.includes(name) ||
					JSON.stringify(evidence.sweep);
			},
		);
		await step(
			"lane-repo reconciliation observes nothing on untouched and pushed lanes",
			async () => {
				const run = await call("reconcile", { repoId, at: Date.now() });
				evidence.reconcile = run;
				return run.checked >= 1 && run.observed === 0 || JSON.stringify(run);
			},
		);
		await step(
			"the post-claim self-test passes through the capability route",
			async () => {
				const { result, last } = await call("selftest", {});
				evidence.selftest = result;
				return result.ok === true && result.seed === "import" &&
						JSON.stringify(last) === JSON.stringify(result) ||
					JSON.stringify(result);
			},
		);
		await step(
			"with /-/cap/* blocked the self-test reports importer-unreachable",
			async () => {
				const { result } = await call("selftest", { blocked: true });
				evidence.selftestBlocked = result;
				return result.ok === false && result.code === "importer-unreachable" ||
					JSON.stringify(result);
			},
		);
		await step(
			"no Artifacts token or live capability path in any response",
			() => Promise.resolve(leaks.length === 0 || leaks.join(", ")),
		);
	} finally {
		await step("cleanup: every repo of the namespace deleted", async () => {
			const { deleted } = await call("cleanup");
			const left = (await call("names")).names as string[];
			evidence.cleanup = { deleted: deleted.length, left: left.length };
			return left.length === 0 || `${left.length} left`;
		}).catch(() => false);
		if (!keep) await destroy();
	}
};

await main();
evidence.steps = steps;
evidence.finishedAt = new Date().toISOString();
if (evidencePath !== undefined) {
	const text = JSON.stringify(evidence, null, "\t");
	if (LEAK.test(text)) {
		console.error("evidence not written: it failed the leak scan");
	} else await Deno.writeTextFile(evidencePath, text);
}
const failed = steps.filter((s) => !s.ok);
console.log(`\n${steps.length - failed.length}/${steps.length} steps passed`);
Deno.exit(failed.length === 0 ? 0 : 1);
