// Stage-scoped destroy.
//
//   deno task destroy -- --stage <stage>
//
// Touches only resources whose names the stage determines (scripts/
// preflight.ts `stageNames`: Worker `tartan-<stage>`, Workflows
// `tartan-<stage>-{run,land,ingest,swarm}`, bucket `tartan-<stage>-blobs`, KV
// `tartan-<stage>-oauth-kv`, container application and registry image
// `tartan-<stage>-tartansandbox`, Artifacts namespace `tartan-<stage>`), and
// refuses when the Worker's `/-/health` names another stage. In order:
//   1. an inventory of what exists, then one confirmation (type the stage
//      name, or `--yes`);
//   2. DCR deregistration: a one-time `TARTAN_DESTROY_TOKEN` is set through
//      stdin and `POST /-/admin/idp/deregister` deletes the stage's client at
//      the IdP (RFC 7592); a failure prints the client id for removal by hand;
//   3. the Worker (which releases its Custom Domain and its Durable Objects),
//      the Workflows, the container application and its registry images, the
//      bucket (emptied first), the KV namespace and the global log's K2
//      stream `tartan_<stage>_log` (deleted only under that exact name);
//   4. the stage's Artifacts repos (canonical `r-*` and lane `l-*`), listed
//      and deleted after their own confirmation (`--keep-repos` skips);
//   5. the Artifacts namespace itself has no wrangler command: the script
//      prints the REST `DELETE` (or runs it with `--delete-namespace`);
//   6. local files (the rendered config, the setup URL file) and the deploy
//      record, which keeps the DCR outcome and what was removed.
//
// Deploy tooling only; runtime code never imports it.

import * as path from "node:path";
import type { IdpDeregisterResponse } from "@tartan/contract";
import { defaultOutPath, renderConfig } from "./render-config.ts";
import {
	CF_API,
	type CfApi,
	cfErrorText,
	createCfApi,
	denoRun,
	parseFlags,
	PreflightError,
	readTextOrNull,
	REPO_ROOT,
	resolveAuth,
	type Run,
	type StageNames,
	stageNames,
	UsageError,
	wrangler,
} from "./preflight.ts";
import { logStreamName } from "../src/kernel/bus/config.ts";
import { generateSecret, recordPath } from "./deploy.ts";
import { cfK2Streams, deleteLogStream } from "./k2.ts";

export class DestroyError extends Error {
	override name = "DestroyError";
}

export const DESTROY_TOKEN = "TARTAN_DESTROY_TOKEN";
export const DEREGISTER_TIMEOUT_MS = 60_000;

export type DestroyOptions = {
	readonly stage: string;
	readonly account?: string;
	/** Skip both confirmations (automation). */
	readonly yes: boolean;
	readonly keepRepos: boolean;
	readonly deleteNamespace: boolean;
};

export const DESTROY_FLAGS = {
	stage: "value",
	account: "value",
	yes: "bool",
	"keep-repos": "bool",
	"delete-namespace": "bool",
} as const;

export const DESTROY_USAGE =
	`Usage: deno task destroy -- --stage <stage> [options]

  --stage <stage>       required; only resources named tartan-<stage>[-…] are touched
  --yes                 do not ask (the inventory is still printed)
  --keep-repos          keep the stage's Artifacts repos
  --delete-namespace    also send the REST DELETE for the Artifacts namespace
  --account <id|name>   pick the Cloudflare account (or CLOUDFLARE_ACCOUNT_ID)`;

export const destroyOptionsFromArgs = (
	args: readonly string[],
): DestroyOptions | undefined => {
	const flags = parseFlags(args, DESTROY_FLAGS);
	if (flags.has("help")) return undefined;
	const stage = flags.get("stage");
	if (typeof stage !== "string") throw new UsageError("--stage is required");
	try {
		stageNames(stage);
	} catch (error) {
		throw new UsageError((error as Error).message);
	}
	const account = flags.get("account");
	if (flags.has("keep-repos") && flags.has("delete-namespace")) {
		throw new UsageError(
			"--delete-namespace needs the repos gone; drop --keep-repos",
		);
	}
	return {
		stage,
		account: typeof account === "string" ? account : undefined,
		yes: flags.has("yes"),
		keepRepos: flags.has("keep-repos"),
		deleteNamespace: flags.has("delete-namespace"),
	};
};

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

