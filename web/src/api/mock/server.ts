// In-browser mock of the kernel API over the fixtures (a `fetch` stand-in),
// with just enough state to walk the setup wizard, create agents, install
// extensions and save settings. Loaded only by `VITE_TARTAN_MOCK=1` builds
// and tests; production bundles never include it (dynamic import in main.ts).

import type {
	ActionRequest,
	AgentCreatedResponse,
	AgentCreateRequest,
	AgentDto,
	InstallationDto,
	InstallationInForce,
	InstallRequest,
	LaneDto,
	LaneSelfTestResult,
	LogDeadListResponse,
	LogStatusResponse,
	MeResponse,
	NodeDto,
	PermissionSheet,
	ReplaceProviderRequest,
	ReplaceProviderResponse,
	ReplaceStep,
	RepoLaneSettingsDto,
	SetupStateDto,
	ViewerDto,
} from "@tartan/contract/api.ts";
import type { Envelope } from "@tartan/contract/events.ts";
import { checkSlotCtxHint, slotCtxRefusal } from "@tartan/contract/slot-ctx.ts";
import { isKnownSlot } from "@tartan/contract/slots.ts";
import type { FetchLike } from "../http.ts";
import { EVENTS, LANES, lanesPage } from "./coord.ts";
import { answerLandApi, mockActionResult } from "./land.ts";
import { createRepoConfigMock } from "./repoconfig.ts";
import {
	AGENTS,
	ANONYMOUS_VIEWER,
	BINARY_FILES,
	commitResponse,
	COMMITS,
	DEFAULT_BRANCH,
	FILE_DIFFS,
	FILES,
	FORGE_SETTINGS,
	HEALTH,
	INSTALLATIONS,
	LANE_SETTINGS,
	MOCK_NOW,
	mockUlid,
	NODES,
	OWNER_ID,
	OWNER_VIEWER,
	PACKAGES,
	SETUP_CHECKS,
	SHAS,
	SLOT_DOCS,
	treeEntries,
	viewFor,
} from "./fixtures.ts";

export type MockOptions = {
	/** Start the forge in this setup state (default `done`). */
	readonly setupState?: SetupStateDto["state"];
	/**
	 * Whether the browser holds a setup session (WP2's `__Host-tartan-setup`
	 * cookie). Default: yes for `unlocked` and `idp`, no otherwise.
	 */
	readonly setupSession?: boolean;
	/** True when the deploy set `TARTAN_SETUP_TOKEN` (no claim code is logged). */
	readonly setupTokenDeployed?: boolean;
	readonly signedIn?: boolean;
	/** Replace the sample repo's lanes (e.g. a 1,000-lane swarm). */
	readonly lanes?: readonly LaneDto[];
	/**
	 * Moves the coordination fixtures (lane and event times, fixed at
	 * `MOCK_NOW` for tests) by this much; mock builds pass `Date.now() -
	 * MOCK_NOW` so the Change Graph shows them around the real clock.
	 */
	readonly timeShiftMs?: number;
	/** Artificial latency per request (ms). */
	readonly latencyMs?: number;
};

type MockState = {
	setup: SetupStateDto;
	setupSession: boolean;
	setupTokenDeployed: boolean;
	/** A claim code is in the (mock) logs and unused. */
	codeLogged: boolean;
	viewer: ViewerDto;
	lanes: LaneDto[];
	events: Envelope[];
	agents: AgentDto[];
	installations: InstallationDto[];
	nodes: NodeDto[];
	laneSettings: RepoLaneSettingsDto;
	lastSelfTest: LaneSelfTestResult | null;
	containerChecks: number;
	seq: number;
	/** Installations whose circuit breaker an Owner reset (mock). */
	breakerReset: Set<string>;
};

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

const error = (
	status: number,
	code: string,
	message: string,
	reason?: string,
): Response =>
	json({ error: code, ...(reason ? { reason } : {}), message }, status);

const notFound = (what: string): Response =>
	error(404, "not_found", `${what} not found`);

const readBody = (init?: RequestInit): Record<string, unknown> => {
	if (!init?.body || typeof init.body !== "string") return {};
	try {
		const parsed = JSON.parse(init.body) as unknown;
		return typeof parsed === "object" && parsed !== null
			? parsed as Record<string, unknown>
			: {};
	} catch {
		return {};
	}
};

const decodeCtx = (value: string | null): unknown => {
	if (!value) return {};
	try {
		const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
		const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return null;
	}
};

