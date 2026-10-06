// Live: one Rust → WASM extension that vetoes an Advance and renders a
// slot.
// `acme.no-secrets` is a third-party package (`id` outside `tartan.*`,
// `runtime: "wasm"`, no permissions) built by `deploy --build-ext`
// (`extensions/acme-no-secrets/dist/publish.json`, never committed).
//
// One flow per instance, in stages shared by the tests (support/shared.ts),
// on a Swarm repo whose review approves small changes on its own:
//
//   1. the forge Owner publishes the package and installs it in SHADOW at
//      the repo; dev tools seed 41 labelled Advances of history;
//   2. the Owner replays the gate over that history on the compare page
//      ("would have vetoed 2 of the last 41") — the replay records nothing;
//   3. in shadow, a change adding an AWS example key still lands, and the
//      gate's veto is recorded as a shadow decision;
//   4. the Owner promotes the installation to enforce on the compare page;
//   5. a lane adding an AWS key: its Advance is vetoed (land.vetoed by
//      acme.no-secrets), the change's sidebar shows the masked finding; a
//      clean change lands through the same gate.
//
// The key is AWS's documented example access key id; findings only ever
// hold a masked form.

import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Browser } from "@e2e-dev/web";
import { type App, expect, type Screen } from "e2e";
import type { Change, LaneHandle } from "@tartan/contract/interfaces.ts";
import type {
	EventsResponse,
	InstallationDto,
	PackagesResponse,
} from "@tartan/contract/api.ts";
import { scriptedAgent } from "../../support/agent.ts";
import { echoOn } from "../../support/gateway.ts";
import { mcpClient } from "../../support/mcp.ts";
import { sharedStore, test } from "../../support/fixtures.ts";
import { ok, pageApi, query, tokenApi } from "../../support/http.ts";
import { extensionDir } from "../../support/labels.ts";
import { PACK_GROUP } from "../../support/names.ts";
import { expectApiClean, watchApi } from "../../support/page.ts";
import { fixtureRepo } from "../../support/repos.ts";
import { keyOf, sharedDirOf } from "../../support/shared.ts";
import { type Stage, tokensOf } from "../../support/stage.ts";

const EXT = "acme.no-secrets";
const MANIFEST = JSON.parse(
	readFileSync(path.join(extensionDir(EXT), "tartan.json"), "utf8"),
) as { readonly version: string; readonly runtime: string };
const PUBLISH_FILE = path.join(extensionDir(EXT), "dist", "publish.json");
/** AWS's documented example access key id (never a real credential). */
const EXAMPLE_KEY = "AKIAIOSFODNN7EXAMPLE";
/** How findings show it: the first and last four characters. */
const MASKED = "AKIA…MPLE";
/** How git prints the extension's echo (band 2, prefixed by the host). */
const ECHO_PREFIX = "remote: [no-secrets]";
/** Pushes of the secret lane that may try for the echo (best-effort). */
const ECHO_TRIES = 3;
/** The history the replay reads (two of them carry the example key). */
const SEEDED = 41;
const SEEDED_VETOES = 2;
const SHADOW: InstallationDto["mode"] = "shadow";
const ENFORCE: InstallationDto["mode"] = "enforce";
const LANDED: Change["state"] = "landed";
const MIN = 60_000;
const SIDEBAR = `section[data-slot="change.sidebar"][data-ext="${EXT}"]`;

type Setup = {
	readonly repo: { readonly path: string; readonly id: string };
	readonly installationId: string;
	/** The mode right after the install (shadow). */
	readonly installedMode: string;
	readonly published: "published" | "already";
	readonly runtime: string;
	readonly seeded: number;
};
type Replay = { readonly vetoed: number; readonly of: number };
type Shadow = {
	readonly changeId: string;
	readonly landed: boolean;
	readonly decision: string | null;
	readonly mode: string | null;
};
type Enforced = {
	readonly secret: {
		readonly changeId: string;
		readonly vetoedBy: string;
		/** The push's `remote: [no-secrets]` lines (with echo on). */
		readonly echo: readonly string[];
		/** Every `remote:` line of the push, any access key id masked. */
		readonly remote: readonly string[];
		/** The pushes it took to see the echo (it is best-effort). */
		readonly pushes: number;
	};
	readonly clean: { readonly changeId: string; readonly decision: string };
};