export type Inventory = {
	readonly worker: boolean;
	readonly workflows: readonly string[];
	readonly containerApps: readonly {
		readonly id: string;
		readonly name: string;
	}[];
	readonly images: readonly string[];
	readonly bucket: boolean;
	/** Durable Object namespaces of the Worker (they go with the Worker). */
	readonly durableObjects: readonly string[];
	readonly kv: readonly { readonly id: string; readonly title: string }[];
	readonly repos: readonly string[] | null;
	readonly namespace: boolean;
	/** The stage's K2 stream `tartan_<stage>_log`, if any (WP26). */
	readonly k2Stream?: { readonly id: string; readonly name: string } | null;
};

export const isEmptyInventory = (inv: Inventory): boolean =>
	!inv.worker && inv.workflows.length === 0 && inv.containerApps.length === 0 &&
	inv.images.length === 0 && !inv.bucket && inv.kv.length === 0 &&
	inv.durableObjects.length === 0 &&
	(inv.repos ?? []).length === 0 && (inv.k2Stream ?? null) === null;

const exists = async (api: CfApi, apiPath: string): Promise<boolean> => {
	const { status, body } = await api.account("GET", apiPath);
	if (status === 200) return true;
	if (status === 404) return false;
	throw new DestroyError(`GET ${apiPath}: HTTP ${status} ${cfErrorText(body)}`);
};

/** Image names `name:tag` of the stage's container application. */
export const stageImages = (list: unknown, appName: string): string[] =>
	(Array.isArray(list) ? list : []).flatMap((image: {
		name?: unknown;
		tags?: unknown;
	}) =>
		image?.name === appName && Array.isArray(image.tags)
			? image.tags.map((tag) => `${appName}:${String(tag)}`)
			: []
	);

