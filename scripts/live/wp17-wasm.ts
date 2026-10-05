// WP17 + WP7b live acceptance on the edge (S6 promoted): the js
// and wasm runtimes as Dynamic Worker facets of a real ExtensionDO, through the
// live harness Worker `tartan-dev-wp17` (scripts/live/wp17-harness.worker.ts:
// the product's ExtensionDO, package loader, publish check and gate replay;
// fakes for the registry and the kernel facades, so no claimed forge is
// needed).
//
//   1. a tampered acme.no-secrets (its import record edited) is refused by
//      the publish check;
//   2. acme.no-secrets (Rust → WASM, `deno task build:ext acme-no-secrets`)
//      published to R2 and installed in shadow; the gate replayed over 41
//      synthetic advances (labelled synthetic) would have vetoed 2;
//   3. promoted to enforce: an advance adding a fake AWS key is vetoed, the
//      push echo gives `remote:` lines, the change sidebar shows the
//      finding, the `scan` tool finds a key in a snippet;
//   4. a js package: render with read-only SQL, an event through the
//      capability bridge, no network, a stashed capability fails, a host
//      timeout aborts the facet (a breaker strike);
//   5. a js package whose tool is a synchronous loop: each call runs until
//      the platform stops the Dynamic Worker for CPU; the host
//      counts a `cpu` strike and moves the installation to a fresh Dynamic
//      Worker; the breaker opens within three invocations, after which calls
//      short-circuit (a host killed with its facet would count the
//      stale write-ahead marker as a `reset` strike instead).
//
// Usage:
//   deno task live -- --stage dev-wp17 wp17 --deploy     # deploy, run, keep
//   deno task live -- --stage dev-wp17 wp17 --base <url> # run against it
//   deno task live -- --stage dev-wp17 wp17 --destroy --base <url>
//                                       # empty the bucket, delete everything
//   [--evidence <file>] [--skip-runaway]
//
// Account: CLOUDFLARE_ACCOUNT_ID (wrangler's login). Creates only the
// Worker `tartan-dev-wp17` and the R2 bucket `tartan-dev-wp17-blobs`. The
// harness key is generated here, written to `.wrangler/deploy/` (0600) and
// never printed; responses are scanned for it.

import * as path from "node:path";
import { createUlid } from "../../packages/contract/src/index.ts";

const ROOT = new URL("../../", import.meta.url);
const WORKER = "tartan-dev-wp17";
const BUCKET = "tartan-dev-wp17-blobs";
const CONFIG = new URL(".wrangler/deploy/wrangler.wp17-harness.jsonc", ROOT);
const KEY_FILE = new URL(".wrangler/deploy/wp17-harness.key", ROOT);
const ACME_DIST = new URL("extensions/acme-no-secrets/dist/publish.json", ROOT);

const flag = (name: string): boolean => Deno.args.includes(`--${name}`);
const arg = (name: string): string | undefined => {
	const i = Deno.args.indexOf(`--${name}`);
	return i === -1 ? undefined : Deno.args[i + 1];
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
				main: "../../scripts/live/wp17-harness.worker.ts",
				compatibility_date: "2026-08-15",
				compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
				workers_dev: true,
				worker_loaders: [{ binding: "LOADER" }],
				r2_buckets: [{ binding: "BLOBS", bucket_name: BUCKET }],
				durable_objects: {
					bindings: [{ name: "EXT", class_name: "HarnessExtensionDO" }],
				},
				migrations: [{ tag: "v1", new_sqlite_classes: ["HarnessExtensionDO"] }],
				observability: { enabled: true },
			},
			null,
			"\t",
		),
	);
};

const readKey = async (): Promise<string | null> => {
	try {
		return (await Deno.readTextFile(KEY_FILE)).trim();
	} catch {
		return null;
	}
};

