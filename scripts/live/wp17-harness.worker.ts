// WP17/WP7b live harness Worker (deployed only as `tartan-dev-wp17` by
// `scripts/live/wp17-wasm.ts --deploy`; never part of the product). It runs
// the REAL ExtensionDO with the REAL production package loader
// (`extensionPackages`: the package read from R2, a Dynamic Worker from the
// Worker Loader, the facet `main` with the synthetic id, the RpcTarget
// capability bridge, the ExtTail sink, the breaker), the REAL publish check
// (`checkBundle`, with the import ⊆ permissions rule) and the REAL gate
// replay (`runGateReplay`). What the product's ForgeDO registry and the
// kernel facades would answer is played by the host fakes
// (`testing/fakes.ts`: the `acme` tree, grants, an event log) and an
// installation record in the DO's own storage, so a claimed forge is not
// needed. The advance history a replay reads is synthetic and labelled so.
//
// Credentials: every request needs `Authorization: Bearer <HARNESS_KEY>`, a
// secret the driver generates and never prints.

import {
	extDoName,
	type InstallationDto,
	type Manifest,
	parseManifest,
	SESSION_BOUNDS,
} from "../../packages/contract/src/index.ts";
import type { Env } from "../../src/env.ts";
import { checkBundle } from "../../src/kernel/exthost/api/packages.ts";
import { runGateReplay } from "../../src/kernel/exthost/api/replay.ts";
import { ExtensionDO as ProductExtensionDO } from "../../src/kernel/exthost/host/do.ts";
import { packagePrefix } from "../../src/kernel/exthost/host/facet/dynamic.ts";
import type {
	InstallationSnapshot,
	InstallationSource,
} from "../../src/kernel/exthost/host/installation.ts";
import {
	createFakeKernel,
	INSTALLATION_ID,
	installationDto,
	NODES,
	PRINCIPALS,
	userActor,
} from "../../src/kernel/exthost/host/testing/fakes.ts";

export { ExtTail } from "../../src/kernel/exthost/host/tail.ts";

type HarnessEnv = Env & { readonly HARNESS_KEY?: string };

type Record_ = {
	readonly manifest: Manifest;
	readonly sha256: string;
	readonly installation: InstallationDto;
	readonly version: number;
};

const RECORD_KEY = "harness:installation";

/** The installation record in the DO's own storage (it survives a reset). */
const storedInstallations = (
	storage: DurableObjectStorage,
): InstallationSource => ({
	version: () =>
		Promise.resolve(
			(storage.kv.get<Record_>(RECORD_KEY))?.version ?? 0,
		),
	load: (id) => {
		const r = storage.kv.get<Record_>(RECORD_KEY);
		if (r === undefined || r.installation.id !== id) {
			return Promise.resolve(null);
		}
		const snapshot: InstallationSnapshot = {
			installation: r.installation,
			manifest: r.manifest,
			sha256: r.sha256,
			extVersion: r.version,
		};
		return Promise.resolve(snapshot);
	},
});

/** The product ExtensionDO, rewired to the fakes; plus the harness's own RPCs. */
export class HarnessExtensionDO extends ProductExtensionDO {
	constructor(ctx: DurableObjectState, env: HarnessEnv) {
		super(ctx, env);
		const kernel = createFakeKernel();
		void ctx.blockConcurrencyWhile(() =>
			ProductExtensionDO.rewire(this, (defaults) => ({
				...defaults,
				kernel: kernel.ports,
				installations: storedInstallations(ctx.storage),
			}))
		);
	}

	/** Sets (or replaces) the installation this host runs. */
	harnessInstall(record: Omit<Record_, "version">): number {
		const storage = this.ctx.storage;
		const version = (storage.kv.get<Record_>(RECORD_KEY)?.version ?? 0) + 1;
		storage.kv.put(RECORD_KEY, { ...record, version });
		return version;
	}

