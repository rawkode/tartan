// WP21 live acceptance.
//
// Default (safe under `deno task live -- --stage dev all`): read-only checks
// of a deployed stage: `/-/health` answers 200 for that stage with every
// binding `ok`, and `/-/setup` serves the SPA shell.
//
// `--cycle` (only for a scratch `dev-*` stage, never `dev` or `dev-demo`):
//   1. `scripts/deploy.ts --stage <s> --no-containers --no-print-url` into a
//      0600 file in a temp dir; checks the record, health and the URL file;
//   2. the same deploy again (idempotent; a new setup token on an unclaimed
//      forge, TARTAN_SECRET kept);
//   3. `scripts/destroy.ts --stage <s> --yes --delete-namespace`; checks that
//      the inventory is empty, the Worker no longer answers, the DCR outcome
//      was recorded and the local files are gone.
// No secret is printed: the setup URL stays in the temp file, which is
// deleted at the end.
//
// Usage:
//   deno task live -- --stage dev wp21 [--url <origin>]
//   deno task live -- --stage dev-wp21 wp21 --cycle

import * as path from "node:path";
import type { HealthResponse } from "@tartan/contract";
import {
	createCfApi,
	denoRun,
	REPO_ROOT,
	resolveAuth,
	stageNames,
} from "../preflight.ts";
import {
	formatInventory,
	isEmptyInventory,
	readInventory,
} from "../destroy.ts";
import { recordPath } from "../deploy.ts";

type Check = {
	readonly name: string;
	readonly ok: boolean;
	readonly detail: string;
};

const arg = (name: string): string | undefined => {
	const i = Deno.args.indexOf(`--${name}`);
	return i >= 0 ? Deno.args[i + 1] : undefined;
};

const checks: Check[] = [];
const check = (name: string, ok: boolean, detail = "") => {
	checks.push({ name, ok, detail });
	console.log(
		`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`,
	);
};

const readOnly = async (stage: string, origin: string) => {
	const t0 = performance.now();
	const response = await fetch(`${origin}/-/health`);
	const ms = Math.round(performance.now() - t0);
	const body = await response.json().catch(() => null) as
		| Partial<HealthResponse>
		| null;
	check(
		"health 200",
		response.status === 200,
		`HTTP ${response.status} in ${ms} ms`,
	);
	check(
		"health stage",
		body?.stage === stage,
		`stage ${JSON.stringify(body?.stage)}`,
	);
	const bad = Object.entries(body?.bindings ?? {}).filter(([, s]) =>
		s !== "ok"
	);
	check(
		"bindings ok",
		body !== null && bad.length === 0,
		`${Object.keys(body?.bindings ?? {}).length} bindings${
			bad.length
				? `; not ok: ${bad.map(([n, s]) => `${n}=${s}`).join(", ")}`
				: ""
		}`,
	);
	const page = await fetch(`${origin}/-/setup`, {
		headers: { accept: "text/html" },
	});
	const html = await page.text();
	check(
		"setup page",
		page.status === 200 && /<div id="app"/.test(html),
		`HTTP ${page.status}`,
	);
	return body;
};

const script = (name: string, args: readonly string[]) =>
	denoRun(Deno.execPath(), [
		"run",
		"-A",
		path.join(REPO_ROOT, "scripts", name),
		...args,
	], {
		io: "inherit",
		cwd: REPO_ROOT,
	});