const skipWithoutPackage = () =>
	test.skip(
		!existsSync(PUBLISH_FILE),
		"the package is not built here: deploy the stage with `stage up --build-ext` (or `deno task build:ext acme-no-secrets`)",
	);

const repoEvents = async (stage: Stage, repoId: string, types: string) =>
	ok(
		"GET",
		"/-/api/events",
		await tokenApi(stage.origin, tokensOf(stage).ownerPat).get<EventsResponse>(
			`/-/api/events?${query({ repo: repoId, types, limit: "500" })}`,
		),
	).events;

/** Agent `name` pushes one lane with `files` and submits it. */
const pushAndSubmit = async (
	stage: Stage,
	repoPath: string,
	name: "A" | "B",
	label: string,
	files: Readonly<Record<string, string>>,
	/** Pushes until one prints the extension's echo (1: push once). */
	echoTries = 1,
): Promise<
	{
		readonly changeId: string;
		readonly pushed: string;
		readonly pushes: number;
	}
> => {
	const agent = scriptedAgent(stage, PACK_GROUP.swarm, name);
	const { lane: first } = await agent.mcp.call<{ lane: LaneHandle }>(
		"lanes_open",
		{ repo: repoPath, purpose: `no-secrets: ${label}` },
	);
	const lane = await agent.awaitOpen(repoPath, first);
	const scratch = path.join(
		sharedDirOf(tmpdir(), stage.runId),
		`scratch-wasm-${label}`,
	);
	const clone = await agent.clone(scratch, `${stage.origin}/${repoPath}.git`);
	await agent.runLane(lane.git.start, clone);
	for (const [file, text] of Object.entries(files)) {
		const target = path.join(clone, ...file.split("/"));
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, text);
	}
	await agent.commit(clone, `no-secrets: ${label}`);
	const pushes: string[] = [];
	for (let attempt = 0; attempt < Math.max(1, echoTries); attempt += 1) {
		if (attempt > 0) {
			// The echo is best-effort within ECHO_LIMITS.totalBudgetMs, its
			// lane-range prefetch included: a cold lane's first diff can use it
			// up. Push one more commit; the lane's range still adds the key.
			await writeFile(
				path.join(clone, `echo-retry-${attempt}.md`),
				`retry ${attempt}\n`,
			);
			await agent.commit(clone, `no-secrets: ${label} (push ${attempt + 1})`);
		}
		const push = await agent.gitResult(clone, [
			"push",
			lane.remote,
			`HEAD:${lane.ref}`,
		]);
		if (push.code !== 0) {
			throw new Error(`the ${label} push failed: ${push.stderr.slice(0, 300)}`);
		}
		pushes.push(push.stderr);
		if (push.stderr.includes(ECHO_PREFIX)) break;
	}
	const { changeId } = await agent.mcp.call<{ changeId: string }>(
		"changes_submit",
		{
			repo: repoPath,
			laneId: lane.id,
			title: `no-secrets ${label} (${stage.runId})`,
			summary: `The ${label} change.`,
		},
	);
	return { changeId, pushed: pushes.join("\n"), pushes: pushes.length };
};

const changeState = async (
	stage: Stage,
	repoPath: string,
	changeId: string,
): Promise<string> =>
	(await scriptedAgent(stage, PACK_GROUP.swarm, "A").mcp.call<Change>(
		"changes_get",
		{ repo: repoPath, changeId },
	)).state;

const SECRET_FILE = (label: string) => ({
	[`config/${label}.ts`]: [
		"// Deployment settings.",
		`export const region = "eu-west-1";`,
		`export const accessKeyId = "${EXAMPLE_KEY}";`,
		"",
	].join("\n"),
});

