// Provisioning of the claimed dev-e2e forge before every run (idempotent),
// the janitor, and the run teardown.
//
// Stable baseline (created once, kept): the private groups `e2e`,
// `e2e/swarm` (Swarm pack) and `e2e/classic` (Classic pack), and the
// personas `e2e-developer` (Developer on `e2e`) and `e2e-reporter` (Reporter
// on `e2e`), invited by the owner and redeemed headless. `e2e-outsider` is
// never invited.
//
// Per run (named `e2e-<runId>-…`, 1-day expiry, held in memory only): an
// owner PAT, a reporter PAT (with `repo:write` on purpose: the role ceiling,
// not the scope, must refuse its push), a read-only developer PAT
// (`repo:read`: the scope, not the role, must refuse its push) and two
// developer agent tokens (A and B: two agents for the M1 loop and the lane
// rules), all minted by the persona's own session.
//
// If provisioning fails half-way, everything it minted so far is revoked or
// disabled before the error is raised, so nothing it made outlives a failed
// start for a day.
//
// Teardown, whatever the run's outcome: revoke the run's tokens, disable its
// agents (including the one a UI test made), archive the run's repos and
// groups (a group's children first), and sign the launcher's own sessions
// out.

import {
	type PersonaName,
	usernameOf,
} from "../../tools/mock-idp/src/users.ts";
import type { Caller, ForgeApi } from "./forge-api.ts";
import { SignInError } from "./oidc-client.ts";

export const GROUPS = ["e2e", "e2e/swarm", "e2e/classic"] as const;
export const PACK_AT: Readonly<Record<string, string>> = {
	"e2e/swarm": "tartan.pack.swarm",
	"e2e/classic": "tartan.pack.classic",
};
export const ROLE = { reporter: 20, developer: 30 } as const;
const DAY = 86_400_000;
/**
 * A run node older than this is archived by the next run's janitor: a run
 * ends within the hour, and every live run repo costs each cron tick of the
 * forge (in-force reads, pokes), so left-over repos of crashed or killed
 * runs must not pile up for a day.
 */
export const RUN_NODE_MAX_AGE_MS = 2 * 3_600_000;

/** `r<yyyymmddhhmm><4 hex>`: sorts by time, unique per launcher run. */
export const makeRunId = (now: number, random: Uint8Array): string => {
	const d = new Date(now);
	const pad = (n: number) => String(n).padStart(2, "0");
	const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${
		pad(d.getUTCDate())
	}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
	const hex = Array.from(
		random.slice(0, 2),
		(b) => b.toString(16).padStart(2, "0"),
	).join("");
	return `r${stamp}${hex}`;
};

export const RUN_ID_RE = /^r\d{12}[0-9a-f]{4}$/;

/** The time a run id was made, or null for anything else. */
export const runIdTime = (name: string): number | null => {
	const m = /(?:^|-)r(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})[0-9a-f]{4}(?:-|$)/
		.exec(name);
	if (m === null) return null;
	const [, y, mo, d, h, mi] = m.map(Number);
	return Date.UTC(y, mo - 1, d, h, mi);
};

export type SignIn = (
	persona: PersonaName,
	invite?: string,
) => Promise<string>;

export type ProvisionDeps = {
	readonly api: ForgeApi;
	readonly signIn: SignIn;
	readonly signOut: (session: string) => Promise<boolean>;
	readonly now: () => number;
	readonly log: (line: string) => void;
	/** Pack id → version, read from extensions/packs/<name>/tartan.json. */
	readonly packVersions: Readonly<Record<string, string>>;
};

export type RunCredentials = {
	readonly runId: string;
	readonly ownerPat: string;
	readonly reporterPat: string;
	/** The developer's `repo:read`-only PAT. */
	readonly readPat: string;
	/** Agent A. */
	readonly developerAgent: string;
	/** Agent B: a second agent of the same developer. */
	readonly developerAgentB: string;
	readonly revoke: {
		readonly tokenIds: readonly string[];
		readonly agentIds: readonly string[];
	};
	/** The owner's (admin) session, kept for teardown, then signed out. */
	readonly ownerSession: string;
};

const session = (cookie: string): Caller => ({ kind: "session", cookie });

const ensureGroups = async (deps: ProvisionDeps, owner: Caller) => {
	for (const path of GROUPS) {
		if (await deps.api.resolve(owner, path) !== null) continue;
		const slash = path.lastIndexOf("/");
		await deps.api.createGroup(owner, {
			...(slash === -1 ? {} : { parent: path.slice(0, slash) }),
			slug: path.slice(slash + 1),
			visibility: "private",
		});
		deps.log(`created group /${path}`);
	}
};

