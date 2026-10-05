// WP4 live acceptance.
//
//   deno task live -- wp04 --local
//       the local harness: stock git → gateway handlers → WP5a's real RepoDO
//       core → `git http-backend` (`deno test src/kernel/gateway`).
//   deno task live -- --stage dev-wp04 wp04 [--keep]
//       deploys `scripts/live/wp04-harness.worker.ts` as the Worker
//       `tartan-dev-wp04` (Artifacts namespace `tartan-dev-wp04`, nothing
//       else), drives the ref-policy table, the public view, the size limits and
//       the rejection display with stock git through the real edge and the
//       real Artifacts, prints one line per step, then deletes the Artifacts
//       repo and the Worker (unless `--keep`).
//
// The harness serves the product's gateway handlers; WP5a's RepoDO and WP3's
// tree are played by a harness DO (WP3 is not merged, so the product cannot
// create a repo yet). Credentials: the admin key is generated here, passed to
// `wrangler secret put` on stdin and never printed; git tokens live in this
// process only and travel as an `http.extraHeader`, never in a remote URL.

import {
	commitFile,
	git,
	type GitResult,
	makeSandbox,
	revParse,
	type Sandbox,
} from "../../src/kernel/gateway/testing/git.ts";

const ROOT = new URL("../../", import.meta.url);
const WORKER = "tartan-dev-wp04";
const NAMESPACE = "tartan-dev-wp04";
const CONFIG = new URL(".wrangler/deploy/wrangler.wp04-harness.jsonc", ROOT);
/** The push cap of the harness (decimal MB): a 33.6 MB object fits, a 38 MB push does not. */
const MAX_PUSH_MB = 36;

type Step = { name: string; ok: boolean; detail: string; ms: number };
const steps: Step[] = [];