const shiftLane = (lane: LaneDto, ms: number): LaneDto =>
	ms === 0 ? lane : {
		...lane,
		createdAt: lane.createdAt + ms,
		leaseExpiresAt: lane.leaseExpiresAt + ms,
		...(lane.lastPushAt !== undefined
			? { lastPushAt: lane.lastPushAt + ms }
			: {}),
		...(lane.closedAt !== undefined ? { closedAt: lane.closedAt + ms } : {}),
	};

/** WP2's `MeResponse` for the mock viewer. */
export const meOf = (state: MockState): MeResponse => {
	const p = state.viewer.principal;
	if (!p) return { principal: null };
	return {
		principal: {
			id: p.id,
			kind: p.kind,
			handle: p.handle,
			display: p.display,
			avatar: `/-/avatar/${p.id}`,
		},
		auth: {
			via: "session",
			isAdmin: state.viewer.isAdmin,
			scopes: [],
			nodeId: null,
			laneId: null,
			maxRole: 50,
		},
		forge: {
			...(state.setup.forgeName ? { name: state.setup.forgeName } : {}),
			rootKeyFallback: state.setup.rootKeyFallback,
			devTools: true,
		},
	};
};

export const createMockState = (options: MockOptions = {}): MockState => {
	const phase = options.setupState ?? "done";
	const done = phase === "done";
	return {
		setup: {
			state: phase,
			forgeName: done ? FORGE_SETTINGS.forgeName : undefined,
			canonicalOrigin: done
				? FORGE_SETTINGS.canonicalOrigin ?? undefined
				: undefined,
			rootKeyFallback: true,
		},
		setupSession: options.setupSession ??
			(phase === "unlocked" || phase === "idp"),
		setupTokenDeployed: options.setupTokenDeployed ?? false,
		codeLogged: false,
		viewer: (options.signedIn ?? done) ? OWNER_VIEWER : ANONYMOUS_VIEWER,
		lanes: (options.lanes ?? LANES).map((l) =>
			shiftLane(l, options.timeShiftMs ?? 0)
		),
		events: EVENTS.map((e) => ({
			...e,
			at: e.at + (options.timeShiftMs ?? 0),
		})),
		agents: AGENTS.map((a) => ({
			...a,
			tokens: a.tokens.map((t) => ({ ...t })),
		})),
		installations: [...INSTALLATIONS],
		nodes: [...NODES],
		laneSettings: { ...LANE_SETTINGS },
		lastSelfTest: done
			? { ok: true, seed: "import", seedMs: 2140, at: MOCK_NOW - 3_600_000 }
			: null,
		containerChecks: 0,
		seq: 1000,
		breakerReset: new Set<string>(),
	};
};

const permissionSheet = (request: InstallRequest): PermissionSheet => {
	const pkg = PACKAGES.find((p) => p.extId === request.extId);
	const perms = pkg?.manifest.permissions;
	const lines = [
		perms?.repo === "read"
			? "Read repository content under this node"
			: "No repository access",
		...(perms?.lanes ?? []).map((op) => `Lanes: ${op}`),
		...(perms?.land ?? []).map((ref) => `Land to ${ref}`),
		...(perms?.runs ?? []).map((op) => `CI runs: ${op}`),
		...(perms?.notify ? ["Send notices to people and agents"] : []),
		...(perms?.notes ? ["Write why notes"] : []),
	];
	return {
		lines,
		needsOwner: (request.backgroundRole ?? 20) > 20 || request.locked === true,
		warnings: pkg?.runtime === "wasm"
			? ["Runs a WASM gate; it can veto advances when in enforce mode."]
			: [],
		...(request.extId === "tartan.weave"
			? {
				replaces: {
					iface: "queue@1",
					installation:
						INSTALLATIONS.find((i) => i.extId === "tartan.weave")?.id ?? "",
					ext: "tartan.weave",
					node: "acme",
				},
			}
			: {}),
	};
};