const ensurePacks = async (deps: ProvisionDeps, owner: Caller) => {
	for (const [node, pack] of Object.entries(PACK_AT)) {
		const { installations } = await deps.api.installations(owner, node);
		const present = installations.some((i) =>
			i.installation.nodePath === node &&
			(i.installation.pack === pack || i.installation.extId === pack)
		);
		if (present) continue;
		const version = deps.packVersions[pack];
		if (version === undefined) throw new Error(`no version for ${pack}`);
		await deps.api.install(owner, {
			extId: pack,
			version,
			node,
			mode: "enforce",
		});
		deps.log(`installed ${pack} at /${node}`);
	}
};

/** Signs a persona in; invites and redeems it first when the forge has no account. */
const ensurePersona = async (
	deps: ProvisionDeps,
	owner: Caller,
	persona: "developer" | "reporter",
): Promise<string> => {
	try {
		return await deps.signIn(persona);
	} catch (error) {
		if (!(error instanceof SignInError) || error.failure !== "no-account") {
			throw error;
		}
	}
	const invite = await deps.api.createInvite(owner, {
		node: "e2e",
		role: ROLE[persona],
		note: `e2e persona ${usernameOf(persona)}`,
	});
	const code = new URL(invite.url).pathname.split("/").at(-1) ?? "";
	const cookie = await deps.signIn(persona, code);
	deps.log(`invited and signed in ${usernameOf(persona)}`);
	return cookie;
};

const stale = (name: string, createdAt: number, now: number): boolean => {
	if (!name.startsWith("e2e-")) return false;
	const made = runIdTime(name) ?? createdAt;
	return made + DAY <= now;
};

/** Revokes a persona's own `e2e-*` tokens and agents older than a day. */
const sweepPersona = async (deps: ProvisionDeps, caller: Caller) => {
	const now = deps.now();
	let n = 0;
	for (const t of await deps.api.tokens(caller)) {
		if (t.revokedAt === null && stale(t.name, t.createdAt, now)) {
			await deps.api.revokeToken(caller, t.id);
			n++;
		}
	}
	for (const a of await deps.api.agents(caller)) {
		if (!a.disabled && stale(a.handle, a.createdAt, now)) {
			await deps.api.disableAgent(caller, a.id);
			n++;
		}
	}
	return n;
};

/**
 * Archives a run node: a repo, or a group a suite made (its children first,
 * so nothing under it is left in force). Returns how many nodes it archived.
 */
const archiveTree = async (
	api: Pick<ForgeApi, "children" | "archive">,
	owner: Caller,
	node: { readonly path: string; readonly kind: string },
): Promise<number> => {
	let n = 0;
	if (node.kind === "group") {
		for (const child of await api.children(owner, node.path)) {
			if (!child.archived) n += await archiveTree(api, owner, child);
		}
	}
	await api.archive(owner, node.path);
	return n + 1;
};

/** Archives run repos and groups (`r<…>-*`) older than `RUN_NODE_MAX_AGE_MS` under the pack groups. */
const sweepRepos = async (deps: ProvisionDeps, owner: Caller) => {
	const now = deps.now();
	let n = 0;
	for (const parent of Object.keys(PACK_AT)) {
		for (const node of await deps.api.children(owner, parent)) {
			if (node.archived || (node.kind !== "repo" && node.kind !== "group")) {
				continue;
			}
			const made = runIdTime(node.slug);
			if (made !== null && made + RUN_NODE_MAX_AGE_MS <= now) {
				n += await archiveTree(deps.api, owner, node);
			}
		}
	}
	return n;
};

/** What a provisioning attempt minted so far (ids only), for the cleanup of a failed one. */
type Minted = { readonly tokenIds: string[]; readonly agentIds: string[] };

/** Revokes and disables what a failed provisioning minted (best effort, never throws). */
const undoMinted = async (
	deps: Pick<ProvisionDeps, "api" | "log">,
	owner: Caller,
	minted: Minted,
): Promise<void> => {
	let failed = 0;
	for (const id of minted.tokenIds) {
		await deps.api.revokeToken(owner, id).catch(() => failed++);
	}
	for (const id of minted.agentIds) {
		await deps.api.disableAgent(owner, id).catch(() => failed++);
	}
	const n = minted.tokenIds.length + minted.agentIds.length;
	if (n > 0) {
		deps.log(
			`provisioning failed: revoked or disabled ${
				n - failed
			} of the ${n} credential(s) it had minted${
				failed > 0 ? ` (${failed} left for the janitor)` : ""
			}`,
		);
	}
};