export const readInventory = async (
	api: CfApi,
	run: Run,
	names: StageNames,
	env: Record<string, string>,
): Promise<Inventory> => {
	const worker = await exists(api, `/workers/scripts/${names.worker}/settings`);
	const workflows: string[] = [];
	for (const name of names.workflows) {
		if (await exists(api, `/workflows/${name}`)) workflows.push(name);
	}
	const apps = await api.account("GET", "/containers/applications");
	const containerApps = apps.status === 200 && Array.isArray(apps.body?.result)
		? apps.body.result
			.filter((a: { name?: unknown }) => a.name === names.containerApp)
			.map((a: { id: unknown; name: unknown }) => ({
				id: String(a.id),
				name: String(a.name),
			}))
		: [];
	const imageList = await wrangler(run, [
		"containers",
		"images",
		"list",
		"--json",
	], {
		env,
	});
	let images: string[] = [];
	try {
		images = stageImages(
			JSON.parse(imageList.stdout.slice(imageList.stdout.search(/[[{]/))),
			names.containerApp,
		);
	} catch {
		images = [];
	}
	const bucket = await exists(api, `/r2/buckets/${names.bucket}`);
	let durableObjects: string[] = [];
	try {
		durableObjects = (await api.list(
			`/accounts/${api.accountId}/workers/durable_objects/namespaces`,
		))
			.filter((n: { script?: unknown }) => n.script === names.worker)
			.map((n: { class?: unknown; name?: unknown }) =>
				String(n.class ?? n.name)
			);
	} catch {
		durableObjects = [];
	}
	const kv =
		(await api.list(`/accounts/${api.accountId}/storage/kv/namespaces`))
			.filter((k: { title?: unknown }) => k.title === names.kvTitle)
			.map((k: { id: unknown; title: unknown }) => ({
				id: String(k.id),
				title: String(k.title),
			}));
	let repos: string[] | null;
	try {
		repos = (await api.list(
			`/accounts/${api.accountId}/artifacts/namespaces/${names.namespace}/repos`,
			50,
		)).map((r: { name?: unknown }) => String(r.name));
	} catch {
		repos = null;
	}
	let k2Stream: { id: string; name: string } | null = null;
	try {
		const wanted = logStreamName(names.stage);
		const found = (await cfK2Streams(api).list()).find((s) =>
			s.name === wanted
		);
		k2Stream = found ? { id: found.id, name: found.name } : null;
	} catch {
		// K2 (public beta) not available on the account: nothing to delete.
		k2Stream = null;
	}
	const namespaces = await api.account("GET", "/artifacts/namespaces");
	const namespace = namespaces.status === 200 &&
		Array.isArray(namespaces.body?.result) &&
		namespaces.body.result.some((n: { namespace?: unknown; name?: unknown }) =>
			n.namespace === names.namespace || n.name === names.namespace
		);
	return {
		worker,
		workflows,
		containerApps,
		images,
		bucket,
		durableObjects,
		kv,
		repos,
		namespace,
		k2Stream,
	};
};

export const formatInventory = (names: StageNames, inv: Inventory): string => {
	const line = (what: string, items: readonly string[]) =>
		`  ${what.padEnd(22)} ${items.length === 0 ? "-" : items.join(", ")}`;
	const repos = inv.repos ?? [];
	return [
		line("Worker", inv.worker ? [names.worker] : []),
		line("Workflows", inv.workflows),
		line("container application", inv.containerApps.map((a) => a.name)),
		line("registry images", inv.images),
		line("R2 bucket", inv.bucket ? [names.bucket] : []),
		line("Durable Objects", inv.durableObjects),
		line("KV namespace", inv.kv.map((k) => `${k.title} (${k.id})`)),
		line(
			"Artifacts repos",
			inv.repos === null ? ["(could not list)"] : [
				`${repos.filter((r) => r.startsWith("r-")).length} canonical r-*`,
				`${repos.filter((r) => r.startsWith("l-")).length} lane l-*`,
				...(repos.some((r) => !/^[rl]-/.test(r))
					? [`${repos.filter((r) => !/^[rl]-/.test(r)).length} other`]
					: []),
			],
		),
		line("Artifacts namespace", inv.namespace ? [names.namespace] : []),
		line(
			"K2 stream",
			inv.k2Stream ? [`${inv.k2Stream.name} (${inv.k2Stream.id})`] : [],
		),
	].join("\n");
};

/** The manual namespace step (wrangler has no namespace delete). */
export const namespaceStep = (accountId: string, namespace: string): string =>
	[
		`The Artifacts namespace ${namespace} is left (wrangler has no namespace delete). Once its repos are gone, delete it with`,
		`  curl -X DELETE -H "Authorization: Bearer $(npx wrangler auth token)" \\`,
		`    ${CF_API}/accounts/${accountId}/artifacts/namespaces/${namespace}`,
		`or rerun with --delete-namespace.`,
	].join("\n");

// ---------------------------------------------------------------------------
// DCR deregistration
// ---------------------------------------------------------------------------

export type DeregisterOutcome =
	| { readonly kind: "deregistered"; readonly clientId: string }
	| {
		readonly kind: "none";
		readonly clientId: string;
		readonly reason: string;
	}
	| {
		readonly kind: "failed";
		readonly clientId?: string;
		readonly reason: string;
	};

/**
 * Posts the destroy token until the new secret is live (404 meanwhile), then
 * maps the answer. A 200 with `deregistered: false` and no client is "none".
 */
export const deregister = async (input: {
	readonly fetch: typeof fetch;
	readonly origin: string;
	readonly token: string;
	readonly timeoutMs: number;
	readonly now: () => number;
	readonly sleep: (ms: number) => Promise<void>;
}): Promise<DeregisterOutcome> => {
	const deadline = input.now() + input.timeoutMs;
	let last = "no answer";
	for (;;) {
		try {
			const response = await input.fetch(
				`${input.origin}/-/admin/idp/deregister`,
				{
					method: "POST",
					headers: { authorization: `Bearer ${input.token}` },
				},
			);
			const body = await response.json().catch(() => null) as
				| (Partial<IdpDeregisterResponse> & {
					readonly error?: { readonly message?: string };
				})
				| null;
			if (response.status === 200 && typeof body?.deregistered === "boolean") {
				const answer = body as IdpDeregisterResponse;
				if (answer.deregistered) {
					return { kind: "deregistered", clientId: answer.clientId };
				}
				return answer.clientId === "" ||
						answer.reason === "the IdP client was not registered by DCR"
					? {
						kind: "none",
						clientId: answer.clientId,
						reason: answer.reason ?? "nothing to deregister",
					}
					: {
						kind: "failed",
						clientId: answer.clientId,
						reason: answer.reason ?? "the IdP refused",
					};
			}
			if (response.status !== 404) {
				return {
					kind: "failed",
					reason: `HTTP ${response.status}${
						body?.error?.message ? `: ${body.error.message}` : ""
					}`,
				};
			}
			last = "HTTP 404 (the destroy token is not live yet)";
		} catch (error) {
			last = (error as Error).message.split("\n")[0];
		}
		if (input.now() >= deadline) return { kind: "failed", reason: last };
		await input.sleep(3_000);
	}
};

// ---------------------------------------------------------------------------
// The destroy
// ---------------------------------------------------------------------------

export type DestroyDeps = {
	readonly run: Run;
	readonly fetch: typeof fetch;
	readonly env: (name: string) => string | undefined;
	readonly now: () => number;
	readonly sleep: (ms: number) => Promise<void>;
	readonly root: string;
	readonly readText: (file: string) => Promise<string | null>;
	readonly writeText: (file: string, text: string) => Promise<void>;
	readonly remove: (file: string) => Promise<void>;
	readonly random: (n: number) => Uint8Array;
	readonly log: (line: string) => void;
	readonly interactive: boolean;
	readonly ask: (question: string) => Promise<string | null>;
};

export type DestroyReport = {
	readonly stage: string;
	readonly removed: readonly string[];
	readonly failed: readonly string[];
	readonly dcr: DeregisterOutcome | null;
	readonly left: Inventory;
};

const confirmStage = async (
	deps: DestroyDeps,
	options: DestroyOptions,
	question: string,
): Promise<boolean> => {
	if (options.yes) return true;
	if (!deps.interactive) {
		throw new DestroyError(
			"refusing to destroy without a terminal to confirm on; pass --yes",
		);
	}
	const answer = await deps.ask(`${question} Type the stage name to confirm:`);
	return answer?.trim() === options.stage;
};

export const runDestroy = async (
	options: DestroyOptions,
	deps: DestroyDeps,
): Promise<DestroyReport> => {
	const log = deps.log;
	const names = stageNames(options.stage);
	const auth = await resolveAuth({
		run: deps.run,
		env: deps.env,
		account: options.account,
		login: deps.interactive,
		log,
	});
	if (auth.token === null) {
		throw new PreflightError(
			"destroy needs an API token: `npx wrangler auth token --json` gave none; set CLOUDFLARE_API_TOKEN",
		);
	}
	const api = createCfApi({
		token: auth.token,
		accountId: auth.account.id,
		fetch: deps.fetch,
	});
	const env = { CLOUDFLARE_ACCOUNT_ID: auth.account.id };
	const subdomain = (await api.account("GET", "/workers/subdomain")).body
		?.result?.subdomain;
	const origin = typeof subdomain === "string"
		? `https://${names.worker}.${subdomain}.workers.dev`
		: null;

	const inventory = await readInventory(api, deps.run, names, env);
	log(
		`Stage ${options.stage} in account ${auth.account.name} (${auth.account.id}):`,
	);
	log(formatInventory(names, inventory));
	if (isEmptyInventory(inventory)) {
		log("Nothing of this stage is left to destroy.");
	}

	// The Worker must say it is this stage before anything is removed.
	if (inventory.worker && origin !== null) {
		const health = await deps.fetch(`${origin}/-/health`).then((r) => r.json())
			.catch(() => null) as { product?: unknown; stage?: unknown } | null;
		if (health?.product === "Tartan" && health.stage !== options.stage) {
			throw new DestroyError(
				`${names.worker} reports stage ${
					JSON.stringify(health.stage)
				}, not ${options.stage}; refusing`,
			);
		}
	}

	if (
		!isEmptyInventory(inventory) &&
		!(await confirmStage(deps, options, `Destroy stage ${options.stage}?`))
	) {
		throw new DestroyError("not confirmed; nothing was removed");
	}

	const removed: string[] = [];
	const failed: string[] = [];
	const step = async (what: string, work: () => Promise<void>) => {
		try {
			await work();
			removed.push(what);
			log(`  removed ${what}`);
		} catch (error) {
			failed.push(`${what}: ${(error as Error).message}`);
			log(`  FAILED ${what}: ${(error as Error).message}`);
		}
	};
	const del = async (apiPath: string) => {
		const { status, body } = await api.account("DELETE", apiPath);
		if (status !== 200 && status !== 204 && status !== 404) {
			throw new Error(`HTTP ${status} ${cfErrorText(body)}`.trim());
		}
	};

	// 2. DCR deregistration (needs the live Worker).
	let dcr: DeregisterOutcome | null = null;
	const configPath = defaultOutPath(
		path.join(deps.root, "wrangler.jsonc"),
		options.stage,
	);
	if (inventory.worker && origin !== null) {
		log("Deregistering the stage's OIDC client at the IdP (RFC 7592)…");
		const source = await deps.readText(path.join(deps.root, "wrangler.jsonc"));
		const secretConfig = path.join(
			path.dirname(configPath),
			`wrangler.${options.stage}.destroy.jsonc`,
		);
		try {
			await deps.writeText(
				secretConfig,
				renderConfig(source ?? "", {
					stage: options.stage,
					containers: false,
					image: { kind: "dockerfile" },
					evictionFlag: true,
					sourceDir: deps.root,
					outDir: path.dirname(secretConfig),
				}),
			);
			const token = generateSecret(deps.random);
			const put = await wrangler(deps.run, [
				"secret",
				"put",
				DESTROY_TOKEN,
				"-c",
				secretConfig,
			], { stdin: token, env });
			dcr = put.code !== 0
				? {
					kind: "failed",
					reason:
						`wrangler secret put ${DESTROY_TOKEN} failed (exit ${put.code})`,
				}
				: await deregister({
					fetch: deps.fetch,
					origin,
					token,
					timeoutMs: DEREGISTER_TIMEOUT_MS,
					now: deps.now,
					sleep: deps.sleep,
				});
		} finally {
			await deps.remove(secretConfig);
		}
		if (dcr.kind === "deregistered") {
			log(`  deregistered OIDC client ${dcr.clientId}`);
		} else if (dcr.kind === "none") {
			log(`  no DCR client to deregister (${dcr.reason})`);
		} else {
			log(
				`  WARNING: the OIDC client was not deregistered (${dcr.reason}). ${
					dcr.clientId
						? `Remove client ${dcr.clientId} at your IdP by hand.`
						: `Check your IdP for a client with the redirect URI ${origin}/-/auth/callback and remove it by hand.`
				}`,
			);
		}
	} else if (inventory.worker) {
		dcr = {
			kind: "failed",
			reason: "no workers.dev subdomain to reach the Worker",
		};
		log(
			`  WARNING: could not reach the Worker to deregister its OIDC client; check your IdP by hand`,
		);
	}

	// 3. Cloudflare resources of the stage.
	if (inventory.worker) {
		await step(
			`Worker ${names.worker}`,
			() => del(`/workers/scripts/${names.worker}?force=true`),
		);
	}
	for (const name of inventory.workflows) {
		await step(`Workflow ${name}`, () => del(`/workflows/${name}`));
	}
	if (inventory.k2Stream) {
		const stream = inventory.k2Stream;
		await step(
			`K2 stream ${stream.name}`,
			() =>
				deleteLogStream(cfK2Streams(api), {
					stage: options.stage,
					streamId: stream.id,
				}).then(() => {}),
		);
	}
	for (const app of inventory.containerApps) {
		await step(
			`container application ${app.name}`,
			() => del(`/containers/applications/${app.id}`),
		);
	}
	for (const image of inventory.images) {
		await step(`registry image ${image}`, async () => {
			const out = await wrangler(deps.run, [
				"containers",
				"images",
				"delete",
				image,
				"--skip-confirmation",
			], { env });
			if (out.code !== 0) throw new Error(`exit ${out.code}`);
		});
	}
	if (inventory.bucket) {
		await step(`R2 bucket ${names.bucket}`, async () => {
			const first = await api.account("DELETE", `/r2/buckets/${names.bucket}`);
			if (first.status === 200 || first.status === 404) return;
			// Not empty: delete the stage's objects (logs, blobs), then retry.
			let count = 0;
			for (let round = 0; round < 1000; round++) {
				const page = await api.account(
					"GET",
					`/r2/buckets/${names.bucket}/objects?per_page=1000`,
				);
				const keys: string[] = Array.isArray(page.body?.result)
					? page.body.result.map((o: { key?: unknown }) => String(o.key))
					: [];
				if (page.status !== 200) {
					throw new Error(`listing objects: HTTP ${page.status}`);
				}
				if (keys.length === 0) break;
				for (const key of keys) {
					await del(
						`/r2/buckets/${names.bucket}/objects/${encodeURIComponent(key)}`,
					);
					count++;
				}
			}
			log(`  emptied ${names.bucket} (${count} objects)`);
			await del(`/r2/buckets/${names.bucket}`);
		});
	}
	for (const kv of inventory.kv) {
		await step(
			`KV namespace ${kv.title}`,
			() => del(`/storage/kv/namespaces/${kv.id}`),
		);
	}

	// 4. Artifacts repos, with their own confirmation.
	const repos = inventory.repos ?? [];
	if (repos.length > 0 && !options.keepRepos) {
		log(`Artifacts repos in ${names.namespace}:`);
		for (const repo of repos) log(`  ${repo}`);
		if (
			await confirmStage(
				deps,
				options,
				`Delete these ${repos.length} repos (git data)?`,
			)
		) {
			for (const repo of repos) {
				await step(`Artifacts repo ${repo}`, async () => {
					const out = await wrangler(deps.run, [
						"artifacts",
						"repos",
						"delete",
						repo,
						"--namespace",
						names.namespace,
						"--force",
					], { env });
					if (out.code !== 0) throw new Error(`exit ${out.code}`);
				});
			}
		} else {
			log("  kept the repos");
		}
	} else if (repos.length > 0) {
		log(`Kept ${repos.length} Artifacts repos (--keep-repos).`);
	}

	// 5. The namespace.
	if (inventory.namespace) {
		if (options.deleteNamespace) {
			await step(
				`Artifacts namespace ${names.namespace}`,
				() => del(`/artifacts/namespaces/${names.namespace}`),
			);
		} else {
			log(namespaceStep(auth.account.id, names.namespace));
		}
	}

	// 6. Local files and the record.
	for (
		const file of [
			configPath,
			path.join(
				deps.root,
				".wrangler",
				"deploy",
				`setup-url.${options.stage}.txt`,
			),
		]
	) {
		await deps.remove(file);
	}
	const left = await readInventory(api, deps.run, names, env);
	const recordFile = recordPath(deps.root, options.stage);
	const previous = await deps.readText(recordFile);
	await deps.writeText(
		recordFile,
		`${
			JSON.stringify(
				{
					...(previous ? JSON.parse(previous) : { stage: options.stage }),
					destroyedAt: new Date(deps.now()).toISOString(),
					dcr,
					removed,
					failed,
					left: isEmptyInventory(left) ? null : left,
				},
				null,
				"\t",
			)
		}\n`,
	);
	log(
		isEmptyInventory(left)
			? `Stage ${options.stage} is gone${
				left.namespace ? " (except the namespace, above)" : ""
			}.`
			: `Still present:\n${formatInventory(names, left)}`,
	);
	return { stage: options.stage, removed, failed, dcr, left };
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const main = async (): Promise<number> => {
	try {
		const options = destroyOptionsFromArgs(Deno.args);
		if (options === undefined) {
			console.log(DESTROY_USAGE);
			return 0;
		}
		const report = await runDestroy(options, {
			run: denoRun,
			fetch,
			env: (name) => Deno.env.get(name),
			now: Date.now,
			sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
			root: REPO_ROOT,
			readText: readTextOrNull,
			writeText: async (file, text) => {
				await Deno.mkdir(path.dirname(file), { recursive: true });
				await Deno.writeTextFile(file, text);
			},
			remove: async (file) => {
				await Deno.remove(file).catch(() => {});
			},
			random: (n) => crypto.getRandomValues(new Uint8Array(n)),
			log: (line) => console.log(line),
			interactive: Deno.stdin.isTerminal(),
			ask: (question) => Promise.resolve(prompt(question)),
		});
		return report.failed.length === 0 && isEmptyInventory(report.left) ? 0 : 1;
	} catch (error) {
		if (error instanceof UsageError) {
			console.error(`destroy: ${error.message}\n\n${DESTROY_USAGE}`);
			return 2;
		}
		if (error instanceof DestroyError || error instanceof PreflightError) {
			console.error(`destroy: ${error.message}`);
			return 1;
		}
		throw error;
	}
};

if (import.meta.main) Deno.exit(await main());
