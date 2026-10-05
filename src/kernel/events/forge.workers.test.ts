/// <reference types="@cloudflare/vitest-pool-workers/types" />
// WP6 in workerd: the ForgeDO `events` module (forge stream and
// audit) on a host with fake `tree` and `registry` modules: idempotent kernel
// appends, stream and schema checks, `appendKernel`, the K12 subtree filter,
// audit redaction and forge-stream pokes to node-scoped installations.

import { runInDurableObject } from "cloudflare:test";
import { createUlid, type Envelope, extDoName } from "@tartan/contract";
import type {
	DoModule,
	ForgeEventsFacade,
	ForgeEventsInternal,
	InstallationInForce,
	RegistryInternal,
	TreeInternal,
} from "@tartan/contract/kernel.ts";
import { describe, expect, it } from "vitest";
import { testEnv as env, uniqueName } from "../../../test/env.ts";
import { createDoHost } from "../../do/host.ts";
import { COMMON_MIGRATIONS } from "../../do/migrations.ts";
import type { Env } from "../../env.ts";
import { createForgeEventsModule, FORGE_SCAN_MAX } from "./forge.ts";

const ulid = createUlid();
const ROOT = ulid();
const INSIDE = ulid();
const OUTSIDE = ulid();
const MEMBER = `u_${ulid()}`;
const STRANGER = `u_${ulid()}`;
const OWNER = `u_${ulid()}`;
const INST = `i_${ulid()}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// INSIDE is below ROOT; OUTSIDE is not.
const parents: Record<string, string | null> = {
	[ROOT]: null,
	[INSIDE]: ROOT,
	[OUTSIDE]: null,
};
const within = (root: string, node: string): boolean => {
	for (let at: string | null = node; at !== null; at = parents[at] ?? null) {
		if (at === root) return true;
	}
	return false;
};

const fakeTree: DoModule<
	object,
	Pick<TreeInternal, "isWithinSync" | "effectiveRoleSync">,
	Env
> = {
	name: "tree",
	range: [200, 299],
	migrations: [],
	create: () => ({
		facade: {},
		internal: {
			isWithinSync: within,
			effectiveRoleSync: (principals) => principals.includes(MEMBER) ? 20 : 0,
		},
	}),
};

const inForce = (node: string): InstallationInForce[] =>
	within(ROOT, node)
		? [{
			installation: {
				id: INST,
				mode: "enforce",
				storageScope: "node",
			},
			manifest: { subscribe: [{ event: "node.*" }] },
			depth: 0,
		} as unknown as InstallationInForce]
		: [];

const fakeRegistry: DoModule<
	object,
	Pick<RegistryInternal, "inForceSync">,
	Env
> = {
	name: "registry",
	range: [300, 399],
	migrations: [],
	create: () => ({ facade: {}, internal: { inForceSync: inForce } }),
};

type Poke = { host: string; stream: string; head: number };

const withForge = async (
	fn: (ctx: {
		facade: ForgeEventsFacade;
		internal: ForgeEventsInternal;
		state: DurableObjectState;
		pokes: Poke[];
	}) => Promise<void>,
): Promise<void> => {
	const stub = env.FORGE.getByName(uniqueName("test-forge-events"));
	await runInDurableObject(stub, async (_instance, state) => {
		const pokes: Poke[] = [];
		const host = createDoHost({
			kind: "test",
			ctx: state,
			env,
			modules: {
				tree: fakeTree,
				registry: fakeRegistry,
				events: createForgeEventsModule({
					poke: () => (h, input) => {
						pokes.push({ host: h, ...input });
						return Promise.resolve();
					},
					log: () => {},
				}),
			},
			common: [COMMON_MIGRATIONS.base],
		});
		await host.ready;
		await fn({
			facade: host.facade("events") as unknown as ForgeEventsFacade,
			internal: host.internal("events"),
			state,
			pokes,
		});
	});
};

const nodeCreated = (nodeId: string, n: number) => ({
	type: "node.created",
	actor: { kind: "user" as const, id: OWNER },
	node: nodeId,
	data: { nodeId, kind: "group", path: `acme/g${n}` },
	idemKey: `kernel:node${n}:node.created:0`,
});

describe("forge stream", () => {
	it("appends kernel forge events idempotently inside the caller's transaction", async () => {
		await withForge(async ({ facade, internal, state }) => {
			const input = nodeCreated(INSIDE, 1);
			const a = state.storage.transactionSync(() => internal.appendSync(input));
			const b = state.storage.transactionSync(() => internal.appendSync(input));
			expect(b).toEqual(a);
			expect(await facade.head()).toBe(1);
			const [event] = await facade.read(0, ["*"]);
			expect(event).toMatchObject({
				id: a.id,
				seq: 1,
				stream: "forge",
				type: "node.created",
				source: { kind: "kernel" },
				depth: 0,
				shadow: false,
			});
			// A rolled-back caller transaction leaves no event.
			expect(() =>
				state.storage.transactionSync(() => {
					internal.appendSync(nodeCreated(INSIDE, 2));
					throw new Error("caller failed");
				})
			).toThrow(/caller failed/);
			expect(await facade.head()).toBe(1);
		});
	});

	it("refuses repo-only types, bad payloads and other appendKernel types", async () => {
		await withForge(async ({ facade, internal, state }) => {
			const attempt = (event: Parameters<typeof internal.appendSync>[0]) =>
				state.storage.transactionSync(() => internal.appendSync(event));
			expect(() =>
				attempt({ ...nodeCreated(INSIDE, 3), type: "push.accepted" })
			).toThrow(/not a forge-stream event/);
			expect(() => attempt({ ...nodeCreated(INSIDE, 4), data: { nodeId: 1 } }))
				.toThrow(/invalid node.created data/);
			await expect(
				facade.appendKernel({
					...nodeCreated(INSIDE, 5),
					type: "node.created" as "extension.error",
				}),
			).rejects.toThrow(/extension.error only/);
			const error = await facade.appendKernel({
				type: "extension.error",
				actor: { kind: "system", id: "sys_kernel" },
				node: INSIDE,
				data: { inst: INST, error: "boom", attempts: 5 },
				idemKey: `${INST}:dead:extension.error:0`,
			});
			expect(error.seq).toBe(1);
		});
	});

	it("filters reads by the reader's subtree (K12)", async () => {
		await withForge(async ({ facade, internal, state }) => {
			const append = (event: Parameters<typeof internal.appendSync>[0]) =>
				state.storage.transactionSync(() => internal.appendSync(event));
			append(nodeCreated(INSIDE, 10));
			append(nodeCreated(OUTSIDE, 11));
			for (const [principal, n] of [[MEMBER, 12], [STRANGER, 13]] as const) {
				append({
					type: "principal.created",
					actor: { kind: "system", id: "sys_kernel" },
					node: ROOT,
					data: { principalId: principal, kind: "user", handle: `h${n}` },
					idemKey: `kernel:p${n}:principal.created:0`,
				});
			}
			for (const [repoId, n] of [[INSIDE, 14], [OUTSIDE, 15]] as const) {
				append({
					type: "repo.created",
					actor: { kind: "user", id: OWNER },
					node: repoId,
					data: { repoId, path: `acme/r${n}`, artifactsName: `r-${repoId}` },
					idemKey: `kernel:r${n}:repo.created:0`,
				});
			}
			const all = await facade.read(0, ["*"]);
			expect(all).toHaveLength(6);
			const visible = await facade.read(0, ["*"], { subtreeNodeId: ROOT });
			const summary = visible.map((e: Envelope) =>
				`${e.type}:${
					(e.data as { nodeId?: string; principalId?: string; repoId?: string })
						.nodeId ??
						(e.data as { principalId?: string }).principalId ??
						(e.data as { repoId?: string }).repoId
				}`
			);
			expect(summary).toEqual([
				`node.created:${INSIDE}`,
				`principal.created:${MEMBER}`,
				`repo.created:${INSIDE}`,
			]);
			// The repo event carries its repo; patterns and limits apply after the filter.
			expect(visible[2].repo).toBe(INSIDE);
			expect(
				(await facade.read(0, ["repo.*"], { subtreeNodeId: ROOT, limit: 1 }))
					.map((e: Envelope) => e.seq),
			).toEqual([5]);
		});
	});

	it("readPage reports how far a bounded subtree scan looked", async () => {
		await withForge(async ({ facade, internal, state }) => {
			state.storage.transactionSync(() => {
				for (let i = 0; i <= FORGE_SCAN_MAX; i++) {
					internal.appendSync(nodeCreated(OUTSIDE, 100_000 + i));
				}
				internal.appendSync(nodeCreated(INSIDE, 99_999));
			});
			const head = await facade.head();
			const first = await facade.readPage(0, ["node.*"], {
				subtreeNodeId: ROOT,
			});
			expect(first.events).toEqual([]);
			expect(first.scannedTo).toBe(FORGE_SCAN_MAX);
			const second = await facade.readPage(first.scannedTo, ["node.*"], {
				subtreeNodeId: ROOT,
			});
			expect(second.events.map((e: Envelope) => e.seq)).toEqual([head]);
			expect(second.scannedTo).toBe(head);
			// Unfiltered: a full page stops at its last row, a short one at the head.
			const full = await facade.readPage(0, ["node.*"], { limit: 2 });
			expect(full.scannedTo).toBe(full.events[1].seq);
			expect((await facade.readPage(head - 1, ["node.*"])).scannedTo).toBe(
				head,
			);
		});
	});

	it("pokes node-scoped subscribers in force at the event's node", async () => {
		await withForge(async ({ internal, state, pokes }) => {
			state.storage.transactionSync(() =>
				internal.appendSync(nodeCreated(INSIDE, 20))
			);
			state.storage.transactionSync(() =>
				internal.appendSync(nodeCreated(OUTSIDE, 21))
			);
			await sleep(80);
			expect(pokes).toEqual([
				{
					host: extDoName(INST, { kind: "node" }),
					stream: "forge",
					head: 2,
				},
			]);
		});
	});
});

describe("audit", () => {
	it("records entries, redacts secrets and pages by seq", async () => {
		await withForge(async ({ facade }) => {
			await facade.audit({
				principal: OWNER,
				action: "token.create",
				target: "art_v2_x_0123456789abcdef0123456789abcdef01234567?expires=1",
				data: { leaked: "art_v2_x_0123456789abcdef0123456789abcdef01234567" },
			});
			await facade.audit({
				principal: MEMBER,
				viaInstallation: INST,
				action: "install",
			});
			const rows = await facade.auditLog(0, 10);
			expect(rows.map((r) => [r.seq, r.action, r.via_installation])).toEqual([
				[1, "token.create", null],
				[2, "install", INST],
			]);
			expect(rows[0].target).not.toContain("0123456789abcdef");
			expect(rows[0].data_json).not.toContain("0123456789abcdef");
			expect((await facade.auditLog(1, 10)).map((r) => r.seq)).toEqual([2]);
			await expect(facade.audit({ principal: "", action: "x" })).rejects
				.toThrow(/invalid audit entry/);
		});
	});
});
