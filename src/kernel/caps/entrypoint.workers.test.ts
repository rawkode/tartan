/// <reference types="@cloudflare/vitest-pool-workers/types" />
// The KernelCaps entrypoint in workerd:
// capabilities are minted per call as `ctx.exports.KernelCaps({ props })`, so
// two stubs minted on the same isolate act with their own props (actor,
// grants, read-only), and the props are not readable through the stub.
// Namespace methods pipeline (`caps.clock().now()`), and `capsOverStub` gives
// back the contract's `KernelCaps` shape. Behind the policy checks the real
// ports call the M0 stubs of other WPs, which answer `not_implemented`: that
// proves the call got past caps.

import { exports } from "cloudflare:workers";
import { type CapsProps, fromRpcError } from "@tartan/contract";
import { beforeAll, describe, expect, it } from "vitest";
import {
	INSTALLATION_ID,
	installationActor,
	NODES,
	PRINCIPALS,
	userActor,
} from "../exthost/host/testing/fakes.ts";
import {
	CAPS_NAMESPACES,
	capsOverStub,
	type KernelCapsStub,
} from "./entrypoint.ts";

type Mint = (options: { props: CapsProps }) => KernelCapsStub;
const mint: Mint = (options) =>
	(exports as unknown as { KernelCaps: Mint }).KernelCaps(options);

const props = (overrides: Partial<CapsProps> = {}): CapsProps => ({
	inst: INSTALLATION_ID,
	extId: "tartan.hello",
	version: "0.1.0",
	scopeKey: `repo:${NODES.router.id}`,
	node: { id: NODES.acme.id, path: NODES.acme.path },
	repo: NODES.router.id,
	grants: { repo: "none" },
	backgroundRole: 20,
	actor: installationActor(),
	bounds: null,
	depth: 0,
	mode: "enforce",
	readOnly: false,
	...overrides,
});

const code = async (p: Promise<unknown>) => {
	try {
		await p;
		return "ok";
	} catch (error) {
		const e = fromRpcError(error);
		return e.reason ? `${e.code}:${e.reason}` : e.code;
	}
};

describe("KernelCaps entrypoint (workerd)", () => {
	// The first call into the loopback entrypoint loads the Worker's module
	// graph through the pool's module runner. Under the full suite's load
	// that alone passed the 5 s test timeout, so it is paid once here.
	beforeAll(async () => {
		await mint({ props: props() }).clock().now();
	}, 30_000);

	it("pipelines namespace methods; capsOverStub restores the contract shape", async () => {
		const stub = mint({ props: props() });
		expect(typeof await stub.clock().now()).toBe("number");
		const caps = capsOverStub(stub);
		expect(await caps.ids.ulid()).toMatch(/^[0-7][0-9a-hjkmnp-tv-z]{25}$/);
		// A namespace is not a thenable: awaiting it yields the namespace itself.
		const clock = await (caps.clock as unknown as Promise<typeof caps.clock>);
		expect(typeof await clock.now()).toBe("number");
		expect(CAPS_NAMESPACES).toHaveLength(15);
	});

	it("caps minted per call act with their own props on one isolate", async () => {
		const reader = capsOverStub(mint({
			props: props({
				grants: { repo: "read" },
				actor: userActor(PRINCIPALS.dev),
				bounds: { maxRole: 50, scopes: null, nodeId: null, laneId: null },
			}),
		}));
		const stranger = capsOverStub(
			mint({ props: props({ grants: { repo: "none" } }) }),
		);
		const readOnly = capsOverStub(mint({ props: props({ readOnly: true }) }));
		// No grant: refused by caps before any kernel call.
		expect(await code(stranger.repo.info({ id: NODES.router.id }))).toBe(
			"denied:grant",
		);
		// Granted: past caps, into the kernel (WP3's tree: no such node here).
		expect(await code(reader.repo.info({ id: NODES.router.id }))).toBe(
			"not_found",
		);
		expect(await code(readOnly.events.emit("x.tartan.hello.a", {}))).toBe(
			"denied:read-only",
		);
		expect(
			await code(
				stranger.lanes.open({
					repo: { id: NODES.router.id },
					owner: PRINCIPALS.dev,
				}),
			),
		).toBe("denied:grant");
		// The same stub answers the same way on the next call: no state leaks between mints.
		expect(await code(stranger.repo.info({ id: NODES.router.id }))).toBe(
			"denied:grant",
		);
	});

	it("the props never reach the holder of the stub", async () => {
		const stub = mint({ props: props() }) as unknown as Record<string, unknown>;
		const props1 = await Promise.resolve(stub.props).catch(() => undefined);
		const ctx = await Promise.resolve(stub.ctx).catch(() => undefined);
		const env = await Promise.resolve(stub.env).catch(() => undefined);
		for (const leaked of [props1, ctx, env]) {
			expect(leaked === undefined || typeof leaked === "function").toBe(true);
		}
	});
});