const cycle = async (stage: string) => {
	const names = stageNames(stage);
	const temp = await Deno.makeTempDir({ prefix: "wp21-" });
	const urlFile = path.join(temp, "setup-url.txt");
	try {
		const started = Date.now();
		const deployed = await script("deploy.ts", [
			"--stage",
			stage,
			"--no-containers",
			"--no-print-url",
			"--url-file",
			urlFile,
		]);
		const seconds = Math.round((Date.now() - started) / 1000);
		check("deploy exit 0", deployed.code === 0, `${seconds} s`);
		if (deployed.code !== 0) return;
		const record = JSON.parse(
			await Deno.readTextFile(recordPath(REPO_ROOT, stage)),
		);
		check("record worker", record.worker === names.worker, record.worker);
		check(
			"record image none",
			record.image?.variant === "none",
			JSON.stringify(record.image),
		);
		const stat = await Deno.stat(urlFile);
		const mode = (stat.mode ?? 0) & 0o777;
		check("setup URL file 0600", mode === 0o600, `mode ${mode.toString(8)}`);
		const url = (await Deno.readTextFile(urlFile)).trim();
		check(
			"setup URL shape",
			url.startsWith(`${record.workersDev}/-/setup#t=`) &&
				url.length > record.workersDev.length + 20,
			"https://<workers.dev>/-/setup#t=<token> (token not shown)",
		);
		const health = await readOnly(stage, record.workersDev);
		check(
			"setup state fresh",
			health?.setupState === "fresh",
			String(health?.setupState),
		);

		const again = await script("deploy.ts", [
			"--stage",
			stage,
			"--no-containers",
			"--no-print-url",
			"--url-file",
			urlFile,
			"--skip-build",
		]);
		check("redeploy exit 0", again.code === 0);
		const url2 = (await Deno.readTextFile(urlFile)).trim();
		check(
			"redeploy issued a new setup token",
			url2 !== url && url2.startsWith(`${record.workersDev}/-/setup#t=`),
		);

		const destroyed = await script("destroy.ts", [
			"--stage",
			stage,
			"--yes",
			"--delete-namespace",
		]);
		check("destroy exit 0", destroyed.code === 0);
		const after = JSON.parse(
			await Deno.readTextFile(recordPath(REPO_ROOT, stage)),
		);
		check(
			"DCR outcome recorded",
			after.dcr !== undefined && after.dcr !== null,
			JSON.stringify(after.dcr),
		);
		const auth = await resolveAuth({
			run: denoRun,
			env: (n) => Deno.env.get(n),
			login: false,
			log: () => {},
		});
		const api = createCfApi({
			token: auth.token!,
			accountId: auth.account.id,
			fetch,
		});
		const left = await readInventory(api, denoRun, names, {
			CLOUDFLARE_ACCOUNT_ID: auth.account.id,
		});
		check(
			"inventory empty",
			isEmptyInventory(left) && !left.namespace,
			`\n${formatInventory(names, left)}`,
		);
		const gone = await fetch(`${record.workersDev}/-/health`).then((r) =>
			r.status
		).catch(() => 0);
		check("Worker no longer answers", gone !== 200, `HTTP ${gone}`);
		const rendered = await Deno.stat(
			path.join(REPO_ROOT, ".wrangler", "deploy", `wrangler.${stage}.jsonc`),
		).then(() => true).catch(() => false);
		check("rendered config removed", !rendered);
	} finally {
		await Deno.remove(temp, { recursive: true }).catch(() => {});
	}
};

const main = async (): Promise<number> => {
	const stage = arg("stage");
	if (!stage || !/^dev(-|$)/.test(stage)) {
		console.error(
			"usage: wp21-deploy.ts --stage dev[-*] [--url <origin>] [--cycle]",
		);
		return 2;
	}
	if (Deno.args.includes("--cycle")) {
		if (stage === "dev" || stage === "dev-demo") {
			console.error(
				`--cycle deploys and destroys; use a scratch stage, not ${stage}`,
			);
			return 2;
		}
		console.log(`wp21: deploy → redeploy → destroy cycle on ${stage}`);
		await cycle(stage);
	} else {
		const origin = arg("url") ?? await (async () => {
			const auth = await resolveAuth({
				run: denoRun,
				env: (n) => Deno.env.get(n),
				login: false,
				log: () => {},
			});
			const api = createCfApi({
				token: auth.token!,
				accountId: auth.account.id,
				fetch,
			});
			const sub = (await api.account("GET", "/workers/subdomain")).body?.result
				?.subdomain;
			return `https://${stageNames(stage).worker}.${sub}.workers.dev`;
		})();
		console.log(`wp21: read-only checks of ${origin}`);
		await readOnly(stage, origin);
	}
	const failed = checks.filter((c) => !c.ok);
	console.log(`wp21: ${checks.length - failed.length}/${checks.length} PASS`);
	return failed.length === 0 ? 0 : 1;
};

if (import.meta.main) Deno.exit(await main());
