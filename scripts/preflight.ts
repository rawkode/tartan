// Deploy preflight.
//
// Every check fails fast with a fix-it message, or degrades to a warning when
// it cannot be decided (the in-app wizard checks stay authoritative):
//   - toolchain: Node 22+, Deno 2.9+, the npm-installed wrangler;
//   - `npx wrangler whoami --json`: logged in, one account resolved;
//   - the Artifacts entitlement: `GET /accounts/{id}/artifacts/namespaces`
//     with the token from `npx wrangler auth token --json` (or
//     `CLOUDFLARE_API_TOKEN`): 200 entitled, 401 bad token, 403/404 gated;
//   - the account's workers.dev subdomain (the health poll uses it);
//   - Workers Paid, where the token may read subscriptions (else a warning);
//   - a container engine and free disk, only when an image is built here
//     (`--image dockerfile`, or `registry` without a still-valid record);
//   - for `--domain`: the zone is in the account, no DNS record holds the
//     hostname, and it is not another Worker's Custom Domain (refused unless
//     `--take-domain`).
//
// This file also holds the pieces deploy.ts and destroy.ts share: the process
// runner, the Cloudflare REST client, account resolution and stage naming.
// Deploy tooling only; runtime code never imports it.
//
// Usage:
//   deno run -A scripts/preflight.ts --stage <stage> [--domain <host>]
//     [--take-domain] [--no-containers | --image dockerfile|registry
//     [--image-record <path>]] [--account <id|name>]

import * as path from "node:path";
import {
	DEV_TOOLS_STAGE_RE,
	parseImageKind,
	RUNNER_IMAGE_RECORD,
	SANDBOX_CLASS,
	validateDomain,
	validateRegistryRef,
	validateStage,
} from "./render-config.ts";

// ---------------------------------------------------------------------------
// Process runner (a port, so the flows are testable without wrangler)
// ---------------------------------------------------------------------------

export type RunResult = {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
};

export type RunOptions = {
	/** Written to the child's stdin, which is then closed (secrets go here). */
	readonly stdin?: string;
	/**
	 * `inherit`: the child talks to the terminal (nothing captured); `tee`:
	 * output is shown and captured. Default: captured only.
	 */
	readonly io?: "capture" | "inherit" | "tee";
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string>>;
};

export type Run = (
	cmd: string,
	args: readonly string[],
	options?: RunOptions,
) => Promise<RunResult>;

const pump = async (
	stream: ReadableStream<Uint8Array>,
	sink: { writeSync(p: Uint8Array): number } | null,
): Promise<string> => {
	const decoder = new TextDecoder();
	let text = "";
	for await (const chunk of stream) {
		if (sink !== null) sink.writeSync(chunk);
		text += decoder.decode(chunk, { stream: true });
	}
	return text + decoder.decode();
};

export const denoRun: Run = async (cmd, args, options = {}) => {
	const io = options.io ?? "capture";
	const child = new Deno.Command(cmd, {
		args: [...args],
		cwd: options.cwd,
		env: options.env ? { ...options.env } : undefined,
		stdin: options.stdin !== undefined
			? "piped"
			: io === "inherit"
			? "inherit"
			: "null",
		stdout: io === "inherit" ? "inherit" : "piped",
		stderr: io === "inherit" ? "inherit" : "piped",
	}).spawn();
	if (options.stdin !== undefined) {
		const writer = child.stdin.getWriter();
		await writer.write(new TextEncoder().encode(options.stdin));
		await writer.close();
	}
	if (io === "inherit") {
		const status = await child.status;
		return { code: status.code, stdout: "", stderr: "" };
	}
	const [stdout, stderr, status] = await Promise.all([
		pump(child.stdout, io === "tee" ? Deno.stdout : null),
		pump(child.stderr, io === "tee" ? Deno.stderr : null),
		child.status,
	]);
	return { code: status.code, stdout, stderr };
};

/** `npx wrangler <args>` (the pinned devDependency; never a global install). */
export const wrangler = (
	run: Run,
	args: readonly string[],
	options?: RunOptions,
): Promise<RunResult> => run("npx", ["wrangler", ...args], options);

