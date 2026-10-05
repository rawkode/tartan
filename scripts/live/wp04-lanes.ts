// WP4 live acceptance for the `repo` lane backend (U59, the lane-remote table).
//
//   deno run -A scripts/live/wp04-lanes.ts [--keep]
//       deploys `scripts/live/wp04-lanes.worker.ts` as the Worker
//       `tartan-dev-wp04` (Artifacts namespace `tartan-dev-wp04`, nothing
//       else, no route or domain), imports a small public `master` repo as
//       the canonical repo, seeds lane repos with Artifacts' real importer
//       through the capability route, drives lane remotes with stock git,
//       probes the route's negative cases and layer 2, prints one line per
//       step, then deletes every repo of the namespace and the Worker
//       (unless `--keep`).
//
// Credentials: the admin key and the root secret are generated here, passed
// to `wrangler secret put` on stdin and never printed; git tokens travel as
// an `http.extraHeader`, never in a URL; capability paths stay in memory and
// every printed line goes through `redactSecrets`.

import { redactSecrets } from "@tartan/contract";
import {
	commitFile,
	git,
	type GitResult,
	makeSandbox,
	revParse,
	type Sandbox,
} from "../../src/kernel/gateway/testing/git.ts";
import { scanTextForLeaks } from "../smoke/lib/leakscan.ts";

const ROOT = new URL("../../", import.meta.url);
const WORKER = "tartan-dev-wp04";
const NAMESPACE = "tartan-dev-wp04";
const CONFIG = new URL(".wrangler/deploy/wrangler.wp04-lanes.jsonc", ROOT);
/** A small public repo whose default branch is `master` (U59's shape). */
const SOURCE = "https://github.com/octocat/Hello-World.git";

type Step = { name: string; ok: boolean; detail: string; ms: number };
const steps: Step[] = [];
const printed: string[] = [];

const say = (line: string): void => {
	const safe = redactSecrets(line);
	printed.push(safe);
	console.log(safe);
};