export const provision = async (
	deps: ProvisionDeps,
	runId: string,
): Promise<RunCredentials> => {
	const ownerCookie = await deps.signIn("owner");
	const owner = session(ownerCookie);
	const minted: Minted = { tokenIds: [], agentIds: [] };
	const personas: string[] = [];
	try {
		const me = await deps.api.me(owner);
		if (
			me.principal === null || me.principal.handle !== usernameOf("owner") ||
			!me.auth.isAdmin
		) {
			throw new Error("e2e-owner is not the forge's admin");
		}
		if (!me.forge.devTools) {
			throw new Error(
				"the dev-e2e forge runs without dev tools; redeploy with stage up",
			);
		}
		await ensureGroups(deps, owner);
		await ensurePacks(deps, owner);
		const developerCookie = await ensurePersona(deps, owner, "developer");
		personas.push(developerCookie);
		const reporterCookie = await ensurePersona(deps, owner, "reporter");
		personas.push(reporterCookie);
		const developer = session(developerCookie);
		const reporter = session(reporterCookie);
		const swept = await sweepPersona(deps, owner) +
			await sweepPersona(deps, developer) +
			await sweepPersona(deps, reporter) +
			await sweepRepos(deps, owner);
		if (swept > 0) deps.log(`janitor: ${swept} stale item(s) removed`);

		const pat = async (
			caller: Caller,
			who: string,
			scopes: readonly string[],
		) => {
			const created = await deps.api.createPat(caller, {
				name: `e2e-${runId}-${who}`,
				scopes,
				node: "e2e",
				expiresInDays: 1,
			});
			minted.tokenIds.push(created.tokenId);
			return created.token;
		};
		const agent = async (who: string) => {
			const created = await deps.api.createAgent(developer, {
				name: `e2e-${runId}-${who}`,
				tool: "other",
				node: "e2e",
				maxRole: 30,
				ttlDays: 1,
				scopes: ["repo:read", "repo:write", "lanes", "mcp"],
			});
			minted.agentIds.push(created.agent.id);
			return created.token;
		};
		// `admin`: `import-complete` needs the `grant` permission, which a
		// token holds only with the `admin` scope (PERMISSION_TOKEN_SCOPES).
		const ownerPat = await pat(owner, "owner", [
			"api",
			"repo:read",
			"repo:write",
			"admin",
		]);
		const reporterPat = await pat(reporter, "reporter", [
			"repo:read",
			"repo:write",
		]);
		const readPat = await pat(developer, "dev-read", ["repo:read"]);
		const developerAgent = await agent("dev");
		const developerAgentB = await agent("dev-b");
		deps.log(
			"minted the run's owner, reporter and read-only PATs and agents A and B",
		);
		return {
			runId,
			ownerPat,
			reporterPat,
			readPat,
			developerAgent,
			developerAgentB,
			revoke: {
				tokenIds: [...minted.tokenIds],
				agentIds: [...minted.agentIds],
			},
			ownerSession: ownerCookie,
		};
	} catch (error) {
		await undoMinted(deps, owner, minted);
		await deps.signOut(ownerCookie).catch(() => false);
		throw error;
	} finally {
		for (const cookie of personas) {
			await deps.signOut(cookie).catch(() => false);
		}
	}
};

export type TeardownReport = {
	readonly revoked: number;
	readonly disabled: number;
	readonly archived: number;
	readonly failures: readonly string[];
};

export const teardown = async (
	deps: Pick<ProvisionDeps, "api" | "signOut" | "log">,
	creds: RunCredentials,
	options: { readonly keepData: boolean },
): Promise<TeardownReport> => {
	const owner = session(creds.ownerSession);
	const failures: string[] = [];
	const attempt = async (what: string, work: () => Promise<void>) => {
		try {
			await work();
			return true;
		} catch (error) {
			failures.push(`${what}: ${(error as Error).message}`);
			return false;
		}
	};
	let revoked = 0;
	let disabled = 0;
	let archived = 0;
	for (const id of creds.revoke.tokenIds) {
		if (
			await attempt("revoke a run token", () => deps.api.revokeToken(owner, id))
		) {
			revoked++;
		}
	}
	const agentIds = new Set(creds.revoke.agentIds);
	await attempt("list the owner's agents", async () => {
		for (const a of await deps.api.agents(owner)) {
			if (a.handle.startsWith(`e2e-${creds.runId}`) && !a.disabled) {
				agentIds.add(a.id);
			}
		}
	});
	for (const id of agentIds) {
		if (
			await attempt(
				"disable a run agent",
				() => deps.api.disableAgent(owner, id),
			)
		) {
			disabled++;
		}
	}
	if (!options.keepData) {
		await attempt("archive the run's repos", async () => {
			for (const parent of Object.keys(PACK_AT)) {
				for (const node of await deps.api.children(owner, parent)) {
					if (
						(node.kind === "repo" || node.kind === "group") &&
						!node.archived && node.slug.startsWith(`${creds.runId}-`)
					) {
						archived += await archiveTree(deps.api, owner, node);
					}
				}
			}
		});
	}
	if (!(await deps.signOut(creds.ownerSession))) {
		failures.push("sign the owner's launcher session out");
	}
	deps.log(
		`teardown: ${revoked} token(s) revoked, ${disabled} agent(s) disabled, ${archived} repo(s) archived${
			failures.length > 0 ? `, ${failures.length} failure(s)` : ""
		}`,
	);
	return { revoked, disabled, archived, failures };
};