/** A `fetch` that answers kernel API paths from fixtures and mock state. */
export const createMockFetch = (
	options: MockOptions = {},
	state: MockState = createMockState(options),
): FetchLike => {
	const repoConfig = createRepoConfigMock();
	const handle = (input: string, init?: RequestInit): Response => {
		const url = new URL(input, "https://forge.test");
		const path = url.pathname;
		const method = (init?.method ?? "GET").toUpperCase();
		const q = (key: string): string => url.searchParams.get(key) ?? "";
		const signedIn = state.viewer.principal !== undefined;

		// Health and setup.
		if (path === "/-/health") {
			return json({ ...HEALTH, setupState: state.setup.state });
		}
		if (path === "/-/api/me") {
			// Like WP2: the API is gated (503) until the forge is claimed.
			return state.setup.state === "done"
				? json(meOf(state))
				: error(503, "setup_required", "Finish setting up the forge first.");
		}
		if (path === "/-/auth/logout" && method === "POST") {
			state.viewer = ANONYMOUS_VIEWER;
			return json({ ok: true });
		}
		if (path.startsWith("/-/setup/") && method === "POST") {
			const body = readBody(init);
			const needsSession = ![
				"/-/setup/status",
				"/-/setup/code",
				"/-/setup/unlock",
			]
				.includes(path);
			if (needsSession && !state.setupSession) {
				return error(
					401,
					"unauthenticated",
					"a setup session is required: unlock first",
				);
			}
			switch (path) {
				case "/-/setup/status":
					return json({
						...state.setup,
						session: state.setupSession
							? {
								purpose: state.setup.state === "done" ? "recover" : "bootstrap",
								expiresAt: Date.now() + 30 * 60_000,
							}
							: null,
					});
				case "/-/setup/code": {
					const created = !state.setupTokenDeployed &&
						state.setup.state !== "done" && !state.codeLogged;
					if (created) state.codeLogged = true;
					return json({ created });
				}
				case "/-/setup/unlock": {
					const token = typeof body["token"] === "string" ? body["token"] : "";
					if (token.length < 16 || token.includes("bad")) {
						return error(403, "denied", "invalid setup token or code", "setup");
					}
					if (state.setup.state === "done") {
						return error(
							403,
							"denied",
							"setup is complete; recovery needs a new setup token",
							"setup",
						);
					}
					if (state.setup.state === "fresh") {
						state.setup = { ...state.setup, state: "unlocked" };
					}
					state.setupSession = true;
					state.codeLogged = false;
					return json({
						ok: true,
						purpose: "bootstrap",
						expiresAt: Date.now() + 30 * 60_000,
					});
				}
				case "/-/setup/checks": {
					state.containerChecks += 1;
					return json({
						checks: SETUP_CHECKS.map((c) =>
							c.id === "containers" && state.containerChecks < 2
								? {
									...c,
									ok: false,
									message: "The sandbox container is still starting.",
									hint:
										"A new container app can take about a minute on its first start.",
								}
								: c
						),
					});
				}
				case "/-/setup/name":
					state.setup = {
						...state.setup,
						forgeName: String(body["forgeName"] ?? ""),
						canonicalOrigin: String(body["canonicalOrigin"] ?? ""),
					};
					return json(state.setup);
				case "/-/setup/idp/register": {
					const issuer = String(body["issuer"] ?? "");
					if (!issuer.startsWith("https://id.")) {
						return error(
							503,
							"unavailable",
							"This issuer has no registration endpoint; enter a client id instead.",
						);
					}
					state.setup = { ...state.setup, state: "idp" };
					return json({ clientId: "tartan-dev-8f2c" });
				}
				case "/-/setup/idp":
					state.setup = { ...state.setup, state: "idp" };
					return json({ ok: true });
				default:
					return notFound("no such setup step");
			}
		}
		if (path === "/-/auth/login") {
			// The mock "IdP": signing in completes the claim (with a setup session).
			if (state.setup.state !== "done" && !state.setupSession) {
				return error(
					403,
					"denied",
					"unlock setup first: this sign-in needs a setup session",
				);
			}
			if (state.setup.state === "idp") {
				state.setup = { ...state.setup, state: "done" };
				state.setupSession = false;
			}
			state.viewer = OWNER_VIEWER;
			return json({ ok: true });
		}

		if (!path.startsWith("/-/api/")) return notFound(path);
		if (state.setup.state !== "done") {
			return error(503, "setup_required", "Finish setting up the forge first.");
		}

		// Admin.
		if (path === "/-/api/admin/selftest/lanes") {
			if (method === "POST") {
				state.lastSelfTest = {
					ok: true,
					seed: "import",
					seedMs: 1980,
					at: Date.now(),
				};
				return json(state.lastSelfTest);
			}
			return json({ last: state.lastSelfTest });
		}
		if (path === "/-/api/log/status" && method === "GET") {
			const at = Date.now();
			const status: LogStatusResponse = {
				label: "K2 (public beta)",
				health: "ok",
				transport: "k2",
				stream: { configured: true, name: "tartan_dev_log" },
				relay: {
					forge: {
						stream: "forge",
						state: "ok",
						epoch: "e1",
						head: 42,
						relayedSeq: 42,
						lag: 0,
						oldestUnrelayedAt: null,
						attempts: 0,
						nextAt: null,
						lastError: null,
						lastOkAt: at - 4_000,
						sentRecords: 42,
						sentBytes: 21_504,
						unknownOutcomes: 0,
					},
				},
				consumer: {
					group: "workloads",
					worker: 0,
					consume: "ok",
					subscription: "sub_mock",
					lastPollOkAt: at - 2_000,
					lastRecordAt: at - 3_000,
					consumerLagMs: 900,
					records: 128,
					retry: 0,
					dead: 0,
					resubscribed: 0,
					lastError: null,
					via: [],
					relayLags: [],
					relayLagsAt: null,
				},
				lastHour: { k2: 6, backstop: 0, local: 0 },
			};
			return json(status);
		}
		if (path === "/-/api/log/dead" && method === "GET") {
			const dead: LogDeadListResponse = { dead: [] };
			return json(dead);
		}
		if (path === "/-/api/admin/root-key/export" && method === "POST") {
			if (!state.setup.rootKeyFallback) {
				return error(409, "conflict", "The root key is already a secret.");
			}
			return json({
				value: "mock-root-key-0000000000000000000000000000000000000000",
			});
		}
		if (path === "/-/api/settings") {
			return json({
				...FORGE_SETTINGS,
				rootKeyFallback: state.setup.rootKeyFallback,
			});
		}

		// Lanes (WP5a) and the repo event log (WP6).
		if (path === "/-/api/lanes" && method === "GET") {
			const repo = state.nodes.find((n) => n.path === q("repo"));
			if (!repo || repo.kind !== "repo") {
				return notFound(`no repo at ${q("repo")}`);
			}
			return json(lanesPage(
				state.lanes.filter((l) => l.repoId === repo.id),
				{
					state: q("state") || undefined,
					cursor: q("cursor") || undefined,
					limit: q("limit") || undefined,
				},
			));
		}
		const laneGet = /^\/-\/api\/lanes\/(ln_[0-9a-z]{26})$/.exec(path);
		if (laneGet && method === "GET") {
			const found = state.lanes.find((l) => l.id === laneGet[1]);
			return found ? json(found) : notFound("no such lane");
		}
		if (path === "/-/api/events" && method === "GET") {
			const repoId = q("repo");
			if (!state.nodes.some((n) => n.id === repoId && n.kind === "repo")) {
				return notFound("no such repo");
			}
			const since = Number(q("since") || "0");
			const limit = Math.min(500, Math.max(1, Number(q("limit") || "100")));
			const types = q("types") ? q("types").split(",") : null;
			const matches = (type: string): boolean =>
				types === null || types.some((p) =>
					p === "*" || p === type ||
					(p.endsWith(".*") && type.startsWith(p.slice(0, -1)))
				);
			const events = state.events
				.filter((e) => e.repo === repoId && e.seq > since && matches(e.type))
				.slice(0, limit);
			return json({
				repo: repoId,
				events,
				head: state.events.reduce(
					(h, e) => e.repo === repoId ? Math.max(h, e.seq) : h,
					0,
				),
			});
		}

		// Repository config (WP23).
		const configReply = repoConfig.answer({
			path,
			method,
			query: url.searchParams,
			body: readBody(init),
			signedIn,
			role: state.viewer.role,
			principal: state.viewer.principal?.id,
			nodes: state.nodes,
		});
		if (configReply) return configReply;

		// Runs (WP9), advances and why (WP10).
		const landReply = answerLandApi({
			path,
			method,
			query: url.searchParams,
			signedIn,
			nodes: state.nodes,
		});
		if (landReply) return landReply;

		// Nodes.
		if (path === "/-/api/nodes" && method === "GET") {
			const parent = q("parent");
			const parentNode = parent
				? state.nodes.find((n) => n.path === parent)
				: null;
			if (parent && !parentNode) return notFound(`node ${parent}`);
			const children = state.nodes.filter((n) =>
				parentNode ? n.parentId === parentNode.id : n.parentId === null
			);
			const offset = Number(q("cursor") || "0");
			const page = children.slice(offset, offset + 20);
			return json({
				nodes: page,
				...(offset + 20 < children.length
					? { cursor: String(offset + 20) }
					: {}),
			});
		}
		if (
			(path === "/-/api/nodes" || path === "/-/api/nodes/repos") &&
			method === "POST"
		) {
			const body = readBody(init);
			const parentPath = typeof body["parent"] === "string"
				? body["parent"]
				: "";
			const parentNode = state.nodes.find((n) => n.path === parentPath) ?? null;
			const slug = String(body["slug"] ?? "");
			if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
				return error(
					400,
					"invalid",
					"Slugs use lowercase letters, digits and dashes.",
				);
			}
			const fullPath = parentNode ? `${parentNode.path}/${slug}` : slug;
			if (state.nodes.some((n) => n.path === fullPath)) {
				return error(409, "conflict", `${fullPath} already exists.`);
			}
			const created: NodeDto = {
				id: mockUlid(900 + state.nodes.length),
				parentId: parentNode?.id ?? null,
				kind: path.endsWith("/repos") ? "repo" : "group",
				slug,
				path: fullPath,
				depth: fullPath.split("/").length - 1,
				visibility: (body["visibility"] as NodeDto["visibility"]) ?? "private",
				archived: false,
				createdAt: Date.now(),
				...(path.endsWith("/repos") ? { defaultBranch: DEFAULT_BRANCH } : {}),
			};
			state.nodes.push(created);
			return json(created, 201);
		}

		// View and slots.
		if (path === "/-/api/view") {
			const view = viewFor(q("path"), q("view"));
			if (!view) return notFound(`node ${q("path")}`);
			return json({
				...view,
				viewer: state.viewer,
				node: state.nodes.find((n) => n.path === view.node.path) ?? view.node,
			});
		}
		const slot = /^\/-\/api\/slot\/([^/]+)\/([^/]+)(\/action)?$/.exec(path);
		if (slot) {
			const inst = state.installations.find((i) =>
				i.id === decodeURIComponent(slot[1] ?? "")
			);
			if (!inst) return notFound("installation");
			const slotId = decodeURIComponent(slot[2] ?? "");
			// Keys are `<ext>/<catalogue slot>/<contribution id>`; the route
			// carries only the id, unique within a manifest (WP7a).
			const found = Object.entries(SLOT_DOCS).find(([key]) =>
				key.startsWith(`${inst.extId}/`) && key.endsWith(`/${slotId}`)
			);
			const catalogueSlot = found?.[0].split("/")[1] ?? "";
			const body = slot[3] ? readBody(init) as Partial<ActionRequest> : null;
			// The kernel's ctx rule (contract slot-ctx.ts): the strict hint shape,
			// then what this slot takes.
			const hints = body
				? body.ctx ?? {}
				: decodeCtx(url.searchParams.get("ctx"));
			if (hints === null) {
				return error(400, "invalid", "ctx is not base64url JSON");
			}
			const checked = checkSlotCtxHint(hints);
			if (!checked.ok) {
				return json({
					error: "invalid",
					message: "invalid ctx",
					details: { issues: [...checked.issues] },
				}, 400);
			}
			const refusal = isKnownSlot(catalogueSlot)
				? slotCtxRefusal(catalogueSlot, checked.hint)
				: null;
			if (refusal !== null) return error(400, "invalid", refusal);
			if (body) {
				const mirrored = mockActionResult(
					inst.extId,
					body.action,
					checked.hint,
				);
				if (mirrored) return json(mirrored);
				return json({
					v: 1,
					toast: {
						tone: "success",
						text: `${inst.extId}: ${String(body.action)} done`,
					},
					...(body.action === "move" ? { refresh: [slotId] } : {}),
				});
			}
			return json(
				found?.[1] ??
					{
						v: 1,
						root: { t: "error-chip", text: `${inst.extId}: render failed` },
					},
			);
		}

		// Browse.
		const repo = q("repo");
		const knownRepo = state.nodes.some((n) =>
			n.kind === "repo" && n.path === repo
		);
		if (
			[
				"/-/api/tree",
				"/-/api/blob",
				"/-/api/log",
				"/-/api/commit",
				"/-/api/compare",
			].includes(path) && !knownRepo
		) {
			return notFound(`repo ${repo}`);
		}
		if (path === "/-/api/tree") {
			const dir = q("path");
			const entries = treeEntries(dir);
			if (!entries) return notFound(`path ${dir}`);
			return json({
				repo,
				ref: q("ref") || DEFAULT_BRANCH,
				sha: SHAS.c3,
				path: dir,
				entries,
			});
		}
		if (path === "/-/api/blob") {
			const file = q("path");
			const text = FILES[file];
			if (text === undefined) return notFound(`file ${file}`);
			const binary = BINARY_FILES.has(file);
			return json({
				repo,
				ref: q("ref") || DEFAULT_BRANCH,
				sha: SHAS.c3,
				path: file,
				blob: SHAS.c1,
				size: binary ? 18_204 : new TextEncoder().encode(text).length,
				binary,
				...(binary ? {} : { text }),
				truncated: false,
				rawUrl: `/-/raw/${repo}/${q("ref") || DEFAULT_BRANCH}/${file}`,
			});
		}
		if (path === "/-/api/log") {
			return json({ repo, ref: q("ref") || DEFAULT_BRANCH, commits: COMMITS });
		}
		if (path === "/-/api/commit") {
			const found = commitResponse(q("sha"));
			return found ? json(found) : notFound(`commit ${q("sha")}`);
		}
		if (path === "/-/api/compare") {
			return json({
				repo,
				base: q("base"),
				head: q("head"),
				mergeBase: SHAS.c3,
				commits: COMMITS.slice(0, 1),
				files: FILE_DIFFS,
				truncated: false,
			});
		}

		// Lane settings (Owner).
		if (/^\/-\/api\/repos\/[^/]+\/lanes\/settings$/.test(path)) {
			if (method === "PUT") {
				const body = readBody(init);
				state.laneSettings = {
					...state.laneSettings,
					...(body["laneMode"] === null
						? { laneMode: FORGE_SETTINGS.laneMode }
						: typeof body["laneMode"] === "string"
						? { laneMode: body["laneMode"] as RepoLaneSettingsDto["laneMode"] }
						: {}),
					...(typeof body["maxActiveLanes"] === "number"
						? { maxActiveLanes: body["maxActiveLanes"] }
						: {}),
					...(typeof body["atticRetentionDays"] === "number"
						? { atticRetentionDays: body["atticRetentionDays"] }
						: {}),
				};
			}
			return json(state.laneSettings);
		}

		// Agents and tokens.
		if (path === "/-/api/agents" && method === "GET") {
			return json({ agents: state.agents });
		}
		if (path === "/-/api/agents" && method === "POST") {
			const body = readBody(init) as Partial<AgentCreateRequest>;
			const name = String(body.name ?? "");
			if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) {
				return error(
					400,
					"invalid",
					"Agent names use lowercase letters, digits and dashes.",
				);
			}
			const agent: AgentDto = {
				id: `a_${mockUlid(700 + state.agents.length)}`,
				handle: name,
				display: name,
				tool: body.tool,
				model: body.model,
				ownerUserId: OWNER_ID,
				createdAt: Date.now(),
				disabled: false,
				tokens: [{
					id: `t_${mockUlid(800 + state.agents.length)}`,
					nodePath: body.node,
					maxRole: body.maxRole ?? 30,
					expiresAt: Date.now() + (body.ttlDays ?? 7) * 86_400_000,
					revoked: false,
				}],
			};
			state.agents.push(agent);
			const token = "tagt_mock_shown_once_0000000000000000";
			const origin = FORGE_SETTINGS.canonicalOrigin ?? "https://forge.test";
			const created: AgentCreatedResponse = {
				agent,
				token,
				snippets: {
					claudeCode: `claude mcp add --transport http tartan ${origin}/-/mcp/${
						body.node ?? ""
					} --header "Authorization: Bearer ${token}"`,
					codex: `[mcp_servers.tartan]\nurl = "${origin}/-/mcp/${
						body.node ?? ""
					}"\nbearer_token_env_var = "TARTAN_TOKEN"`,
					gitCredential:
						`git config --global credential.${origin}.helper '!f() { echo username=${name}; echo password=$TARTAN_TOKEN; }; f'`,
				},
			};
			return json(created, 201);
		}
		const agentDel = /^\/-\/api\/agents\/([^/]+)$/.exec(path);
		if (agentDel && method === "DELETE") {
			state.agents = state.agents.map((a) =>
				a.id === agentDel[1] ? { ...a, disabled: true } : a
			);
			return json({ ok: true });
		}
		const tokenDel = /^\/-\/api\/tokens\/([^/]+)$/.exec(path);
		if (tokenDel && method === "DELETE") {
			state.agents = state.agents.map((a) => ({
				...a,
				tokens: a.tokens.map((t) =>
					t.id === tokenDel[1] ? { ...t, revoked: true } : t
				),
			}));
			return json({ ok: true });
		}
		if (path === "/-/api/invites" && method === "POST") {
			return json({
				inviteId: `inv_${mockUlid(950)}`,
				url: `${FORGE_SETTINGS.canonicalOrigin}/-/invite/mock-invite-code`,
				expiresAt: Date.now() + 7 * 86_400_000,
			}, 201);
		}

		// Extensions.
		if (path === "/-/api/packages") return json({ packages: PACKAGES });
		if (path === "/-/api/installations" && method === "GET") {
			// WP7a: what is in force at `node`, inherited too; without `node`, at
			// the viewer's start node (here the mock viewer's own root).
			const at = q("node")
				? state.nodes.find((n) => n.path === q("node"))
				: state.nodes.find((n) => n.parentId === null && n.kind === "user");
			if (!at) return error(404, "not_found", `no node at ${q("node")}`);
			const inForce: InstallationInForce[] = state.installations
				.filter((i) =>
					i.mode !== "disabled" &&
					(at.path === i.nodePath || at.path.startsWith(`${i.nodePath}/`))
				)
				.map((i) => ({
					installation: i,
					manifest: (PACKAGES.find((p) => p.extId === i.extId) ?? PACKAGES[0]!)
						.manifest,
					depth: i.nodePath.split("/").length - 1,
				}));
			return json({ node: at, installations: inForce });
		}
		if (path === "/-/api/installations/sheet" && method === "POST") {
			return json(permissionSheet(readBody(init) as InstallRequest));
		}
		if (path === "/-/api/installations/replace" && method === "POST") {
			const body = readBody(init) as ReplaceProviderRequest;
			const at = state.nodes.find((n) => n.path === body.node);
			if (!at) return notFound("node");
			const target = PACKAGES.find((p) =>
				p.extId === body.extId && p.version === body.version
			);
			if (!target) return notFound(`package ${body.extId}@${body.version}`);
			const provides = (extId: string) =>
				(PACKAGES.find((p) => p.extId === extId)?.manifest.provides ?? [])
					.includes(body.iface);
			if (!provides(target.extId)) {
				return error(
					400,
					"invalid",
					`${body.extId} does not provide ${body.iface}`,
				);
			}
			const inForceAt = (list: readonly InstallationDto[]) =>
				list
					.filter((i) =>
						i.mode !== "disabled" && provides(i.extId) &&
						(at.path === i.nodePath || at.path.startsWith(`${i.nodePath}/`))
					)
					.sort((a, b) => b.nodePath.length - a.nodePath.length)[0] ?? null;
			const from = inForceAt(state.installations);
			if (from?.extId === target.extId) {
				return json(
					{
						iface: body.iface,
						node: at.path,
						dryRun: body.dryRun === true,
						from,
						provider: from,
						steps: [],
						lines: permissionSheet({ ...body, mode: "enforce" }).lines,
						needsOwner: ["checks@1", "review@1", "queue@1"].includes(
							body.iface,
						),
					} satisfies ReplaceProviderResponse,
				);
			}
			const steps: ReplaceStep[] = [];
			let after = state.installations;
			if (from !== null && from.nodePath === at.path) {
				steps.push({ kind: "disable", installation: from });
				after = after.map((i) =>
					i.id === from.id ? { ...i, mode: "disabled" as const } : i
				);
			}
			const parked = after.find((i) =>
				i.extId === target.extId && i.nodePath === at.path &&
				i.mode === "disabled"
			);
			const inherited = inForceAt(after);
			let provider: InstallationDto | null;
			if (parked) {
				steps.push({ kind: "enable", installation: parked });
				provider = { ...parked, mode: "enforce" };
				after = after.map((i) => i.id === parked.id ? provider! : i);
			} else if (inherited?.extId === target.extId) {
				steps.push({ kind: "inherit", installation: inherited });
				provider = inherited;
			} else {
				steps.push({
					kind: "install",
					extId: target.extId,
					version: target.version,
					nodeId: at.id,
				});
				provider = body.dryRun === true ? null : {
					id: `i_${mockUlid(600 + state.installations.length)}`,
					extId: target.extId,
					version: target.version,
					nodeId: at.id,
					nodePath: at.path,
					mode: "enforce",
					storageScope: target.manifest.storage.scope,
					config: body.config ?? {},
					grants: target.manifest.permissions,
					backgroundRole: body.backgroundRole ?? 20,
					locked: false,
					backfill: "none",
					installedBy: OWNER_ID,
					installedAt: Date.now(),
				};
				if (provider !== null) after = [...after, provider];
			}
			if (body.dryRun !== true) state.installations = after;
			return json(
				{
					iface: body.iface,
					node: at.path,
					dryRun: body.dryRun === true,
					from,
					provider,
					steps,
					lines: permissionSheet({ ...body, mode: "enforce" }).lines,
					needsOwner: ["checks@1", "review@1", "queue@1"].includes(body.iface),
				} satisfies ReplaceProviderResponse,
			);
		}
		if (path === "/-/api/installations" && method === "POST") {
			const body = readBody(init) as InstallRequest;
			const pkg = PACKAGES.find((p) => p.extId === body.extId);
			if (!pkg) return notFound(`package ${body.extId}`);
			const created: InstallationDto = {
				id: `i_${mockUlid(600 + state.installations.length)}`,
				extId: body.extId,
				version: body.version,
				nodeId: state.nodes.find((n) => n.path === body.node)?.id ??
					mockUlid(11),
				nodePath: body.node,
				mode: body.mode,
				storageScope: pkg.manifest.storage.scope,
				config: body.config ?? {},
				grants: pkg.manifest.permissions,
				backgroundRole: body.backgroundRole ?? 20,
				locked: body.locked ?? false,
				backfill: body.backfill ?? "none",
				installedBy: OWNER_ID,
				installedAt: Date.now(),
			};
			state.installations.push(created);
			return json(created, 201);
		}
		const inst =
			/^\/-\/api\/installations\/([^/]+)(\/mode|\/config|\/repo-overrides|\/promote|\/replay|\/breaker)?$/
				.exec(path);
		if (inst) {
			const found = state.installations.find((i) => i.id === inst[1]);
			if (!found) return notFound("installation");
			if (inst[2] === "/promote" && method === "POST") {
				if (found.mode !== "shadow") {
					return error(
						400,
						"invalid",
						"only a shadow installation can be promoted",
					);
				}
				const promoted = { ...found, mode: "enforce" as const };
				state.installations = state.installations.map((i) =>
					i.id === found.id
						? promoted
						: i.extId === found.extId && i.nodePath === found.nodePath &&
								i.mode === "enforce"
						? { ...i, mode: "disabled" as const }
						: i
				);
				return json(promoted);
			}
			if (inst[2] === "/replay" && method === "POST") {
				const body = readBody(init) as { repo?: string; n?: number };
				const repoNode = state.nodes.find((n) =>
					n.kind === "repo" && n.path === body.repo
				);
				if (
					!repoNode ||
					!(repoNode.path === found.nodePath ||
						repoNode.path.startsWith(`${found.nodePath}/`))
				) {
					return notFound("repo");
				}
				// The demo's seeded history: two of the last 41 carry a fake key.
				const of = Math.min(body.n ?? 50, 41);
				const results = Array.from({ length: of }, (_, i) => {
					const veto = i === 10 || i === 29;
					return {
						advanceId: `adv_${mockUlid(800 + i)}_1`,
						decision: veto ? "veto" as const : "allow" as const,
						message: veto
							? "AWS access key at seeded.env:2 (AKIA…MPLE)"
							: "no secrets found",
					};
				});
				return json({
					replayId: `gr_${mockUlid(900)}`,
					state: "done",
					results,
					summary: {
						vetoed: results.filter((r) => r.decision === "veto").length,
						of: results.length,
					},
				});
			}
			if (inst[2] === "/breaker") {
				const reset = method === "POST";
				if (reset) state.breakerReset.add(found.id);
				return json({
					installation: found.id,
					scope: found.storageScope === "repo"
						? { kind: "repo", repoId: q("repo") ?? "" }
						: { kind: "node" },
					breaker: reset || state.breakerReset.has(found.id)
						? {
							state: "closed",
							until: null,
							trips: 0,
							recentStrikes: 0,
							strikes: [],
						}
						: {
							state: "closed",
							until: null,
							trips: 0,
							recentStrikes: 1,
							strikes: [{
								seq: 1,
								at: MOCK_NOW - 60_000,
								method: "gate ref.advance",
								kind: "timeout",
							}],
						},
				});
			}
			if (inst[2] === "/config" && method === "PUT") {
				const body = readBody(init);
				const updated = {
					...found,
					config: body["config"] ?? {},
				} as InstallationDto;
				state.installations = state.installations.map((i) =>
					i.id === found.id ? updated : i
				);
				return json(updated);
			}
			if (inst[2] === "/repo-overrides" && method === "PUT") {
				const on = readBody(init)["on"];
				if (typeof on !== "boolean") {
					return error(
						400,
						"invalid",
						"repo-overrides request (it names {on})",
					);
				}
				const updated = { ...found, repoOverrides: on } as InstallationDto;
				state.installations = state.installations.map((i) =>
					i.id === found.id ? updated : i
				);
				return json(updated);
			}
			if (inst[2] === "/mode" && method === "PUT") {
				const body = readBody(init);
				const mode = body["mode"];
				if (mode !== "enforce" && mode !== "shadow" && mode !== "disabled") {
					return error(400, "invalid", "Unknown mode.");
				}
				const updated = {
					...found,
					mode,
					modeChangedAt: Date.now(),
				} as InstallationDto;
				state.installations = state.installations.map((i) =>
					i.id === found.id ? updated : i
				);
				return json(updated);
			}
			return json(found);
		}

		if (!signedIn) return error(401, "unauthenticated", "Sign in first.");
		return notFound(path);
	};

	return async (input, init) => {
		if (options.latencyMs) {
			await new Promise((resolve) => setTimeout(resolve, options.latencyMs));
		}
		return handle(input, init);
	};
};
