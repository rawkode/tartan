// `deno task e2e -- agent`: one agent credential for work after a run (a
// manual check, a model-driven session against the dev-e2e forge), minted
// by `e2e-developer`'s own session and written, with the MCP URL of a pack
// group (`e2e/swarm` by default: the e2e group itself carries no pack, so
// its scope serves no work or lanes tool), to a 0600 file in a 0700
// directory under `.private/` or outside the checkout. The token is never
// printed: the launcher logs only the file's path, the agent's id and its
// expiry. The agent is named `e2e-<runId>-handoff`, so the janitor of a
// later run disables it once it is a day old; its own expiry is `ttlDays`.
// If the file cannot be written, the agent is disabled before the error.

import * as path from "node:path";
import type { Caller, ForgeApi } from "./forge-api.ts";
import { makeRunId, PACK_AT } from "./provision.ts";

/** The node the agent is limited to (the e2e baseline group). */
export const HANDOFF_NODE = "e2e";
export const HANDOFF_SCOPES = ["repo:read", "repo:write", "lanes", "mcp"];
/** Developer (the persona's own role on `e2e`). */
export const HANDOFF_MAX_ROLE = 30;
export const HANDOFF_FILE = "agent.json";
/** The pack groups whose MCP scope serves the pack's tools. */
export const HANDOFF_GROUPS = Object.keys(PACK_AT) as readonly string[];
/** The Swarm pack group: work, changes, lanes, radar and the Weave. */
export const HANDOFF_GROUP = "e2e/swarm";

export type Handoff = {
	readonly version: 1;
	readonly origin: string;
	/** `<origin>/-/mcp/<group>`: a pack group's scope, below the agent's node. */
	readonly mcpUrl: string;
	/** The pack group the MCP URL names. */
	readonly group: string;
	readonly node: string;
	readonly agentId: string;
	readonly handle: string;
	readonly ownerUserId: string;
	readonly scopes: readonly string[];
	readonly maxRole: number;
	readonly createdAt: string;
	readonly expiresAt: string;
	/** Shown once by the forge; the only copy is this file. */
	readonly token: string;
};

export type HandoffDeps = {
	readonly api: Pick<ForgeApi, "origin" | "createAgent" | "disableAgent">;
	/** A session cookie of `e2e-developer` (signed in headless). */
	readonly signIn: () => Promise<string>;
	readonly signOut: (session: string) => Promise<boolean>;
	readonly now: () => number;
	readonly random: (n: number) => Uint8Array;
};

const DAY = 86_400_000;

export const handoffPath = (root: string): string =>
	path.join(root, ".private", "e2e", "agent", HANDOFF_FILE);

/**
 * Where the handoff file may go: inside the checkout only under `.private/`
 * (gitignored), anywhere outside it. The file's directory must not exist
 * (it is created 0700) or must be 0700 already; nothing is chmod-ed. Null
 * when the path is allowed, else the reason.
 */
export const handoffOutRefusal = (
	root: string,
	file: string,
	dirMode: number | null,
): string | null => {
	const rel = path.relative(path.resolve(root), path.resolve(file));
	const inside = rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
	if (inside && rel.split(path.sep)[0] !== ".private") {
		return `--out inside the checkout must be under .private/ (gitignored), not ${rel}`;
	}
	if (rel === "" || path.basename(file) === "") {
		return "--out names a file";
	}
	if (dirMode !== null && (dirMode & 0o077) !== 0) {
		return `${
			path.dirname(file)
		} is readable by others: use a new directory or a 0700 one`;
	}
	return null;
};

/**
 * Mints the agent and hands it to `persist` (the 0600 file); if `persist`
 * fails the agent is disabled. The persona's session is signed out
 * whatever happens.
 */
export const mintHandoff = async (
	deps: HandoffDeps,
	input: {
		readonly ttlDays: number;
		readonly group?: string;
		readonly persist: (h: Handoff) => Promise<void>;
	},
): Promise<Handoff> => {
	if (!Number.isInteger(input.ttlDays) || input.ttlDays < 1) {
		throw new Error("ttlDays is a whole number of days, at least 1");
	}
	const group = input.group ?? HANDOFF_GROUP;
	if (!HANDOFF_GROUPS.includes(group)) {
		throw new Error(
			`the MCP group is a pack group (${
				HANDOFF_GROUPS.join(", ")
			}), not ${group}`,
		);
	}
	const cookie = await deps.signIn();
	const caller: Caller = { kind: "session", cookie };
	try {
		const now = deps.now();
		const handle = `e2e-${makeRunId(now, deps.random(2))}-handoff`;
		const created = await deps.api.createAgent(caller, {
			name: handle,
			tool: "other",
			node: HANDOFF_NODE,
			maxRole: HANDOFF_MAX_ROLE,
			ttlDays: input.ttlDays,
			scopes: HANDOFF_SCOPES,
		});
		if (typeof created.token !== "string" || created.token === "") {
			await deps.api.disableAgent(caller, created.agent.id).catch(() => {});
			throw new Error("the forge returned no agent token");
		}
		const handoff: Handoff = {
			version: 1,
			origin: deps.api.origin,
			mcpUrl: `${deps.api.origin}/-/mcp/${group}`,
			group,
			node: HANDOFF_NODE,
			agentId: created.agent.id,
			handle,
			ownerUserId: created.agent.ownerUserId,
			scopes: [...HANDOFF_SCOPES],
			maxRole: HANDOFF_MAX_ROLE,
			createdAt: new Date(now).toISOString(),
			expiresAt: new Date(now + input.ttlDays * DAY).toISOString(),
			token: created.token,
		};
		try {
			await input.persist(handoff);
		} catch (error) {
			await deps.api.disableAgent(caller, created.agent.id).catch(() => {});
			throw error;
		}
		return handoff;
	} finally {
		await deps.signOut(cookie).catch(() => false);
	}
};

/** The file's text: JSON, with the token last so a partial read shows the rest. */
export const handoffText = (h: Handoff): string =>
	`${JSON.stringify(h, null, "\t")}\n`;