const deploy = async (): Promise<{ url: string; key: string }> => {
	await renderConfig();
	const bucket = await run("npx", [
		"wrangler",
		"r2",
		"bucket",
		"create",
		BUCKET,
	]);
	if (bucket.code !== 0 && !/already exists|already own/i.test(bucket.out)) {
		throw new Error(`r2 bucket create failed:\n${bucket.out}`);
	}
	const deployed = await run("npx", [
		"wrangler",
		"deploy",
		"-c",
		CONFIG.pathname,
	]);
	if (deployed.code !== 0) {
		throw new Error(`wrangler deploy failed:\n${deployed.out}`);
	}
	console.log(
		deployed.out.split("\n").filter((l) =>
			/Total Upload|Worker Startup Time|Current Version ID/.test(l)
		).join("\n"),
	);
	const url = /https:\/\/tartan-dev-wp17\.[a-z0-9-]+\.workers\.dev/.exec(
		deployed.out,
	)?.[0];
	if (!url) throw new Error("no workers.dev URL in the deploy output");
	// One key per deployment: a key rotated on a redeploy would race the
	// edge's switch to the new version.
	const existing = await readKey();
	if (existing !== null) return { url, key: existing };
	const key = [...crypto.getRandomValues(new Uint8Array(32))]
		.map((b) => b.toString(16).padStart(2, "0")).join("");
	await Deno.writeTextFile(KEY_FILE, key, { mode: 0o600 });
	const secret = await run(
		"npx",
		["wrangler", "secret", "put", "HARNESS_KEY", "-c", CONFIG.pathname],
		key,
	);
	if (secret.code !== 0) throw new Error("wrangler secret put failed");
	return { url, key };
};

/** Waits until the harness answers with this key (a new version or secret takes a moment). */
const ready = async (base: string, key: string): Promise<void> => {
	for (let i = 0; i < 30; i++) {
		const res = await fetch(`${base}/-/harness/check`, {
			method: "POST",
			headers: { authorization: `Bearer ${key}` },
			body: "{}",
		});
		await res.body?.cancel();
		if (res.status !== 404) return;
		await new Promise((r) => setTimeout(r, 2000));
	}
	throw new Error("the harness never answered with this key");
};

/** A fresh installation id per run (the harness keeps state per id). */
const installationId = (): string => `i_${createUlid()()}`;

/** Empties the bucket through the harness (it lists and deletes), then deletes the Worker and the bucket. */
const destroy = async (base: string | undefined): Promise<void> => {
	const key = await readKey();
	if (base !== undefined && key !== null) {
		const res = await fetch(`${base}/-/harness/purge`, {
			method: "POST",
			headers: { authorization: `Bearer ${key}` },
			body: "{}",
		});
		console.log(`purge: ${res.status} ${await res.text()}`);
	}
	const deleted = await run("npx", [
		"wrangler",
		"delete",
		"--name",
		WORKER,
		"--force",
	]);
	console.log(deleted.code === 0 ? `deleted ${WORKER}` : deleted.out);
	const bucket = await run("npx", [
		"wrangler",
		"r2",
		"bucket",
		"delete",
		BUCKET,
	]);
	console.log(bucket.code === 0 ? `deleted ${BUCKET}` : bucket.out);
	await Deno.remove(KEY_FILE).catch(() => {});
	await Deno.remove(CONFIG).catch(() => {});
};

// ---------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------

const b64 = (text: string): string => {
	const bytes = new TextEncoder().encode(text);
	let s = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(s);
};

const jsPackage = (id: string, main: string, tools: string[]) => ({
	manifest: {
		schema: 1,
		id,
		name: id,
		version: "0.1.0",
		api: "tartan:ext@0.1.0",
		runtime: "js",
		entry: { js: "main.js" },
		storage: { scope: "repo", migrations: ["migrations/0001_init.sql"] },
		permissions: {},
		contributes: {
			slots: [{
				slot: "repo.sidebar",
				id: "count",
				dynamic: true,
				cache: "none",
			}],
			tools: tools.map((name) => ({
				name,
				description: name,
				input: { type: "object" },
				role: 20,
			})),
		},
	},
	files: {
		"main.js": b64(main),
		"migrations/0001_init.sql": b64("CREATE TABLE seen (k TEXT NOT NULL)"),
	},
});

const HELLO_JS = `
let stashed = null;
export default {
	async init(x) { x.sql.exec("INSERT INTO seen (k) VALUES ('init')"); },
	async render(slot, ctx, props, x) {
		const n = x.sql.exec("SELECT COUNT(*) AS n FROM seen").one().n;
		let write = "ok";
		try { x.sql.exec("INSERT INTO seen (k) VALUES ('render')"); } catch (e) { write = e.code + ":" + e.reason; }
		return { v: 1, root: { t: "text", text: "rows " + n + " viewer " + x.actor.id + " write " + write } };
	},
	async callTool(name, args, ctx, x) {
		if (name === "emit") return { id: typeof (await x.caps.events.emit("x.acme.hello-js.said", {})) };
		if (name === "net") {
			try { await fetch("https://example.com/"); return { fetch: "allowed" }; }
			catch (e) { return { fetch: String(e.message ?? e) }; }
		}
		if (name === "stash") { stashed = x.caps; return { stashed: true }; }
		if (name === "use_stash") {
			try { await stashed.events.emit("x.acme.hello-js.late", {}); return { code: "ok" }; }
			catch (e) { return { code: e.code ?? String(e) }; }
		}
		if (name === "sleep") { await new Promise((r) => setTimeout(r, 30000)); return { slept: true }; }
		throw new Error("no tool " + name);
	},
};`;