const flowOf = (stage: Stage, index: number) => {
	const store = sharedStore();
	const key = (s: string) => `wasm-${index}-${s}`;

	const setup = (browser: Browser): Promise<Setup> =>
		store.once(key("setup"), async (): Promise<Setup> => {
			const page = pageApi(browser);
			const body = JSON.parse(readFileSync(PUBLISH_FILE, "utf8"));
			const put = await page.send("PUT", "/-/api/packages", body);
			if (put.status !== 201 && put.status !== 409) {
				throw new Error(
					`publish: HTTP ${put.status} ${put.error?.code ?? ""}`,
				);
			}
			const listed = ok(
				"GET",
				"/-/api/packages/<id>",
				await page.get<PackagesResponse>(`/-/api/packages/${EXT}`),
			).packages.find((p) => p.version === MANIFEST.version);
			if (listed === undefined) throw new Error(`${EXT} is not registered`);
			const repo = await fixtureRepo(
				stage,
				"swarm",
				index === 0 ? "no-secrets" : `no-secrets-${index}`,
			);
			const installed = ok(
				"POST",
				"/-/api/installations",
				await page.send<InstallationDto>("POST", "/-/api/installations", {
					extId: EXT,
					version: MANIFEST.version,
					node: repo.path,
					mode: SHADOW,
				}),
			);
			const seeded = await page.send<{ advances?: unknown[] }>(
				"POST",
				`/-/api/seed-history?${query({ repo: repo.path })}`,
				{ count: SEEDED },
			);
			if (seeded.status >= 300) {
				throw new Error(
					`seed-history: HTTP ${seeded.status} ${seeded.error?.code ?? ""}`,
				);
			}
			return {
				repo: { path: repo.path, id: repo.id },
				installationId: installed.id,
				installedMode: installed.mode,
				published: put.status === 201 ? "published" : "already",
				runtime: listed.runtime,
				seeded: SEEDED,
			};
		});

	/** The Owner replays the shadow gate on the compare page (UI). */
	const replayed = (ui: Ui): Promise<Replay> =>
		store.once(key("replay"), async (): Promise<Replay> => {
			const s = await setup(ui.browser);
			await ui.app.open(`/-/extensions/${s.installationId}/compare`);
			const form = ui.screen.getByRole("form", "Replay");
			await form.getByLabel("Repository").fill(s.repo.path);
			await form.getByLabel("Last advances").fill(String(SEEDED));
			await form.getByRole("button", "Replay").tap();
			const result = ui.screen.getByRole("region", "Replay result");
			await expect(result).toContainText("would have vetoed", {
				timeout: 3 * MIN,
			});
			const text = (await result.textContent()) ?? "";
			const m = /vetoed\s+(\d+)\s+of the last\s+(\d+)/.exec(text);
			if (m === null) throw new Error(`no replay summary in "${text}"`);
			return { vetoed: Number(m[1]), of: Number(m[2]) };
		});

	/** In shadow, a change adding the example key still lands. */
	const shadowLanded = (ui: Ui): Promise<Shadow> =>
		store.once(key("shadow"), async (): Promise<Shadow> => {
			const s = await setup(ui.browser);
			await replayed(ui);
			const { changeId } = await pushAndSubmit(
				stage,
				s.repo.path,
				"B",
				`shadow-${index}`,
				SECRET_FILE(`shadow-${index}`),
			);
			await expect.poll(
				() => changeState(stage, s.repo.path, changeId),
				{
					timeout: 20 * MIN,
					interval: 5_000,
					message: "the shadow-gated change to land",
				},
			).toBe(LANDED);
			const decided = (await repoEvents(stage, s.repo.id, "gate.decided"))
				.map((e) =>
					e.data as {
						ext?: string;
						changeId?: string;
						decision?: string;
						mode?: string;
						replay?: boolean;
					}
				)
				.find((d) =>
					d.ext?.startsWith(EXT) === true && d.changeId === changeId &&
					d.replay !== true
				);
			return {
				changeId,
				landed: true,
				decision: decided?.decision ?? null,
				mode: decided?.mode ?? null,
			};
		});

	/** The Owner promotes the installation to enforce (UI). */
	const promoted = (ui: Ui): Promise<{ mode: string }> =>
		store.once(key("promote"), async () => {
			const s = await setup(ui.browser);
			await shadowLanded(ui);
			await ui.app.open(`/-/extensions/${s.installationId}/compare`);
			const off = await ui.browser.onDialog("accept");
			try {
				await ui.screen.getByRole("button", "Promote to enforce").tap();
				await expect(ui.browser.locator("[data-mode]")).toHaveText(ENFORCE, {
					timeout: 30_000,
				});
			} finally {
				await off();
			}
			const now = ok(
				"GET",
				"/-/api/installations/<id>",
				await pageApi(ui.browser).get<InstallationDto>(
					`/-/api/installations/${s.installationId}`,
				),
			);
			return { mode: now.mode };
		});

	/** Enforced: a secret change is vetoed at its Advance, a clean one lands. */
	const enforced = (ui: Ui): Promise<Enforced> =>
		store.once(key("enforced"), async (): Promise<Enforced> => {
			const s = await setup(ui.browser);
			await promoted(ui);
			const secretPush = await pushAndSubmit(
				stage,
				s.repo.path,
				"A",
				`secret-${index}`,
				SECRET_FILE(`secret-${index}`),
				echoOn(stage.switches) ? ECHO_TRIES : 1,
			);
			const secret = secretPush.changeId;
			const { changeId: clean } = await pushAndSubmit(
				stage,
				s.repo.path,
				"B",
				`clean-${index}`,
				{ [`docs/clean-${index}.md`]: "# Clean\n\nNo credential here.\n" },
			);
			let vetoedBy = "";
			await expect.poll(async () => {
				const vetoes = (await repoEvents(stage, s.repo.id, "land.vetoed"))
					.map((e) => e.data as { changeId?: string; ext?: string });
				vetoedBy = vetoes.find((v) => v.changeId === secret)?.ext ?? "";
				return vetoedBy !== "";
			}, {
				timeout: 20 * MIN,
				interval: 5_000,
				message: "the secret change's Advance to be vetoed",
			}).toBe(true);
			await expect.poll(() => changeState(stage, s.repo.path, clean), {
				timeout: 20 * MIN,
				interval: 5_000,
				message: "the clean change to land",
			}).toBe(LANDED);
			const decided = (await repoEvents(stage, s.repo.id, "gate.decided"))
				.map((e) =>
					e.data as {
						ext?: string;
						changeId?: string;
						decision?: string;
						replay?: boolean;
					}
				)
				.filter((d) =>
					d.ext?.startsWith(EXT) === true && d.changeId === clean &&
					d.replay !== true
				);
			return {
				secret: {
					changeId: secret,
					vetoedBy,
					echo: secretPush.pushed.split(/\r?\n/).filter((l) =>
						l.includes(ECHO_PREFIX)
					),
					remote: secretPush.pushed.split(/\r?\n/).filter((l) =>
						l.startsWith("remote:")
					).map((l) => l.replace(/AKIA[0-9A-Z]{16}/g, "AKIA…")),
					pushes: secretPush.pushes,
				},
				clean: {
					changeId: clean,
					decision: decided.at(-1)?.decision ?? "",
				},
			};
		});

	return { setup, replayed, shadowLanded, promoted, enforced };
};