const step = async (
	name: string,
	run: () => Promise<boolean | string>,
): Promise<boolean> => {
	const started = performance.now();
	let ok = false;
	let detail = "";
	try {
		const result = await run();
		ok = result === true || (typeof result === "string" && result === "");
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
				main: "../../scripts/live/wp04-harness.worker.ts",
				compatibility_date: "2026-08-15",
				compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
				workers_dev: true,
				artifacts: [{ binding: "ARTIFACTS", namespace: NAMESPACE }],
				durable_objects: {
					bindings: [{ name: "REPO", class_name: "HarnessRepo" }],
				},
				migrations: [{ tag: "v1", new_sqlite_classes: ["HarnessRepo"] }],
				vars: { TARTAN_MAX_PUSH_MB: String(MAX_PUSH_MB), HARNESS_ECHO: "1" },
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
		throw new Error(`wrangler deploy failed:\n${deployed.out}`);
	}
	const url = /https:\/\/tartan-dev-wp04\.[a-z0-9-]+\.workers\.dev/.exec(
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
// The scenario
// ---------------------------------------------------------------------------

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
				`admin ${action}: ${response.status} ${await response.text()}`,
			);
		}
		return await response.json();
	};
	// The Worker may need a few seconds after its first deploy.
	for (let i = 0; i < 20; i++) {
		const probe = await fetch(`${base}/-/harness/state`, {
			headers: { authorization: `Bearer ${key}` },
		}).catch(() => null);
		if (probe?.status === 200) {
			await probe.body?.cancel();
			break;
		}
		await probe?.body?.cancel();
		await new Promise((r) => setTimeout(r, 1_500));
	}
	// Let the version that carries the secret settle everywhere.
	await new Promise((r) => setTimeout(r, 5_000));
	const sandbox: Sandbox = await makeSandbox();
	const remote = `${base}/acme/shop.git`;
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
				out.stderr.split("\n").filter((l) =>
					l.includes("rejected") || l.includes("fatal")
				).join(" | ")
			}`;
	const random = (n: number) => {
		const out = new Uint8Array(n);
		for (let at = 0; at < n; at += 65_536) {
			crypto.getRandomValues(out.subarray(at, Math.min(n, at + 65_536)));
		}
		return out;
	};
	try {
		let trunk = "";
		let owner: Principal = { token: "", principal: "" };
		await step("setup: an empty Artifacts repo in import mode", async () => {
			// A DO can be reset once while the secret's version rolls out.
			const setup = () => adminCall("setup", { visibility: "private" });
			owner = await setup().catch(async (error) => {
				console.log(`  setup retried after: ${error.message}`);
				await adminCall("cleanup", {});
				return await setup();
			});
			return owner.token !== "";
		});
		const user: Principal = await adminCall("mint", { kind: "user", role: 30 });
		const ownerDir = `${sandbox.root}/owner`;
		await step(
			"import mode (row 1): another user is repo-importing; the forge Owner pushes main",
			async () => {
				await git(sandbox, ["init", "-q", "--initial-branch=main", ownerDir]);
				trunk = await commitFile(sandbox, ownerDir, "README.md", "# shop\n");
				await git(sandbox, ["remote", "add", "origin", remote], {
					cwd: ownerDir,
				});
				const refused = rejected(
					await as(user, ["push", "origin", "HEAD:refs/heads/main"], ownerDir),
					"repo-importing",
				);
				if (refused) return `other user: ${refused}`;
				const out = await as(owner, [
					"push",
					"-q",
					"origin",
					"HEAD:refs/heads/main",
				], ownerDir);
				if (out.code !== 0) return out.stderr;
				await adminCall("import-complete", {});
				return "";
			},
		);
		const agentA: Principal = await adminCall("mint", {
			kind: "agent",
			role: 30,
		});
		const agentB: Principal = await adminCall("mint", {
			kind: "agent",
			role: 30,
		});
		const agentC: Principal = await adminCall("mint", {
			kind: "agent",
			role: 30,
		});
		const reader: Principal = await adminCall("mint", {
			kind: "agent",
			role: 30,
			scopes: ["repo:read", "mcp"],
		});

		await step("401 first: anonymous info/refs on a private repo", async () => {
			const r = await fetch(`${remote}/info/refs?service=git-upload-pack`);
			await r.body?.cancel();
			return r.status === 401 &&
				(r.headers.get("www-authenticate") ?? "").startsWith("Basic");
		});
		await step(
			"anonymous clone of a private repo fails",
			async () =>
				(await as(null, ["clone", "-q", remote, `${sandbox.root}/anon0`]))
					.code !== 0,
		);

		const userDir = `${sandbox.root}/user`;
		await step("user clone (protocol v2) through the gateway", async () => {
			const out = await as(user, ["clone", "-q", remote, userDir]);
			if (out.code !== 0) return out.stderr;
			return (await revParse(sandbox, userDir, "HEAD")) === trunk;
		});
		await step(
			"user clone (protocol v0)",
			async () =>
				(await as(user, [
					"-c",
					"protocol.version=0",
					"clone",
					"-q",
					remote,
					`${sandbox.root}/user-v0`,
				])).code === 0,
		);
		let feature = "";
		await step("user pushes a branch: accepted and recorded", async () => {
			feature = await commitFile(sandbox, userDir, "feat.txt", "feature\n");
			const out = await as(user, [
				"push",
				"-q",
				"origin",
				"HEAD:refs/heads/feat-x",
			], userDir);
			if (out.code !== 0) return out.stderr;
			const state = await adminCall("state");
			return state.pushes.some((p: { ref: string; after: string }) =>
				p.ref === "refs/heads/feat-x" && p.after === feature
			);
		});
		await step(
			"user push to main: synthesized ng woven-by-tartan, band-2 guidance, main unchanged",
			async () => {
				const out = await as(user, ["push", "origin", "HEAD:main"], userDir);
				const why = rejected(out, "woven-by-tartan");
				if (why) return why;
				if (!out.stderr.includes("remote: tartan")) return "no band-2 line";
				const ls = await as(user, ["ls-remote", remote, "refs/heads/main"]);
				return ls.stdout.startsWith(trunk);
			},
		);
		await step("--porcelain shows the synthesized reason", async () => {
			const out = await as(
				user,
				["push", "--porcelain", "origin", "HEAD:main"],
				userDir,
			);
			return out.stdout.includes("[remote rejected] (woven-by-tartan)");
		});

		const laneA: string =
			(await adminCall("lane", { owner: agentA.principal })).laneId;
		const laneB: string =
			(await adminCall("lane", { owner: agentB.principal })).laneId;
		const ref = (id: string) => `refs/heads/lanes/${id}`;
		const aDir = `${sandbox.root}/a`;
		const bDir = `${sandbox.root}/b`;
		await as(agentA, ["clone", "-q", remote, aDir]);
		await as(agentB, ["clone", "-q", remote, bDir]);
		let laneHead = "";
		await step(
			"agent A creates its lane ref (create CAS on Artifacts)",
			async () => {
				laneHead = await commitFile(sandbox, aDir, "a.txt", "one\n");
				const out = await as(agentA, [
					"push",
					"-q",
					"origin",
					`HEAD:${ref(laneA)}`,
				], aDir);
				return out.code === 0 ? "" : out.stderr;
			},
		);
		await step(
			"agent A updates, then force-pushes with --force-with-lease",
			async () => {
				await commitFile(sandbox, aDir, "a.txt", "two\n");
				const update = await as(agentA, [
					"push",
					"-q",
					"origin",
					`HEAD:${ref(laneA)}`,
				], aDir);
				if (update.code !== 0) return update.stderr;
				await git(sandbox, ["commit", "-q", "--amend", "-m", "amended"], {
					cwd: aDir,
				});
				laneHead = await revParse(sandbox, aDir, "HEAD");
				const forced = await as(agentA, [
					"push",
					"-q",
					"--force-with-lease",
					"origin",
					`HEAD:${ref(laneA)}`,
				], aDir);
				if (forced.code !== 0) return forced.stderr;
				const state = await adminCall("state");
				return state.lanes.find((l: { id: string }) => l.id === laneA)?.head ===
					laneHead;
			},
		);
		await step(
			"agent A sees its lane; agent B does not (ls-remote, v2)",
			async () => {
				const a = await as(agentA, ["ls-remote", remote]);
				const b = await as(agentB, ["ls-remote", remote]);
				return a.stdout.includes(ref(laneA)) &&
					!b.stdout.includes(ref(laneA)) &&
					!b.stdout.includes("refs/heads/lanes/");
			},
		);
		await step(
			"a member fetches another lane by explicit refspec (ref-prefix)",
			async () => {
				const out = await as(agentB, [
					"fetch",
					"-q",
					"origin",
					`${ref(laneA)}:refs/remotes/peek`,
				], bDir);
				if (out.code !== 0) return out.stderr;
				return (await revParse(sandbox, bDir, "refs/remotes/peek")) ===
					laneHead;
			},
		);
		await commitFile(sandbox, bDir, "b.txt", "b\n");
		const table: [string, string][] = [
			[`HEAD:${ref(laneA)}`, "not-your-lane"],
			["HEAD:refs/heads/main", "woven-by-tartan"],
			["HEAD:refs/heads/feature-b", "agents-lanes-only"],
			["HEAD:refs/tags/v9", "tags-maintainer"],
			[`HEAD:refs/heads/lanes/${laneA.toUpperCase()}`, "case-collision"],
			["HEAD:refs/heads/Main", "case-collision"],
			["HEAD:refs/heads/lanes", "reserved-parent"],
			["HEAD:refs/tartan/changes/x", "kernel-only"],
			["HEAD:refs/notes/tartan", "kernel-only"],
		];
		for (const [spec, reason] of table) {
			await step(
				`agent B ${spec} → ${reason}`,
				async () =>
					rejected(await as(agentB, ["push", "origin", spec], bDir), reason),
			);
		}
		await step(
			"agent B creates its own lane; deleting it is use-lanes-close",
			async () => {
				const created = await as(agentB, [
					"push",
					"-q",
					"origin",
					`HEAD:${ref(laneB)}`,
				], bDir);
				if (created.code !== 0) return created.stderr;
				return rejected(
					await as(agentB, ["push", "origin", `:${ref(laneB)}`], bDir),
					"use-lanes-close",
				);
			},
		);
		await step(
			"one rejected command rejects the whole push (lane + main: atomic)",
			async () => {
				await commitFile(sandbox, aDir, "a.txt", "atomic\n");
				const out = await as(agentA, [
					"push",
					"--porcelain",
					"origin",
					`HEAD:${ref(laneA)}`,
					"HEAD:refs/heads/main",
				], aDir);
				return out.stdout.includes("(atomic: another ref was rejected)") &&
					out.stdout.includes("(woven-by-tartan)");
			},
		);
		await step(
			"an agent without a lane: agents-lanes-only (canonical write precheck)",
			async () => {
				const dir = `${sandbox.root}/c`;
				await as(agentC, ["clone", "-q", remote, dir]);
				await commitFile(sandbox, dir, "c.txt", "c\n");
				return rejected(
					await as(agentC, ["push", "origin", "HEAD:refs/heads/c"], dir),
					"agents-lanes-only",
				);
			},
		);
		await step(
			"landing freeze: a push to a landing lane is lane-landing",
			async () => {
				await adminCall("lane-state", { laneId: laneA, state: "landing" });
				await commitFile(sandbox, aDir, "a.txt", "three\n");
				const out = await as(
					agentA,
					["push", "origin", `HEAD:${ref(laneA)}`],
					aDir,
				);
				await adminCall("lane-state", { laneId: laneA, state: "submitted" });
				return rejected(out, "lane-landing");
			},
		);
		await step("a lane-pinned token writes only its lane", async () => {
			const pinned: Principal = await adminCall("mint", {
				kind: "agent",
				role: 30,
				principal: agentA.principal,
				laneId: laneA,
			});
			const second: string =
				(await adminCall("lane", { owner: agentA.principal })).laneId;
			const own = await as(pinned, [
				"push",
				"-q",
				"origin",
				`HEAD:${ref(laneA)}`,
			], aDir);
			if (own.code !== 0) return own.stderr;
			return rejected(
				await as(pinned, ["push", "origin", `HEAD:${ref(second)}`], aDir),
				"not-your-lane",
			);
		});
		await step("a read-scoped token cannot push (403)", async () => {
			const dir = `${sandbox.root}/r`;
			await as(reader, ["clone", "-q", remote, dir]);
			await commitFile(sandbox, dir, "r.txt", "r\n");
			const out = await as(
				reader,
				["push", "origin", "HEAD:refs/heads/r"],
				dir,
			);
			return out.code !== 0 && out.stderr.includes("403");
		});

		await adminCall("visibility", { visibility: "public" });
		const anonDir = `${sandbox.root}/anon`;
		await step(
			"public: anonymous clone works; no hidden refs advertised (v2 and v0)",
			async () => {
				const out = await as(null, ["clone", "-q", remote, anonDir]);
				if (out.code !== 0) return out.stderr;
				const v2 = await as(null, ["ls-remote", remote]);
				const v0 = await as(null, [
					"-c",
					"protocol.version=0",
					"ls-remote",
					remote,
				]);
				return !`${v2.stdout}${v0.stdout}`.includes("refs/heads/lanes/") &&
					!`${v2.stdout}${v0.stdout}`.includes("refs/tartan/");
			},
		);
		await step(
			"public: an anonymous fetch of a lane head SHA is want-not-advertised",
			async () => {
				const out = await as(null, ["fetch", "origin", laneHead], anonDir);
				return out.code !== 0 && out.stderr.includes("want-not-advertised")
					? ""
					: out.stderr;
			},
		);
		await step(
			"public: a gzip-encoded anonymous want of a hidden SHA is refused",
			async () => {
				const enc = new TextEncoder();
				const pkt = (s: string) => {
					const n = enc.encode(s).length + 4;
					return n.toString(16).padStart(4, "0") + s;
				};
				const body = enc.encode(
					pkt("command=fetch\n") + pkt("agent=git/2.55.0\n") + "0001" +
						pkt(`want ${laneHead}\n`) + pkt("done\n") + "0000",
				);
				const gz = new Uint8Array(
					await new Response(
						new Response(body).body!.pipeThrough(new CompressionStream("gzip")),
					).arrayBuffer(),
				);
				const r = await fetch(`${remote}/git-upload-pack`, {
					method: "POST",
					headers: {
						"content-type": "application/x-git-upload-pack-request",
						"content-encoding": "gzip",
						"git-protocol": "version=2",
					},
					body: gz,
				});
				return decoder.decode(await r.arrayBuffer()).includes(
					"ERR want-not-advertised",
				);
			},
		);
		await step(
			"public: an anonymous want of the trunk tip is served",
			async () => {
				const out = await as(null, ["fetch", "-q", "origin", "main"], anonDir);
				return out.code === 0 ? "" : out.stderr;
			},
		);
		await adminCall("visibility", { visibility: "private" });

		await step(
			`size: a 38 MB push is push-too-large (MAX_PUSH_BYTES ${MAX_PUSH_MB} MB) and never forwarded`,
			async () => {
				await commitFile(sandbox, userDir, "big-38.bin", random(38_000_000));
				const out = await as(
					user,
					["push", "origin", "HEAD:refs/heads/big-38"],
					userDir,
				);
				await git(sandbox, ["reset", "-q", "--hard", "HEAD~1"], {
					cwd: userDir,
				});
				const why = rejected(out, "push-too-large");
				if (why) return why;
				const ls = await as(user, ["ls-remote", remote, "refs/heads/big-38"]);
				return ls.stdout.trim() === "";
			},
		);
		await step(
			"size: a 33.6 MB object is object-too-large (Artifacts' answer translated)",
			async () => {
				await commitFile(sandbox, userDir, "big-33.bin", random(33_600_000));
				const out = await as(
					user,
					["push", "origin", "HEAD:refs/heads/big-33"],
					userDir,
				);
				await git(sandbox, ["reset", "-q", "--hard", "HEAD~1"], {
					cwd: userDir,
				});
				return rejected(out, "object-too-large");
			},
		);

		await step(
			"harness state: every push recorded, every rejection recorded",
			async () => {
				const state = await adminCall("state");
				console.log(
					`  refs=${state.refs.length} lanes=${state.lanes.length} pushes=${state.pushes.length} rejections=${state.rejections.length}`,
				);
				return state.pushes.length >= 6 &&
					state.rejections.length >= table.length;
			},
		);
	} finally {
		await sandbox.cleanup();
		await adminCall("cleanup", {}).then(
			(r) => console.log(`artifacts repos deleted: ${r.deleted.length}`),
			(e) => console.log(`cleanup failed: ${e.message}`),
		);
	}
};

// ---------------------------------------------------------------------------

const args = Deno.args;
if (args.includes("--local")) {
	const out = await new Deno.Command("deno", {
		args: ["test", "-A", "src/kernel/gateway"],
		cwd: ROOT,
		stdout: "inherit",
		stderr: "inherit",
	}).output();
	Deno.exit(out.code);
}
const stageIndex = args.indexOf("--stage");
const stage = stageIndex >= 0 ? args[stageIndex + 1] : undefined;
if (stage !== "dev-wp04") {
	console.error(
		"usage: deno task live -- --stage dev-wp04 wp04 [--keep] | wp04 --local",
	);
	Deno.exit(2);
}
const key = [...crypto.getRandomValues(new Uint8Array(32))]
	.map((b) => b.toString(16).padStart(2, "0")).join("");
let url = "";
try {
	url = await deploy(key);
	console.log(`deployed ${WORKER}`);
	await scenario(url, key);
} finally {
	if (!args.includes("--keep")) await destroy();
}
const failed = steps.filter((s) => !s.ok);
console.log(`${steps.length - failed.length}/${steps.length} PASS`);
Deno.exit(failed.length === 0 && steps.length > 0 ? 0 : 1);