const step = async (
	name: string,
	run: () => Promise<boolean | string>,
): Promise<boolean> => {
	const started = performance.now();
	let ok = false;
	let detail = "";
	try {
		const result = await run();
		ok = result === true || result === "";
		if (typeof result === "string") detail = result;
	} catch (error) {
		detail = error instanceof Error ? error.message : String(error);
	}
	const ms = Math.round(performance.now() - started);
	steps.push({ name, ok, detail, ms });
	say(
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

const randomHex = (bytes: number): string =>
	[...crypto.getRandomValues(new Uint8Array(bytes))].map((b) =>
		b.toString(16).padStart(2, "0")
	).join("");

const renderConfig = async (): Promise<void> => {
	await Deno.mkdir(new URL(".wrangler/deploy/", ROOT), { recursive: true });
	await Deno.writeTextFile(
		CONFIG,
		JSON.stringify(
			{
				name: WORKER,
				main: "../../scripts/live/wp04-lanes.worker.ts",
				compatibility_date: "2026-08-15",
				compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
				workers_dev: true,
				artifacts: [{ binding: "ARTIFACTS", namespace: NAMESPACE }],
				durable_objects: {
					bindings: [{ name: "LANES", class_name: "HarnessLanes" }],
				},
				migrations: [{ tag: "v1", new_sqlite_classes: ["HarnessLanes"] }],
			},
			null,
			"\t",
		),
	);
};

const deploy = async (secrets: Record<string, string>): Promise<string> => {
	await renderConfig();
	const deployed = await run("npx", [
		"wrangler",
		"deploy",
		"-c",
		CONFIG.pathname,
	]);
	if (deployed.code !== 0) {
		throw new Error(`wrangler deploy failed:\n${redactSecrets(deployed.out)}`);
	}
	const url = /https:\/\/tartan-dev-wp04\.[a-z0-9-]+\.workers\.dev/.exec(
		deployed.out,
	)?.[0];
	if (!url) throw new Error("no workers.dev URL in the deploy output");
	for (const [name, value] of Object.entries(secrets)) {
		const secret = await run(
			"npx",
			["wrangler", "secret", "put", name, "-c", CONFIG.pathname],
			value,
		);
		if (secret.code !== 0) {
			throw new Error(`wrangler secret put ${name} failed`);
		}
	}
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
	say(`worker ${WORKER} deleted: ${deleted.code === 0}`);
	await Deno.remove(CONFIG).catch(() => {});
};

type Principal = { token: string; principal: string };

const scenario = async (base: string, key: string): Promise<void> => {
	// deno-lint-ignore no-explicit-any
	const adminCall = async (action: string, body?: unknown): Promise<any> => {
		const response = await fetch(`${base}/-/harness/${action}`, {
			method: body === undefined ? "GET" : "POST",
			headers: {
				authorization: `Bearer ${key}`,
				"content-type": "application/json",
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		if (!response.ok) {
			throw new Error(
				`admin ${action}: ${response.status} ${
					redactSecrets(await response.text())
				}`,
			);
		}
		return await response.json();
	};
	for (let i = 0; i < 30; i++) {
		const probe = await fetch(`${base}/-/harness/state`, {
			headers: { authorization: `Bearer ${key}` },
		}).catch(() => null);
		const ok = probe?.status === 200;
		await probe?.body?.cancel();
		if (ok) break;
		await new Promise((r) => setTimeout(r, 1_500));
	}
	// Let the version that carries the secrets settle everywhere.
	await new Promise((r) => setTimeout(r, 5_000));
	const sandbox: Sandbox = await makeSandbox();
	const as = (who: Principal | null, args: string[], cwd?: string) =>
		git(
			sandbox,
			who === null ? args : [
				"-c",
				`http.extraHeader=Authorization: Basic ${btoa(`x:${who.token}`)}`,
				...args,
			],
			{ cwd, allowFail: true },
		);
	const rejected = (out: GitResult, reason: string) =>
		out.code !== 0 && out.stderr.includes(`(${reason})`)
			? ""
			: `code ${out.code}: ${
				redactSecrets(
					out.stderr.split("\n").filter((l) =>
						l.includes("rejected") || l.includes("fatal")
					).join(" | "),
				)
			}`;
	const laneUrl = (id: string) => `${base}/acme/shop/-/lanes/${id}.git`;
	try {
		let trunk = "";
		const setUp = await step(
			"setup: a public master repo imported as the canonical repo",
			async () => {
				const setup = await adminCall("setup", { source: SOURCE });
				trunk = setup.trunk;
				say(
					`  defaultBranch=${setup.defaultBranch} branches=${
						JSON.stringify(setup.branches)
					} trunk=${setup.trunk} importMs=${setup.importMs}`,
				);
				return setup.defaultBranch === "master"
					? ""
					: "default branch is not master";
			},
		);
		if (!setUp) return;
		const agentA: Principal = await adminCall("mint", {
			kind: "agent",
			role: 30,
		});
		const agentB: Principal = await adminCall("mint", {
			kind: "agent",
			role: 30,
		});
		// deno-lint-ignore no-explicit-any
		let laneA: any = null;
		// deno-lint-ignore no-explicit-any
		let laneB: any = null;
		const seeded = await step(
			"S16/U59: Artifacts' importer seeds a lane repo through the capability route; it holds exactly HEAD -> refs/heads/main at the base of a master repo",
			async () => {
				laneA = await adminCall("open-lane", { owner: agentA.principal });
				say(
					`  importMs=${laneA.importMs} refs=${JSON.stringify(laneA.refs)}${
						laneA.importError ? ` error=${laneA.importError}` : ""
					}`,
				);
				if (laneA.importError) return laneA.importError;
				return laneA.ok && laneA.base === trunk
					? ""
					: "lane repo not as expected";
			},
		);
		await step(
			"the importer's requests: one info/refs and one pack request, user agent and ASN recorded; capReport served with the pack size",
			async () => {
				const state = await adminCall("state");
				// deno-lint-ignore no-explicit-any
				const events = state.capEvents as any[];
				const requests = events.filter((e) => e.kind === "request").map((e) =>
					e.data
				);
				const uses = events.filter((e) =>
					e.kind === "capUse" && e.lane_id === laneA.laneId
				).map((e) => `${e.data.op}:${e.data.ok}`);
				const reports = events.filter((e) =>
					e.kind === "capReport" && e.lane_id === laneA.laneId
				).map((e) => e.data);
				say(`  requests=${JSON.stringify(requests)}`);
				say(
					`  capUse=${JSON.stringify(uses)} capReport=${
						JSON.stringify(reports)
					}`,
				);
				const served = reports.find((r) => r.outcome === "served");
				return uses.join(",") === "info:true,pack:true" && served?.bytes > 0
					? ""
					: "unexpected capability use";
			},
		);
		if (!seeded) return;
		await step(
			"the per-request trunk read tokens (TTL 120 s) are revoked",
			async () => {
				await new Promise((r) => setTimeout(r, 2_000));
				// deno-lint-ignore no-explicit-any
				const tokens = await adminCall("tokens") as any[];
				say(`  canonical tokens: ${JSON.stringify(tokens)}`);
				// The route's tokens are the short ones (TTL 120 s); the
				// harness's own RepoDO stand-in mints 600 s ones.
				const active = tokens.filter((t) =>
					t.ttlS <= 125 && t.state === "active"
				);
				return active.length === 0 ? "" : "a capability token is still active";
			},
		);
		await step(
			"the consumed capability is refused on replay; a flipped MAC, an expired and an over-TTL capability are plain 404s",
			async () => {
				const path = laneA.capPath as string;
				const fields = laneA.capFields;
				const replay = await fetch(
					`${base}${path}/info/refs?service=git-upload-pack`,
				);
				await replay.body?.cancel();
				const mac = path.split("/")[7];
				const flipped = path.replace(
					mac,
					`${mac[0] === "a" ? "b" : "a"}${mac.slice(1)}`,
				);
				const forged = await fetch(
					`${base}${flipped}/info/refs?service=git-upload-pack`,
				);
				const forgedBody = await forged.text();
				const now = Math.floor(Date.now() / 1000);
				const expired = (await adminCall("sign", {
					fields: { ...fields, exp: now - 5 },
				})).path;
				const overTtl = (await adminCall("sign", {
					fields: { ...fields, exp: now + 300 },
				})).path;
				const statuses: number[] = [];
				for (const p of [expired, overTtl]) {
					const res = await fetch(
						`${base}${p}/info/refs?service=git-upload-pack`,
					);
					await res.body?.cancel();
					statuses.push(res.status);
				}
				const receive = await fetch(
					`${base}${path}/git-receive-pack`,
					{ method: "POST", body: "0000" },
				);
				await receive.body?.cancel();
				say(
					`  replay=${replay.status} forged=${forged.status} expired=${
						statuses[0]
					} overTtl=${statuses[1]} receive-pack=${receive.status}`,
				);
				return replay.status === 404 && forged.status === 404 &&
						forgedBody === "" && statuses.every((s) => s === 404) &&
						receive.status === 404
					? ""
					: "a negative case was not a plain 404";
			},
		);
		await step(
			"lane B (another agent) seeds the same way",
			async () => {
				laneB = await adminCall("open-lane", { owner: agentB.principal });
				say(`  importMs=${laneB.importMs}`);
				return laneB.ok ? "" : laneB.importError ?? "lane B not open";
			},
		);
		const dirA = `${sandbox.root}/agent-a`;
		await step(
			"lane remote: the owner clones its lane (HEAD -> main at the base) and fast-forwards main",
			async () => {
				const clone = await as(agentA, [
					"clone",
					"-q",
					laneUrl(laneA.laneId),
					dirA,
				]);
				if (clone.code !== 0) return redactSecrets(clone.stderr);
				const head = await revParse(sandbox, dirA, "HEAD");
				if (head !== trunk) return `head ${head} is not the trunk ${trunk}`;
				await commitFile(sandbox, dirA, "lane-a.txt", "lane A\n");
				const out = await as(
					agentA,
					["push", "-q", "origin", "HEAD:main"],
					dirA,
				);
				return out.code === 0 ? "" : redactSecrets(out.stderr);
			},
		);
		await step(
			"lane remote: --force-with-lease from the recorded head",
			async () => {
				await git(sandbox, ["commit", "-q", "--amend", "-m", "amended"], {
					cwd: dirA,
				});
				const out = await as(agentA, [
					"push",
					"-q",
					"--force-with-lease",
					"origin",
					"HEAD:main",
				], dirA);
				return out.code === 0 ? "" : redactSecrets(out.stderr);
			},
		);
		await step(
			"lane remote L5: another branch is lane-main-only",
			async () =>
				rejected(
					await as(agentA, ["push", "origin", "HEAD:refs/heads/feature"], dirA),
					"lane-main-only",
				),
		);
		await step("lane remote L5: a tag is lane-main-only", async () =>
			rejected(
				await as(agentA, ["push", "origin", "HEAD:refs/tags/v1"], dirA),
				"lane-main-only",
			));
		await step(
			"lane remote L4: deleting main is use-lanes-close",
			async () =>
				rejected(
					await as(agentA, ["push", "origin", ":main"], dirA),
					"use-lanes-close",
				),
		);
		await step("lane remote L2: a landing lane is lane-landing", async () => {
			await adminCall("lane-state", { laneId: laneA.laneId, state: "landing" });
			await commitFile(sandbox, dirA, "frozen.txt", "frozen\n");
			const result = rejected(
				await as(agentA, ["push", "origin", "HEAD:main"], dirA),
				"lane-landing",
			);
			await adminCall("lane-state", { laneId: laneA.laneId, state: "open" });
			return result;
		});
		await step(
			"lane remote L3: another agent reads lane A but its push is not-your-lane",
			async () => {
				const dirB = `${sandbox.root}/agent-b-on-a`;
				const clone = await as(agentB, [
					"clone",
					"-q",
					laneUrl(laneA.laneId),
					dirB,
				]);
				if (clone.code !== 0) return redactSecrets(clone.stderr);
				await commitFile(sandbox, dirB, "intruder.txt", "x\n");
				return rejected(
					await as(agentB, ["push", "origin", "HEAD:main"], dirB),
					"not-your-lane",
				);
			},
		);
		await step(
			"lane remotes have no public view: anonymous is 401",
			async () => {
				const res = await fetch(
					`${laneUrl(laneA.laneId)}/info/refs?service=git-upload-pack`,
				);
				await res.body?.cancel();
				return res.status === 401 ? "" : `status ${res.status}`;
			},
		);
		await step(
			"the canonical URL stays closed to an agent with only repo lanes (agents-lanes-only)",
			async () =>
				rejected(
					await as(agentA, [
						"push",
						`${base}/acme/shop.git`,
						"HEAD:refs/heads/master",
					], dirA),
					"agents-lanes-only",
				),
		);
		await step(
			"layer 2 on the real binding: lane A's write token is refused by the canonical repo and by lane B",
			async () => {
				const statuses = await adminCall("layer2", {
					laneA: laneA.laneId,
					laneB: laneB.laneId,
				});
				say(`  ${JSON.stringify(statuses)}`);
				return statuses.laneA === 200 && statuses.canonical >= 400 &&
						statuses.laneB >= 400
					? ""
					: "a lane token reached another repo";
			},
		);
		await step(
			"nothing outside lane A moved: the canonical repo and lane B are unchanged; pushes recorded on the lane",
			async () => {
				const state = await adminCall("state");
				const canonical = state.canonical as Record<string, string>;
				// deno-lint-ignore no-explicit-any
				const lanes = state.lanes as any[];
				const a = lanes.find((l) => l.id === laneA.laneId);
				const b = lanes.find((l) => l.id === laneB.laneId);
				// deno-lint-ignore no-explicit-any
				const pushes = state.pushes as any[];
				say(
					`  canonical=${JSON.stringify(canonical)} laneA=${
						JSON.stringify(a.repo)
					} laneB=${JSON.stringify(b.repo)}`,
				);
				say(
					`  pushes=${
						JSON.stringify(pushes.map((p) => ({
							target: p.target,
							ref: p.ref,
							repoName: p.repo_name !== null,
						})))
					} rejections=${state.rejections.length}`,
				);
				const ok = canonical["refs/heads/master"] === trunk &&
					b.repo["refs/heads/main"] === trunk &&
					Object.keys(a.repo).filter((r) => r !== "HEAD").join(",") ===
						"refs/heads/main" &&
					a.repo["refs/heads/main"] === a.head &&
					pushes.length === 2 &&
					pushes.every((p) =>
						p.target === laneA.laneId && p.repo_name !== null
					);
				return ok ? "" : "unexpected state";
			},
		);
		await step(
			"the failure buckets: forged capability URLs are 404, then 429 past the limits (per isolate)",
			async () => {
				const counts: Record<number, number> = {};
				for (let i = 0; i < 60; i++) {
					const res = await fetch(
						`${base}/-/cap/v1/${
							Math.floor(Date.now() / 1000) + 60
						}/${laneA.laneId}/${"0".repeat(32)}/${
							randomHex(32)
						}/${laneA.capFields.repoId}.git/info/refs?service=git-upload-pack`,
					);
					await res.body?.cancel();
					counts[res.status] = (counts[res.status] ?? 0) + 1;
				}
				say(`  statuses=${JSON.stringify(counts)}`);
				const only404or429 = Object.keys(counts).every((s) =>
					s === "404" || s === "429"
				);
				return only404or429 ? "" : "a forged URL got something else";
			},
		);
	} finally {
		await sandbox.cleanup();
	}
};

if (import.meta.main) {
	const keep = Deno.args.includes("--keep");
	const key = randomHex(32);
	const secret = randomHex(32);
	let deployed = false;
	try {
		const base = await deploy({ HARNESS_KEY: key, TARTAN_SECRET: secret });
		deployed = true;
		say(`deployed ${WORKER} (namespace ${NAMESPACE})`);
		await scenario(base, key);
		if (!keep) {
			const cleaned = await fetch(`${base}/-/harness/cleanup`, {
				method: "POST",
				headers: { authorization: `Bearer ${key}` },
				body: "{}",
			});
			const deleted = cleaned.ok
				? ((await cleaned.json()) as { deleted: string[] }).deleted
				: [];
			say(`artifacts repos deleted: ${deleted.length}`);
		}
	} catch (error) {
		say(
			`FAIL setup: ${error instanceof Error ? error.message : String(error)}`,
		);
	} finally {
		if (deployed && !keep) await destroy();
	}
	const leaks = scanTextForLeaks("wp04-lanes output", printed.join("\n"));
	say(`leak scan: ${leaks.length === 0 ? "clean" : JSON.stringify(leaks)}`);
	const failed = steps.filter((s) => !s.ok);
	say(`${steps.length - failed.length}/${steps.length} PASS`);
	Deno.exit(failed.length === 0 && leaks.length === 0 ? 0 : 1);
}