type Ui = {
	readonly app: App;
	readonly screen: Screen;
	readonly browser: Browser;
};

const flowFor = async (stage: Stage, title: string) =>
	flowOf(stage, await sharedStore().claimIndex(`claim-wasm-${keyOf(title)}`));

const T = {
	installed:
		"acme.no-secrets (Rust → WASM) is published and installed in shadow mode",
	replay:
		"the Owner replays the shadow gate over seeded history on the compare page",
	shadow:
		"in shadow mode a change with an AWS key still lands; the veto is recorded as a shadow decision",
	promote: "the Owner promotes the gate to enforce on the compare page",
	veto:
		"a lane adding an AWS key is vetoed at its Advance and the change's sidebar shows the finding",
	clean: "a clean change lands through the enforced gate",
	scan:
		"the extension's MCP tool is served at the repo it is installed at, not above",
} as const;

test.describe("a Rust → WASM gate: acme.no-secrets", {
	tags: ["wasm", "m2", "gates", "regression", "owner"],
	session: "owner",
}, () => {
	test(T.installed, { tags: ["smoke"], timeout: 10 * MIN }, async ({
		app,
		browser,
		screen,
		stage,
	}) => {
		skipWithoutPackage();
		await app.open("/-/extensions");
		const flow = await flowFor(stage, T.installed);
		const s = await flow.setup(browser);
		expect(s.runtime).toBe("wasm");
		expect(MANIFEST.runtime).toBe("wasm");
		expect(s.installedMode).toBe(SHADOW);
		expect(s.seeded).toBe(SEEDED);
		// UI: the repo's Extensions list names it, in shadow.
		await watchApi(browser);
		await screen.getByLabel("In force at").fill(s.repo.path);
		await screen.getByRole("button", "Show").tap();
		const row = browser.locator("tr").filter({ hasText: EXT });
		await expect(row).toContainText(SHADOW);
		await expectApiClean(browser);
	});

	test(T.replay, { tags: ["ui"], timeout: 15 * MIN }, async ({
		app,
		browser,
		screen,
		stage,
	}) => {
		skipWithoutPackage();
		await app.open("/-/extensions");
		const flow = await flowFor(stage, T.replay);
		const r = await flow.replayed({ app, screen, browser });
		expect(r).toEqual({ vetoed: SEEDED_VETOES, of: SEEDED });
	});

	test(
		T.shadow,
		{ tags: ["containers", "agent", "land"], timeout: 30 * MIN },
		async ({
			app,
			browser,
			screen,
			stage,
		}) => {
			skipWithoutPackage();
			test.skip(!stage.containers, "landing needs CI and the Advance");
			await app.open("/-/extensions");
			const flow = await flowFor(stage, T.shadow);
			const sh = await flow.shadowLanded({ app, screen, browser });
			expect(sh.landed).toBe(true);
			expect(sh.decision, "the shadow gate's decision").toBe("veto");
			expect(sh.mode).toBe(SHADOW);
		},
	);

	test(T.promote, { tags: ["ui"], timeout: 40 * MIN }, async ({
		app,
		browser,
		screen,
		stage,
	}) => {
		skipWithoutPackage();
		test.skip(!stage.containers, "the flow lands changes first");
		await app.open("/-/extensions");
		const flow = await flowFor(stage, T.promote);
		expect((await flow.promoted({ app, screen, browser })).mode).toBe(
			ENFORCE,
		);
	});

	test(T.veto, {
		tags: ["containers", "agent", "land", "ui"],
		timeout: 60 * MIN,
	}, async ({
		app,
		browser,
		screen,
		stage,
	}) => {
		skipWithoutPackage();
		test.skip(!stage.containers, "landing needs CI and the Advance");
		await app.open("/-/extensions");
		const flow = await flowFor(stage, T.veto);
		const e = await flow.enforced({ app, screen, browser });
		expect(e.secret.vetoedBy.startsWith(EXT), "vetoed by acme.no-secrets")
			.toBe(true);
		// With echo on, git printed the extension's finding at push time
		// (band 2), masked, never the key itself.
		if (echoOn(stage.switches)) {
			expect(
				e.secret.echo.join("\n"),
				`${e.secret.pushes} push(es); their remote: lines were:\n${
					e.secret.remote.join("\n")
				}`,
			).toContain(MASKED);
			console.log(
				`no-secrets: the echo arrived on push ${e.secret.pushes} of ${ECHO_TRIES}`,
			);
			expect(e.secret.echo.join("\n")).not.toContain(EXAMPLE_KEY);
		}
		expect(
			await changeState(
				stage,
				(await flow.setup(browser)).repo.path,
				e.secret.changeId,
			),
		).not.toBe(LANDED);
		// UI: the change's sidebar slot shows the masked finding, never the key.
		const s = await flow.setup(browser);
		await app.open(`/${s.repo.path}/-/changes/${e.secret.changeId}`);
		const sidebar = browser.locator(SIDEBAR);
		await expect(sidebar).toContainText(MASKED, { timeout: 30_000 });
		await expect(sidebar).not.toContainText(EXAMPLE_KEY);
	});

	test(
		T.clean,
		{ tags: ["containers", "agent", "land"], timeout: 60 * MIN },
		async ({
			app,
			browser,
			screen,
			stage,
		}) => {
			skipWithoutPackage();
			test.skip(!stage.containers, "landing needs CI and the Advance");
			await app.open("/-/extensions");
			const flow = await flowFor(stage, T.clean);
			const e = await flow.enforced({ app, screen, browser });
			expect(e.clean.decision, "the enforced gate allowed it").toBe("allow");
		},
	);

	test(T.scan, { tags: ["agent", "mcp"], timeout: 10 * MIN }, async ({
		app,
		browser,
		stage,
	}) => {
		skipWithoutPackage();
		await app.open("/-/extensions");
		const flow = await flowFor(stage, T.scan);
		const s = await flow.setup(browser);
		const token = tokensOf(stage).developerAgent;
		// The tool is the installation's: listed at the repo's scope, not at
		// the group's, and it masks what it finds.
		const atRepo = mcpClient(stage.origin, s.repo.path, token);
		const tools = await atRepo.listTools();
		const scan = tools.find((t) => /secrets.*scan/.test(t));
		expect(scan, `a scan tool among ${tools.join(", ")}`).toBeDefined();
		const atGroup = await mcpClient(stage.origin, PACK_GROUP.swarm, token)
			.listTools();
		expect(atGroup).not.toContain(scan);
	});
});