	harnessMode(mode: "enforce" | "shadow" | "disabled"): number {
		const storage = this.ctx.storage;
		const r = storage.kv.get<Record_>(RECORD_KEY);
		if (r === undefined) throw new Error("not installed");
		const version = r.version + 1;
		storage.kv.put(RECORD_KEY, {
			...r,
			installation: { ...r.installation, mode },
			version,
		});
		return version;
	}

	harnessStrikes(): unknown[] {
		return this.ctx.storage.sql.exec(
			"SELECT at, method, kind FROM _strikes ORDER BY seq",
		).toArray();
	}

	harnessBreaker(): unknown[] {
		return this.ctx.storage.sql.exec(
			"SELECT k, v FROM _host WHERE k LIKE 'breaker%'",
		).toArray();
	}
}

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json",
			"cache-control": "no-store",
		},
	});

const constantTimeEqual = (a: string, b: string): boolean => {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
};

type HostStub = DurableObjectStub<HarnessExtensionDO> & {
	gate: ProductExtensionDO["gate"];
};

const hostFor = (env: HarnessEnv, installationId: string): HostStub =>
	env.EXT.getByName(
		extDoName(installationId, { kind: "repo", repoId: NODES.router.id }),
	) as unknown as HostStub;

const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";

export default {
	async fetch(req: Request, env: HarnessEnv): Promise<Response> {
		const url = new URL(req.url);
		const auth = req.headers.get("authorization") ?? "";
		if (
			env.HARNESS_KEY === undefined ||
			!constantTimeEqual(auth, `Bearer ${env.HARNESS_KEY}`)
		) {
			return new Response(null, { status: 404 });
		}
		try {
			const body = req.method === "POST"
				? await req.json() as Record<string, unknown>
				: {};
			if (url.pathname === "/-/harness/publish") {
				// The real publish check, then the package in R2 and the installation.
				const checked = checkBundle({
					manifest: body.manifest,
					files: body.files,
				});
				const m = checked.manifest;
				const prefix = packagePrefix(m.id, m.version, checked.sha256);
				for (const [path, bytes] of checked.files) {
					await env.BLOBS.put(`${prefix}${path}`, bytes);
				}
				const installationId = String(body.installationId ?? INSTALLATION_ID);
				const installation = installationDto(m, {
					id: installationId,
					mode: body.mode === "shadow" ? "shadow" : "enforce",
					config: (body.config ?? {}) as Record<string, unknown>,
				});
				const version = await hostFor(env, installationId).harnessInstall({
					manifest: m,
					sha256: checked.sha256,
					installation,
				});
				return json({
					sha256: checked.sha256,
					installationId,
					version,
					imports: checked.imports ?? null,
				});
			}
			if (url.pathname === "/-/harness/purge") {
				// Teardown: every object this harness wrote (the bucket is its own).
				const deleted: string[] = [];
				let cursor: string | undefined;
				do {
					const page = await env.BLOBS.list({
						prefix: "ext/",
						...(cursor === undefined ? {} : { cursor }),
					});
					const keys = page.objects.map((o) => o.key);
					if (keys.length > 0) await env.BLOBS.delete(keys);
					deleted.push(...keys);
					cursor = page.truncated ? page.cursor : undefined;
				} while (cursor !== undefined);
				return json({ deleted: deleted.length });
			}
			if (url.pathname === "/-/harness/check") {
				// The publish check only (a tampered package must be refused).
				try {
					const checked = checkBundle({
						manifest: body.manifest,
						files: body.files,
					});
					return json({ ok: true, sha256: checked.sha256 });
				} catch (error) {
					const e = error as { message?: string; details?: unknown };
					return json({ ok: false, message: e.message, details: e.details });
				}
			}
			const inst = String(
				body.installationId ?? url.searchParams.get("inst") ?? INSTALLATION_ID,
			);
			const host = hostFor(env, inst);
			const started = Date.now();
			const timed = async (work: Promise<unknown>) => {
				try {
					const value = await work;
					return json({ ok: true, ms: Date.now() - started, value });
				} catch (error) {
					return json({
						ok: false,
						ms: Date.now() - started,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			};
			switch (url.pathname) {
				case "/-/harness/gate":
					return await timed(
						host.gate(
							"ref.advance",
							body.input as never,
							{ node: NODES.router.id, repo: NODES.router.id, mode: "enforce" },
						),
					);
				case "/-/harness/echo":
					return await timed(
						host.echo(body.event as never, body.input as never),
					);
				case "/-/harness/render":
					return await timed(
						host.render(
							String(body.slot),
							body.ctx as never,
							{ actor: userActor(PRINCIPALS.dev), role: 30, kind: "user" },
						),
					);
				case "/-/harness/tool":
					return await timed(
						host.callTool(
							String(body.name),
							body.args ?? {},
							{
								node: NODES.router.id,
								repo: NODES.router.id,
								scope: NODES.router.path,
								actor: userActor(PRINCIPALS.dev),
								mode: "enforce",
							},
							SESSION_BOUNDS,
						),
					);
				case "/-/harness/mode":
					return await timed(
						host.harnessMode(body.mode as "enforce" | "shadow" | "disabled"),
					);
				case "/-/harness/abort":
					return await timed(host.abort(body.reason as "upgrade" | "disabled"));
				case "/-/harness/console":
					return await timed(host.console(0, 200));
				case "/-/harness/strikes":
					return await timed(
						Promise.all([host.harnessStrikes(), host.harnessBreaker()]),
					);
				case "/-/harness/replay": {
					// Synthetic history (labelled): `count` done advances, the
					// `leaky` ones adding an AWS key; the real replay and gate.
					const count = Number(body.count ?? 41);
					const leaky = new Set((body.leaky as number[] | undefined) ?? []);
					const advances = Array.from({ length: count }, (_, i) => ({
						id: `synthetic_${i}`,
						batchId: `lb_01k6${String(i).padStart(22, "0")}`,
						attempt: 0,
						ref: "refs/heads/main",
						expectOld: i.toString(16).padStart(40, "0"),
						newSha: (i + 1).toString(16).padStart(40, "0"),
						ownerInstance: "harness",
						leaseUntil: 0,
						step: "refs-pushed" as const,
						state: "done" as const,
						evidenceReused: false,
						createdAt: i,
					})).reverse();
					const linesOf = (head: string) => {
						const i = parseInt(head, 16) - 1;
						return leaky.has(i)
							? [{
								path: "deploy/prod.env",
								line: 4,
								text: `AWS_ACCESS_KEY_ID=${AWS_KEY}`,
							}]
							: [{
								path: `src/m${i}.ts`,
								line: 1,
								text: "export const ok = true;",
							}];
					};
					const replays = new Map<string, unknown>();
					const out = await runGateReplay({
						land: () => ({
							advances: () => Promise.resolve({ advances }),
							recordReplay: (r) => {
								replays.set(r.id, r);
								return Promise.resolve();
							},
							replay: () => Promise.resolve(null),
						}),
						probe: () => ({
							addedLines: (_s, _b, head) =>
								Promise.resolve({ lines: linesOf(head), truncated: false }),
							diffPaths: (_s, _b, head) =>
								Promise.resolve({
									paths: linesOf(head).map((l) => ({ path: l.path })),
									truncated: false,
								} as never),
						}),
						ext: () => host as never,
					}, {
						installation: {
							...installationDto(parseInstalled(body), { id: inst }),
							mode: "shadow",
						},
						manifest: parseInstalled(body),
						repoId: NODES.router.id,
						n: count,
						replayId: `gr_${
							crypto.randomUUID().replaceAll("-", "").slice(0, 26)
						}`,
					});
					return json({
						ok: true,
						ms: Date.now() - started,
						synthetic: true,
						...out,
					});
				}
			}
			return new Response(null, { status: 404 });
		} catch (error) {
			return json({
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			}, 500);
		}
	},
};

/** The manifest a replay request names (the driver sends the built one). */
const parseInstalled = (body: Record<string, unknown>): Manifest => {
	const parsed = parseManifest(body.manifest);
	if (!parsed.ok) throw new Error(parsed.errors.join("; "));
	return parsed.manifest;
};