/** The first JSON value in a command's output (wrangler may print a banner). */
export const parseJsonOutput = (text: string): unknown => {
	const start = text.search(/[[{]/);
	if (start === -1) throw new Error("no JSON in the output");
	return JSON.parse(text.slice(start));
};

// ---------------------------------------------------------------------------
// Stage naming (the names scripts/render-config.ts gives every resource)
// ---------------------------------------------------------------------------

export const WORKFLOW_SUFFIXES = ["run", "land", "ingest", "swarm"] as const;

export type StageNames = {
	readonly stage: string;
	readonly worker: string;
	readonly namespace: string;
	readonly bucket: string;
	readonly workflows: readonly string[];
	/** Auto-provisioned KV namespace title: `<worker>-<binding, kebab-cased>`. */
	readonly kvTitle: string;
	/** Container application (and registry image) name: `<worker>-<class>`. */
	readonly containerApp: string;
};

export const stageNames = (stage: string): StageNames => {
	const worker = `tartan-${validateStage(stage)}`;
	return {
		stage,
		worker,
		namespace: worker,
		bucket: `${worker}-blobs`,
		workflows: WORKFLOW_SUFFIXES.map((suffix) => `${worker}-${suffix}`),
		kvTitle: `${worker}-oauth-kv`,
		containerApp: `${worker}-${SANDBOX_CLASS.toLowerCase()}`,
	};
};

/** Dev stages, the only ones the dev tools may target: `dev`, `dev-*`. */
export const isDevStage = (stage: string): boolean =>
	DEV_TOOLS_STAGE_RE.test(stage);

// ---------------------------------------------------------------------------
// Cloudflare REST client
// ---------------------------------------------------------------------------

export const CF_API = "https://api.cloudflare.com/client/v4";

export type CfResponse = {
	readonly status: number;
	// deno-lint-ignore no-explicit-any
	readonly body: any;
};

export type CfApi = {
	readonly accountId: string;
	request(
		method: string,
		path: string,
		body?: unknown,
	): Promise<CfResponse>;
	/** `request` with `/accounts/<id>` prefixed. */
	account(method: string, path: string, body?: unknown): Promise<CfResponse>;
	/** Every `result` item of a paginated GET (`page`/`per_page`). */
	// deno-lint-ignore no-explicit-any
	list(path: string, perPage?: number): Promise<any[]>;
};

export class CfApiError extends Error {
	override name = "CfApiError";
	constructor(readonly status: number, readonly what: string, detail: string) {
		super(`${what}: HTTP ${status}${detail ? ` (${detail})` : ""}`);
	}
}

/** The first error message of a v4 envelope, without echoing anything else. */
export const cfErrorText = (body: unknown): string => {
	const errors = (body as { errors?: unknown } | null)?.errors;
	if (!Array.isArray(errors) || errors.length === 0) return "";
	const first = errors[0] as { code?: unknown; message?: unknown };
	return [first.code, first.message].filter((x) => x !== undefined).join(" ");
};

export const createCfApi = (deps: {
	readonly token: string;
	readonly accountId: string;
	readonly fetch: typeof fetch;
}): CfApi => {
	const request = async (
		method: string,
		apiPath: string,
		body?: unknown,
	): Promise<CfResponse> => {
		const response = await deps.fetch(`${CF_API}${apiPath}`, {
			method,
			headers: {
				authorization: `Bearer ${deps.token}`,
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await response.text();
		let parsed: unknown = null;
		try {
			parsed = text === "" ? null : JSON.parse(text);
		} catch {
			parsed = null;
		}
		return { status: response.status, body: parsed };
	};
	const account = (method: string, apiPath: string, body?: unknown) =>
		request(method, `/accounts/${deps.accountId}${apiPath}`, body);
	const list = async (apiPath: string, perPage = 100) => {
		// deno-lint-ignore no-explicit-any
		const items: any[] = [];
		const sep = apiPath.includes("?") ? "&" : "?";
		for (let page = 1; page <= 100; page++) {
			const { status, body } = await request(
				"GET",
				`${apiPath}${sep}page=${page}&per_page=${perPage}`,
			);
			if (status !== 200 || !Array.isArray(body?.result)) {
				throw new CfApiError(status, `GET ${apiPath}`, cfErrorText(body));
			}
			items.push(...body.result);
			const info = body.result_info;
			const pages = typeof info?.total_pages === "number"
				? info.total_pages
				: undefined;
			if (
				body.result.length < perPage || (pages !== undefined && page >= pages)
			) {
				break;
			}
		}
		return items;
	};
	return { accountId: deps.accountId, request, account, list };
};

// ---------------------------------------------------------------------------
// Account and token resolution
// ---------------------------------------------------------------------------

export type Account = { readonly id: string; readonly name: string };

export type Auth = {
	readonly account: Account;
	/** null when no API token could be obtained: checks degrade to warnings. */
	readonly token: string | null;
	readonly tokenSource: "CLOUDFLARE_API_TOKEN" | "wrangler" | "none";
	readonly email?: string;
};

export class PreflightError extends Error {
	override name = "PreflightError";
}

type Whoami = {
	readonly loggedIn: boolean;
	readonly email?: string;
	readonly accounts: readonly Account[];
};

export const parseWhoami = (text: string): Whoami => {
	const value = parseJsonOutput(text) as {
		loggedIn?: unknown;
		email?: unknown;
		accounts?: unknown;
	};
	const accounts = Array.isArray(value.accounts)
		? value.accounts.flatMap((a: { id?: unknown; name?: unknown }) =>
			typeof a?.id === "string"
				? [{ id: a.id, name: typeof a.name === "string" ? a.name : a.id }]
				: []
		)
		: [];
	return {
		loggedIn: value.loggedIn === true,
		email: typeof value.email === "string" ? value.email : undefined,
		accounts,
	};
};

/** `--account` (id or name), else `CLOUDFLARE_ACCOUNT_ID`, else the only one. */
export const pickAccount = (
	accounts: readonly Account[],
	wanted: string | undefined,
): Account => {
	if (wanted !== undefined) {
		const found = accounts.find((a) => a.id === wanted || a.name === wanted);
		if (found) return found;
		throw new PreflightError(
			`account ${JSON.stringify(wanted)} is not one of this login's accounts: ${
				accounts.map((a) => `${a.name} (${a.id})`).join(", ") || "none"
			}`,
		);
	}
	if (accounts.length === 1) return accounts[0];
	if (accounts.length === 0) {
		throw new PreflightError(
			"this login has no Cloudflare account; check `npx wrangler whoami`",
		);
	}
	throw new PreflightError(
		`this login has ${accounts.length} accounts; pick one with --account <id> or CLOUDFLARE_ACCOUNT_ID: ${
			accounts.map((a) => `${a.name} (${a.id})`).join(", ")
		}`,
	);
};

export const resolveAuth = async (deps: {
	readonly run: Run;
	readonly env: (name: string) => string | undefined;
	readonly account?: string;
	/** Runs `npx wrangler login` (interactive) when not logged in. */
	readonly login: boolean;
	readonly log: (line: string) => void;
}): Promise<Auth> => {
	const whoami = async () => {
		const out = await wrangler(deps.run, ["whoami", "--json"]);
		try {
			return parseWhoami(out.stdout);
		} catch {
			return { loggedIn: false, accounts: [] } as Whoami;
		}
	};
	let me = await whoami();
	if (!me.loggedIn && deps.login) {
		deps.log("Not logged in to Cloudflare: running `npx wrangler login`.");
		const login = await wrangler(deps.run, ["login"], { io: "inherit" });
		if (login.code === 0) me = await whoami();
	}
	if (!me.loggedIn) {
		throw new PreflightError(
			"not logged in to Cloudflare: run `npx wrangler login` (or set CLOUDFLARE_API_TOKEN), then retry",
		);
	}
	const account = pickAccount(
		me.accounts,
		deps.account ?? deps.env("CLOUDFLARE_ACCOUNT_ID"),
	);
	const envToken = deps.env("CLOUDFLARE_API_TOKEN");
	if (envToken) {
		return {
			account,
			token: envToken,
			tokenSource: "CLOUDFLARE_API_TOKEN",
			email: me.email,
		};
	}
	const out = await wrangler(deps.run, ["auth", "token", "--json"]);
	let token: string | null = null;
	if (out.code === 0) {
		try {
			const value = parseJsonOutput(out.stdout) as { token?: unknown };
			token = typeof value.token === "string" && value.token !== ""
				? value.token
				: null;
		} catch {
			token = null;
		}
	}
	return {
		account,
		token,
		tokenSource: token === null ? "none" : "wrangler",
		email: me.email,
	};
};

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

export type CheckStatus = "pass" | "warn" | "fail";

export type Check = {
	readonly id: string;
	readonly status: CheckStatus;
	readonly message: string;
	readonly fix?: string;
};

const pass = (id: string, message: string): Check => ({
	id,
	status: "pass",
	message,
});
const warn = (id: string, message: string, fix?: string): Check => ({
	id,
	status: "warn",
	message,
	...(fix ? { fix } : {}),
});
const failed = (id: string, message: string, fix: string): Check => ({
	id,
	status: "fail",
	message,
	fix,
});

export const MIN_NODE_MAJOR = 22;
export const MIN_DENO = [2, 9] as const;
/** The image build needs about 1-2 GB of Docker VM space; ask for 5 GB free. */
export const MIN_FREE_BYTES = 5 * 1024 ** 3;
/** ttl.sh keeps an image at most 24 h; deploy within 23 h of the publish. */
export const RECORD_MAX_AGE_MS = 23 * 60 * 60 * 1000;

export const ARTIFACTS_ACCESS_HINT =
	"Artifacts is not enabled on this account yet: request access to Cloudflare Artifacts (dashboard → Storage & Databases → Artifacts), then retry";

export const checkNode = (versionOutput: string | null): Check => {
	const major = versionOutput === null
		? NaN
		: Number(/^v?(\d+)\./.exec(versionOutput.trim())?.[1]);
	return Number.isFinite(major) && major >= MIN_NODE_MAJOR
		? pass("node", `Node ${versionOutput!.trim()}`)
		: failed(
			"node",
			versionOutput === null
				? "Node.js was not found"
				: `Node ${versionOutput.trim()} is older than ${MIN_NODE_MAJOR}`,
			`install Node ${MIN_NODE_MAJOR}+ (manual step M5)`,
		);
};

export const checkDeno = (version: string): Check => {
	const [major, minor] = version.split(".").map(Number);
	const ok = major > MIN_DENO[0] ||
		(major === MIN_DENO[0] && minor >= MIN_DENO[1]);
	return ok ? pass("deno", `Deno ${version}`) : failed(
		"deno",
		`Deno ${version} is older than ${MIN_DENO.join(".")}`,
		`run \`deno upgrade\` (manual step M5)`,
	);
};

/** Artifacts entitlement from the namespaces GET status (S13). */
export const artifactsCheck = (status: number, detail = ""): Check => {
	if (status === 200) {
		return pass("artifacts", "Artifacts is enabled on this account");
	}
	if (status === 401) {
		return failed(
			"artifacts",
			"the API token was rejected (401) by the Artifacts API",
			"run `npx wrangler login` again (or fix CLOUDFLARE_API_TOKEN), then retry",
		);
	}
	if (status === 403 || status === 404) {
		return failed(
			"artifacts",
			`the Artifacts API answered ${status}${detail ? ` (${detail})` : ""}`,
			ARTIFACTS_ACCESS_HINT,
		);
	}
	return warn(
		"artifacts",
		`could not decide the Artifacts entitlement (HTTP ${status}${
			detail ? `, ${detail}` : ""
		}); the setup wizard re-checks it`,
	);
};

export const subdomainCheck = (response: CfResponse): Check => {
	const subdomain = response.body?.result?.subdomain;
	if (response.status === 200 && typeof subdomain === "string") {
		return pass("workers.dev", `workers.dev subdomain ${subdomain}`);
	}
	return failed(
		"workers.dev",
		`no workers.dev subdomain (HTTP ${response.status})`,
		"open Workers & Pages in the Cloudflare dashboard once to register a workers.dev subdomain, then retry",
	);
};

export const workersPaidCheck = (response: CfResponse): Check => {
	if (response.status !== 200 || !Array.isArray(response.body?.result)) {
		return warn(
			"workers-paid",
			`could not verify Workers Paid with this token (subscriptions: HTTP ${response.status})`,
			"Tartan needs Workers Paid: subscribe in the dashboard if this account is on the Free plan (manual step M1)",
		);
	}
	const plans = response.body.result.map((s: {
		rate_plan?: { id?: unknown; public_name?: unknown };
	}) => `${s.rate_plan?.id ?? ""} ${s.rate_plan?.public_name ?? ""}`);
	return plans.some((p: string) => /workers/i.test(p) && !/free/i.test(p))
		? pass("workers-paid", "Workers Paid subscription found")
		: warn(
			"workers-paid",
			"no Workers Paid subscription was listed",
			"subscribe to Workers Paid (manual step M1); deploys of Durable Objects with containers and Workflows need it",
		);
};

export type ImageRecordState =
	| { readonly valid: true; readonly ref: string; readonly reason: string }
	| { readonly valid: false; readonly reason: string };

/**
 * Whether the recorded `registry` image can be rendered as is: a digest
 * reference, published under 23 h ago, from this commit or from one whose
 * `containers/runner/` tree equals this one's.
 */
export const assessImageRecord = async (
	text: string | null,
	deps: {
		readonly now: number;
		readonly head: string | null;
		/** True when `containers/runner/` differs between `commit` and HEAD. */
		readonly runnerChangedSince: (commit: string) => Promise<boolean>;
	},
): Promise<ImageRecordState> => {
	if (text === null) return { valid: false, reason: "no recorded image" };
	let record: { ref?: unknown; commit?: unknown; builtAt?: unknown };
	try {
		record = JSON.parse(text);
	} catch {
		return { valid: false, reason: "the record is not JSON" };
	}
	let ref: string;
	try {
		ref = validateRegistryRef(String(record.ref ?? ""));
	} catch (error) {
		return { valid: false, reason: (error as Error).message };
	}
	const builtAt = Date.parse(String(record.builtAt ?? ""));
	if (!Number.isFinite(builtAt)) {
		return { valid: false, reason: "the record has no builtAt time" };
	}
	const age = deps.now - builtAt;
	if (age > RECORD_MAX_AGE_MS) {
		return {
			valid: false,
			reason: `published ${
				Math.round(age / 3_600_000)
			} h ago; ttl.sh keeps images at most 24 h`,
		};
	}
	const commit = typeof record.commit === "string" ? record.commit : "";
	if (deps.head !== null && commit !== deps.head) {
		if (!/^[0-9a-f]{40}$/.test(commit)) {
			return { valid: false, reason: "the record names no commit" };
		}
		if (await deps.runnerChangedSince(commit)) {
			return {
				valid: false,
				reason: `containers/runner/ changed since ${commit.slice(0, 12)}`,
			};
		}
	}
	return {
		valid: true,
		ref,
		reason: `${ref.slice(0, 40)}… (${commit.slice(0, 12)})`,
	};
};

/** Whether this deploy builds an image locally (needs Docker and disk). */
export const buildsImageHere = (
	plan: {
		readonly containers: boolean;
		readonly image: "dockerfile" | "registry";
	},
	record: ImageRecordState | null,
): boolean =>
	plan.containers &&
	(plan.image === "dockerfile" || record === null || !record.valid);

export const engineCheck = (
	dockerInfo: RunResult | null,
	image: "dockerfile" | "registry",
): Check => {
	if (dockerInfo !== null && dockerInfo.code === 0) {
		return pass(
			"container-engine",
			`container engine ${dockerInfo.stdout.trim() || "running"}`,
		);
	}
	return failed(
		"container-engine",
		dockerInfo === null
			? "no `docker` command was found"
			: "the container engine is not running (`docker info` failed)",
		image === "dockerfile"
			? "start Docker Desktop, OrbStack or colima (manual step M4), or deploy with --no-containers (no CI) or --image registry with a recorded digest"
			: "start a container engine to publish the runner image (containers/runner/publish.ts), or deploy with --no-containers",
	);
};

export const diskCheck = (freeBytes: number | null): Check => {
	if (freeBytes === null) {
		return warn("disk", "could not read free disk space");
	}
	const gib = (freeBytes / 1024 ** 3).toFixed(1);
	return freeBytes >= MIN_FREE_BYTES ? pass("disk", `${gib} GiB free`) : failed(
		"disk",
		`only ${gib} GiB free; the runner image build needs about 5 GB`,
		"free disk space, or deploy with --no-containers",
	);
};

/** `df -Pk <dir>` → available bytes. */
export const parseDfAvailable = (text: string): number | null => {
	const line = text.trim().split("\n").at(-1);
	const fields = line?.trim().split(/\s+/) ?? [];
	const kib = Number(fields[3]);
	return fields.length >= 4 && Number.isFinite(kib) ? kib * 1024 : null;
};

/** Zone candidates for a hostname, longest first (`a.b.example.com` → …). */
export const zoneCandidates = (host: string): string[] => {
	const labels = host.split(".");
	return labels.slice(0, -1).map((_, i) => labels.slice(i).join(".")).filter(
		(name) => name.includes("."),
	);
};

export type DomainState = {
	readonly zone: { readonly id: string; readonly name: string } | null;
	/** Workers Custom Domains already on this hostname (service = Worker). */
	readonly attachedTo: readonly string[];
	/** DNS records on the hostname, or null when they could not be read. */
	readonly dnsRecords: readonly string[] | null;
};

export const domainChecks = (
	host: string,
	worker: string,
	state: DomainState,
	takeDomain: boolean,
): Check[] => {
	const checks: Check[] = [];
	if (state.zone === null) {
		return [failed(
			"domain-zone",
			`no zone for ${host} in this account`,
			`add the zone to this Cloudflare account first (manual step M8), or deploy without --domain`,
		)];
	}
	checks.push(pass("domain-zone", `zone ${state.zone.name}`));
	const others = state.attachedTo.filter((service) => service !== worker);
	const ours = state.attachedTo.includes(worker);
	if (others.length > 0) {
		checks.push(
			takeDomain
				? warn(
					"domain-takeover",
					`${host} is the Custom Domain of ${
						others.join(", ")
					}; --take-domain moves it to ${worker}`,
				)
				: failed(
					"domain-takeover",
					`${host} is already the Custom Domain of ${others.join(", ")}`,
					`pick another hostname, destroy that stage first, or pass --take-domain to move it to ${worker} on purpose`,
				),
		);
	} else {
		checks.push(
			pass(
				"domain-takeover",
				ours
					? `${host} is already ${worker}'s Custom Domain`
					: `${host} is free`,
			),
		);
	}
	if (state.dnsRecords === null) {
		checks.push(
			warn(
				"domain-dns",
				`could not read DNS records for ${host} with this token; wrangler names a conflicting record if there is one`,
			),
		);
	} else if (state.dnsRecords.length > 0 && !ours && others.length === 0) {
		checks.push(
			failed(
				"domain-dns",
				`${host} already has DNS records (${state.dnsRecords.join(", ")})`,
				`remove those records, or pick a hostname without DNS records`,
			),
		);
	} else {
		checks.push(pass("domain-dns", `no conflicting DNS record on ${host}`));
	}
	return checks;
};

export const readDomainState = async (
	api: CfApi,
	host: string,
): Promise<DomainState> => {
	let zone: DomainState["zone"] = null;
	for (const candidate of zoneCandidates(host)) {
		const { status, body } = await api.request(
			"GET",
			`/zones?name=${
				encodeURIComponent(candidate)
			}&account.id=${api.accountId}`,
		);
		const found = status === 200 && Array.isArray(body?.result)
			? body.result[0]
			: undefined;
		if (found?.id) {
			zone = { id: String(found.id), name: String(found.name) };
			break;
		}
	}
	const domains = await api.account(
		"GET",
		`/workers/domains?hostname=${encodeURIComponent(host)}`,
	);
	const attachedTo =
		domains.status === 200 && Array.isArray(domains.body?.result)
			? domains.body.result
				.filter((d: { hostname?: unknown }) => d.hostname === host)
				.map((d: { service?: unknown }) => String(d.service))
			: [];
	let dnsRecords: string[] | null = null;
	if (zone !== null) {
		const dns = await api.request(
			"GET",
			`/zones/${zone.id}/dns_records?name=${encodeURIComponent(host)}`,
		);
		if (dns.status === 200 && Array.isArray(dns.body?.result)) {
			dnsRecords = dns.body.result.map((r: { type?: unknown }) =>
				String(r.type)
			);
		}
	}
	return { zone, attachedTo, dnsRecords };
};

// ---------------------------------------------------------------------------
// The preflight
// ---------------------------------------------------------------------------

export type PreflightPlan = {
	readonly stage: string;
	readonly domain?: string;
	readonly takeDomain: boolean;
	readonly containers: boolean;
	readonly image: "dockerfile" | "registry";
	readonly imageRecordPath: string;
};

export type PreflightDeps = {
	readonly run: Run;
	readonly fetch: typeof fetch;
	readonly env: (name: string) => string | undefined;
	readonly now: () => number;
	readonly root: string;
	readonly readText: (file: string) => Promise<string | null>;
	readonly denoVersion: string;
	readonly log: (line: string) => void;
	readonly account?: string;
	readonly login: boolean;
};

export type PreflightResult = {
	readonly checks: readonly Check[];
	readonly auth: Auth | null;
	readonly api: CfApi | null;
	readonly record: ImageRecordState | null;
	readonly buildsImage: boolean;
	readonly workersDevSubdomain: string | null;
	readonly ok: boolean;
};

const tryRun = async (
	run: Run,
	cmd: string,
	args: readonly string[],
	cwd?: string,
): Promise<RunResult | null> => {
	try {
		return await run(cmd, args, { cwd });
	} catch {
		return null; // command not found
	}
};

export const runPreflight = async (
	plan: PreflightPlan,
	deps: PreflightDeps,
): Promise<PreflightResult> => {
	const checks: Check[] = [];
	const names = stageNames(plan.stage);

	const node = await tryRun(deps.run, "node", ["--version"]);
	checks.push(checkNode(node?.code === 0 ? node.stdout : null));
	checks.push(checkDeno(deps.denoVersion));
	const wranglerPkg = await deps.readText(
		path.join(deps.root, "node_modules", "wrangler", "package.json"),
	);
	checks.push(
		wranglerPkg === null
			? failed(
				"wrangler",
				"node_modules/wrangler is missing",
				"run `npm ci` in the repository root",
			)
			: pass(
				"wrangler",
				`wrangler ${String(JSON.parse(wranglerPkg).version ?? "?")}`,
			),
	);

	let auth: Auth | null = null;
	try {
		auth = await resolveAuth({
			run: deps.run,
			env: deps.env,
			account: deps.account,
			login: deps.login,
			log: deps.log,
		});
		checks.push(
			pass(
				"login",
				`account ${auth.account.name} (${auth.account.id})${
					auth.email ? ` as ${auth.email}` : ""
				}`,
			),
		);
	} catch (error) {
		checks.push(
			failed(
				"login",
				(error as Error).message,
				"run `npx wrangler login`, then retry",
			),
		);
	}

	let api: CfApi | null = null;
	let workersDevSubdomain: string | null = null;
	if (auth !== null && auth.token === null) {
		checks.push(
			warn(
				"api-token",
				"no API token from `npx wrangler auth token --json`; account checks are skipped",
				"set CLOUDFLARE_API_TOKEN to enable them; the setup wizard re-checks Artifacts",
			),
		);
	}
	if (auth !== null && auth.token !== null) {
		api = createCfApi({
			token: auth.token,
			accountId: auth.account.id,
			fetch: deps.fetch,
		});
		const artifacts = await api.account("GET", "/artifacts/namespaces");
		checks.push(artifactsCheck(artifacts.status, cfErrorText(artifacts.body)));
		const subdomain = await api.account("GET", "/workers/subdomain");
		const sub = subdomainCheck(subdomain);
		checks.push(sub);
		if (sub.status === "pass") {
			workersDevSubdomain = subdomain.body.result.subdomain;
		}
		checks.push(workersPaidCheck(await api.account("GET", "/subscriptions")));
		if (plan.domain !== undefined) {
			checks.push(
				...domainChecks(
					plan.domain,
					names.worker,
					await readDomainState(api, plan.domain),
					plan.takeDomain,
				),
			);
		}
	}

	let record: ImageRecordState | null = null;
	if (plan.containers && plan.image === "registry") {
		const head = await tryRun(
			deps.run,
			"git",
			["rev-parse", "HEAD"],
			deps.root,
		);
		record = await assessImageRecord(
			await deps.readText(plan.imageRecordPath),
			{
				now: deps.now(),
				head: head?.code === 0 ? head.stdout.trim() : null,
				runnerChangedSince: async (commit) => {
					const diff = await tryRun(deps.run, "git", [
						"diff",
						"--quiet",
						commit,
						"HEAD",
						"--",
						"containers/runner",
					], deps.root);
					return diff?.code !== 0;
				},
			},
		);
		checks.push(
			record.valid
				? pass("runner-image", `recorded image ${record.reason}`)
				: warn(
					"runner-image",
					`the recorded runner image cannot be used: ${record.reason}; deploy publishes a new one`,
				),
		);
	}
	const buildsImage = buildsImageHere(plan, record);
	if (buildsImage) {
		const docker = await tryRun(deps.run, "docker", [
			"info",
			"--format",
			"{{.ServerVersion}}",
		]);
		checks.push(engineCheck(docker, plan.image));
		const df = await tryRun(deps.run, "df", ["-Pk", deps.root]);
		checks.push(diskCheck(df?.code === 0 ? parseDfAvailable(df.stdout) : null));
	}

	return {
		checks,
		auth,
		api,
		record,
		buildsImage,
		workersDevSubdomain,
		ok: checks.every((c) => c.status !== "fail"),
	};
};

export const formatChecks = (checks: readonly Check[]): string =>
	checks.map((c) =>
		`  ${c.status.padEnd(4)}  ${c.id.padEnd(16)} ${c.message}${
			c.fix && c.status !== "pass" ? `\n${" ".repeat(24)}→ ${c.fix}` : ""
		}`
	).join("\n");

// ---------------------------------------------------------------------------
// Shared flag parsing (preflight, deploy and destroy accept the same names)
// ---------------------------------------------------------------------------

export class UsageError extends Error {
	override name = "UsageError";
}

export type FlagSpec = Readonly<Record<string, "value" | "bool">>;

/** `--flag value`, `--flag=value` and boolean `--flag`; a leading `--` is dropped. */
export const parseFlags = (
	raw: readonly string[],
	spec: FlagSpec,
): Map<string, string | true> => {
	const args = raw[0] === "--" ? raw.slice(1) : raw;
	const flags = new Map<string, string | true>();
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "-h" || arg === "--help") {
			flags.set("help", true);
			continue;
		}
		const m = /^--([a-z][a-z0-9-]*)(?:=(.*))?$/.exec(arg);
		if (m === null || !(m[1] in spec)) {
			throw new UsageError(`unknown argument ${JSON.stringify(arg)}`);
		}
		const [, name, inline] = m;
		if (spec[name] === "bool") {
			if (inline !== undefined) {
				throw new UsageError(`--${name} takes no value`);
			}
			flags.set(name, true);
			continue;
		}
		const value = inline ?? args[++i];
		if (
			value === undefined || (inline === undefined && value.startsWith("--"))
		) {
			throw new UsageError(`--${name} needs a value`);
		}
		flags.set(name, value);
	}
	return flags;
};

export const PLAN_FLAGS: FlagSpec = {
	stage: "value",
	domain: "value",
	"take-domain": "bool",
	"no-containers": "bool",
	image: "value",
	"image-record": "value",
	account: "value",
};

const str = (flags: Map<string, string | true>, name: string) => {
	const value = flags.get(name);
	return typeof value === "string" ? value : undefined;
};

export const planFromFlags = (
	flags: Map<string, string | true>,
	root: string,
): PreflightPlan => {
	const stage = str(flags, "stage");
	if (stage === undefined) throw new UsageError("--stage is required");
	try {
		validateStage(stage);
		const containers = !flags.has("no-containers");
		const imageFlag = str(flags, "image");
		if (!containers && imageFlag !== undefined) {
			throw new UsageError("--image cannot be combined with --no-containers");
		}
		const image = imageFlag === undefined
			? "dockerfile"
			: parseImageKind(imageFlag);
		const recordFlag = str(flags, "image-record");
		if (recordFlag !== undefined && image !== "registry") {
			throw new UsageError("--image-record needs --image registry");
		}
		const domainFlag = str(flags, "domain");
		const domain = domainFlag === undefined
			? undefined
			: validateDomain(domainFlag);
		if (flags.has("take-domain") && domain === undefined) {
			throw new UsageError("--take-domain needs --domain");
		}
		return {
			stage,
			domain,
			takeDomain: flags.has("take-domain"),
			containers,
			image,
			imageRecordPath: path.resolve(root, recordFlag ?? RUNNER_IMAGE_RECORD),
		};
	} catch (error) {
		if (error instanceof UsageError) throw error;
		throw new UsageError((error as Error).message);
	}
};

export const readTextOrNull = async (file: string): Promise<string | null> => {
	try {
		return await Deno.readTextFile(file);
	} catch (error) {
		if (error instanceof Deno.errors.NotFound) return null;
		throw error;
	}
};

/** The repository root: the parent of this file's directory. */
export const REPO_ROOT = path.dirname(
	path.dirname(new URL(import.meta.url).pathname),
);

export const PREFLIGHT_USAGE =
	`Usage: deno run -A scripts/preflight.ts --stage <stage> [options]

  --stage <stage>        the stage to check (Worker tartan-<stage>)
  --domain <host>        also check the zone, DNS and Custom Domain for <host>
  --take-domain          accept moving <host> from another Worker
  --no-containers        no runner image (no Docker needed)
  --image <variant>      dockerfile (default) | registry
  --image-record <path>  the registry record (default ${RUNNER_IMAGE_RECORD})
  --account <id|name>    pick the Cloudflare account (or CLOUDFLARE_ACCOUNT_ID)`;

const main = async (): Promise<number> => {
	try {
		const flags = parseFlags(Deno.args, PLAN_FLAGS);
		if (flags.has("help")) {
			console.log(PREFLIGHT_USAGE);
			return 0;
		}
		const plan = planFromFlags(flags, REPO_ROOT);
		const result = await runPreflight(plan, {
			run: denoRun,
			fetch,
			env: (name) => Deno.env.get(name),
			now: Date.now,
			root: REPO_ROOT,
			readText: readTextOrNull,
			denoVersion: Deno.version.deno,
			log: console.log,
			account: str(flags, "account"),
			login: false,
		});
		console.log(`preflight for stage ${plan.stage}:`);
		console.log(formatChecks(result.checks));
		console.log(result.ok ? "preflight: ok" : "preflight: FAILED");
		return result.ok ? 0 : 1;
	} catch (error) {
		if (error instanceof UsageError) {
			console.error(`preflight: ${error.message}\n\n${PREFLIGHT_USAGE}`);
			return 2;
		}
		throw error;
	}
};

if (import.meta.main) Deno.exit(await main());