const SPIN_JS = `
export default {
	async callTool(name) {
		if (name === "spin") { let x = 0; for (;;) { x = (x * 31 + 7) % 1000003; } }
		return { ok: true };
	},
};`;

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

const results: { step: string; ok: boolean; detail: string }[] = [];
const record = (step: string, ok: boolean, detail: string) => {
	results.push({ step, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"} ${step}: ${detail}`);
};

const main = async () => {
	if (flag("destroy")) {
		await destroy(arg("base"));
		return;
	}
	let base = arg("base");
	let key = await readKey();
	if (flag("deploy")) {
		const d = await deploy();
		base = d.url;
		key = d.key;
	}
	if (base === undefined || key === null) {
		throw new Error(
			"usage: wp17-wasm.ts --deploy | --base <url> (with the key file)",
		);
	}
	await ready(base, key);
	const leaks: string[] = [];
	const post = async (route: string, body: unknown) => {
		const res = await fetch(`${base}/-/harness/${route}`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${key}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
		});
		const text = await res.text();
		if (text.includes(key!)) leaks.push(route);
		try {
			return {
				status: res.status,
				json: JSON.parse(text) as Record<string, unknown>,
			};
		} catch {
			return { status: res.status, json: { raw: text.slice(0, 300) } };
		}
	};
	const evidence: Record<string, unknown> = {
		worker: WORKER,
		startedAt: new Date().toISOString(),
	};
	const r2Keys: string[] = [];

	// 1. tampered package refused ------------------------------------------
	const acme = JSON.parse(await Deno.readTextFile(ACME_DIST)) as {
		manifest: { id: string; version: string };
		files: Record<string, string>;
	};
	const tampered = {
		...acme,
		files: {
			...acme.files,
			"imports.json": b64('["tartan:ext/sql@0.1.0#exec"]'),
		},
	};
	const check = await post("check", tampered);
	record(
		"publish check refuses a tampered import record",
		check.json.ok === false &&
			JSON.stringify(check.json.details ?? "").includes(
				"imports.json does not match",
			),
		JSON.stringify(check.json.details ?? check.json).slice(0, 200),
	);
	const noAuth = await fetch(`${base}/-/harness/check`, {
		method: "POST",
		body: "{}",
	});
	record(
		"the harness answers 404 without its key",
		noAuth.status === 404,
		String(noAuth.status),
	);
	await noAuth.body?.cancel();

	// 2. acme in shadow + replay ---------------------------------------------
	const ACME_INST = installationId();
	const published = await post("publish", {
		...acme,
		installationId: ACME_INST,
		mode: "shadow",
	});
	const sha = String(published.json.sha256 ?? "");
	record(
		"acme.no-secrets published to R2 and installed in shadow",
		published.status === 200 && /^[0-9a-f]{64}$/.test(sha),
		`sha256 ${sha.slice(0, 16)}… imports ${
			JSON.stringify(published.json.imports)
		}`,
	);
	for (const p of [...Object.keys(acme.files), "tartan.json"]) {
		r2Keys.push(`ext/${acme.manifest.id}/${acme.manifest.version}/${sha}/${p}`);
	}
	const replay = await post("replay", {
		installationId: ACME_INST,
		manifest: acme.manifest,
		count: 41,
		leaky: [12, 33],
	});
	const summary = replay.json.summary as
		| { vetoed: number; of: number }
		| undefined;
	record(
		"shadow replay over 41 synthetic advances would have vetoed 2",
		summary?.vetoed === 2 && summary?.of === 41,
		`${JSON.stringify(summary)} in ${replay.json.ms} ms (cold facet included)`,
	);
	evidence.replay = {
		summary,
		ms: replay.json.ms,
		synthetic: replay.json.synthetic,
	};

	// 3. promote, veto, echo, sidebar, scan ----------------------------------
	const promote = await post("mode", {
		installationId: ACME_INST,
		mode: "enforce",
	});
	record(
		"promoted to enforce",
		promote.json.ok === true,
		JSON.stringify(promote.json).slice(0, 80),
	);
	const CHANGE = "ch_01k60000000000000000000a01";
	const leaky = [
		{
			path: "config/prod.env",
			line: 3,
			text: "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
		},
		{ path: "src/app.ts", line: 9, text: "export const x = 1;" },
	];
	const gate = await post("gate", {
		installationId: ACME_INST,
		input: {
			point: "ref.advance",
			repo: "01k60000000000000000000002",
			ref: "refs/heads/main",
			base: "a".repeat(40),
			head: "b".repeat(40),
			changeId: CHANGE,
			changedPaths: ["config/prod.env", "src/app.ts"],
			addedLines: leaky,
			truncated: false,
			workRefs: [],
			actor: { kind: "agent", id: "a_01k60000000000000000000104" },
		},
	});
	const decision = gate.json.value as
		| { decision?: string; message?: string }
		| undefined;
	record(
		"an advance adding a fake AWS key is vetoed by the Rust gate",
		decision?.decision === "veto",
		`${decision?.message?.slice(0, 120)} (${gate.json.ms} ms)`,
	);
	const echo = await post("echo", {
		installationId: ACME_INST,
		event: {
			id: "01k60000000000000000000e01",
			seq: 1,
			stream: "repo:01k60000000000000000000002",
			type: "push.accepted",
			v: 1,
			source: { kind: "kernel" },
			actor: { kind: "agent", id: "a_01k60000000000000000000104" },
			node: "01k60000000000000000000002",
			repo: "01k60000000000000000000002",
			depth: 0,
			shadow: false,
			at: Date.now(),
			data: {
				pushId: "p_01k60000000000000000000001",
				target: "ln_01k60000000000000000000301",
				ref: "refs/heads/lanes/ln_01k60000000000000000000301",
				before: "a".repeat(40),
				after: "b".repeat(40),
				via: "gateway",
			},
		},
		input: { addedLines: leaky, truncated: false },
	});
	const lines =
		((echo.json.value as { lines?: string[] } | undefined)?.lines) ?? [];
	record(
		"the push echo gives remote: lines from WASM",
		lines.some((l) =>
			l.startsWith("[no-secrets] AWS access key at config/prod.env:3")
		) && !lines.some((l) => l.includes("AKIAIOSFODNN7EXAMPLE")),
		JSON.stringify(lines).slice(0, 200),
	);
	const sidebar = await post("render", {
		installationId: ACME_INST,
		slot: "findings",
		ctx: {
			slot: "change.sidebar",
			node: "01k60000000000000000000002",
			repo: "01k60000000000000000000002",
			entity: { kind: "change", id: CHANGE },
			mode: "enforce",
		},
	});
	const sidebarText = JSON.stringify(sidebar.json.value ?? sidebar.json);
	record(
		"the change sidebar shows the finding",
		sidebarText.includes("Advance vetoed") && sidebarText.includes("AKIA…MPLE"),
		sidebarText.slice(0, 160),
	);
	const scan = await post("tool", {
		installationId: ACME_INST,
		name: "scan",
		args: {
			changeId: CHANGE,
			text: "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
		},
	});
	const found =
		(scan.json.value as { findings?: { kind: string }[] } | undefined)
			?.findings ?? [];
	record(
		"the scan tool finds a secret key in a snippet",
		found.length === 1 && found[0].kind === "aws-secret-key",
		JSON.stringify(scan.json.value).slice(0, 160),
	);

	// 4. js facet ----------------------------------------------------------------
	const HELLO_INST = installationId();
	const hello = jsPackage("acme.hello-js", HELLO_JS, [
		"emit",
		"net",
		"stash",
		"use_stash",
		"sleep",
	]);
	const helloPub = await post("publish", {
		...hello,
		installationId: HELLO_INST,
	});
	const helloSha = String(helloPub.json.sha256 ?? "");
	for (const p of [...Object.keys(hello.files), "tartan.json"]) {
		r2Keys.push(`ext/acme.hello-js/0.1.0/${helloSha}/${p}`);
	}
	const render = await post("render", {
		installationId: HELLO_INST,
		slot: "count",
		ctx: {
			slot: "repo.sidebar",
			node: "01k60000000000000000000002",
			repo: "01k60000000000000000000002",
			mode: "enforce",
		},
	});
	const renderText = JSON.stringify(render.json.value ?? render.json);
	record(
		"js facet: migrations and init in its own SQLite; render is read-only",
		renderText.includes("rows 1") &&
			renderText.includes("write denied:read-only"),
		`${renderText.slice(0, 140)} (${render.json.ms} ms cold)`,
	);
	const tool = (name: string) =>
		post("tool", { installationId: HELLO_INST, name, args: {} });
	const emit = await tool("emit");
	record(
		"js facet: an event through the per-call capability bridge",
		(emit.json.value as { id?: string })?.id === "string",
		JSON.stringify(emit.json).slice(0, 120),
	);
	const net = await tool("net");
	const netText = String((net.json.value as { fetch?: string })?.fetch);
	record(
		"js facet: no network (globalOutbound null)",
		netText !== "allowed",
		netText.slice(0, 120),
	);
	await tool("stash");
	const late = await tool("use_stash");
	const lateCode = String((late.json.value as { code?: string })?.code);
	record(
		"js facet: a stashed capability fails on the next call",
		lateCode !== "ok",
		lateCode.slice(0, 120),
	);
	const sleep = await tool("sleep");
	record(
		"js facet: a host timeout aborts an awaiting facet",
		sleep.json.ok === false &&
			/exceeded 10000 ms/.test(String(sleep.json.error)),
		`${String(sleep.json.error).slice(0, 100)} after ${sleep.json.ms} ms`,
	);
	const after = await tool("emit");
	record(
		"js facet: the next call runs after the abort",
		after.json.ok === true,
		`${after.json.ms} ms`,
	);
	const strikes = await post("strikes", { installationId: HELLO_INST });
	evidence.helloStrikes = strikes.json.value;

	// 5. runaway → breaker -------------------------------------------------
	if (!flag("skip-runaway")) {
		const SPIN_INST = installationId();
		const spin = jsPackage("acme.spin-js", SPIN_JS, ["spin", "ping"]);
		const spinPub = await post("publish", {
			...spin,
			installationId: SPIN_INST,
		});
		const spinSha = String(spinPub.json.sha256 ?? "");
		for (const p of [...Object.keys(spin.files), "tartan.json"]) {
			r2Keys.push(`ext/acme.spin-js/0.1.0/${spinSha}/${p}`);
		}
		const attempts: { ok: unknown; ms: unknown; error: string }[] = [];
		let short: { ok: unknown; ms: unknown; error: string } | null = null;
		for (let i = 0; i < 6; i++) {
			const r = await post("tool", {
				installationId: SPIN_INST,
				name: "spin",
				args: {},
			});
			const entry = {
				ok: r.json.ok,
				ms: r.json.ms,
				error: String(r.json.error ?? r.json.raw ?? r.status).slice(0, 160),
			};
			attempts.push(entry);
			console.log(`  spin ${i + 1}: ${entry.ms} ms ${entry.error}`);
			if (/circuit breaker open/.test(entry.error)) {
				short = entry;
				break;
			}
		}
		const s = await post("strikes", { installationId: SPIN_INST });
		evidence.runaway = { attempts, strikes: s.json.value };
		record(
			"a synchronous-loop facet opens the breaker within 3 invocations; later calls short-circuit",
			short !== null && attempts.length <= 4,
			`${attempts.length - 1} runaway calls, then: ${
				short?.error ?? "no breaker"
			} (${short?.ms} ms)`,
		);
	}

	evidence.results = results;
	evidence.leaks = leaks;
	evidence.r2Keys = r2Keys;
	evidence.finishedAt = new Date().toISOString();
	record(
		"no response carried the harness key",
		leaks.length === 0,
		leaks.join(", ") || "none",
	);
	const evidencePath = arg("evidence");
	if (evidencePath !== undefined) {
		await Deno.writeTextFile(
			path.resolve(evidencePath),
			JSON.stringify(evidence, null, "\t"),
		);
	}
	const failed = results.filter((r) => !r.ok);
	console.log(`\n${results.length - failed.length}/${results.length} passed`);
	if (failed.length > 0) Deno.exit(1);
};

if (import.meta.main) {
	try {
		await main();
	} catch (error) {
		console.error(
			`wp17: ${error instanceof Error ? error.message : String(error)}`,
		);
		Deno.exit(1);
	}
}
