/// <reference types="@cloudflare/vitest-pool-workers/types" />
// Facade disposal in workerd: `withRpc` and `disposingFacade` call the real
// `Symbol.dispose` of the pipelined facade promise (`JsRpcPromise`) a DO
// getter returns, once the call settles, so its stub no longer holds the
// ForgeDO call context open.

import { FORGE_DO_NAME } from "@tartan/contract";
import { describe, expect, it } from "vitest";
import { testEnv as env } from "../../test/env.ts";
import { disposingFacade, withRpc } from "./dispose.ts";

type Registry = { extVersion(): Promise<number> };

/** Opens `forge.registry()` and counts its real disposer's calls. */
const counted = () => {
	const forge = env.FORGE.getByName(FORGE_DO_NAME);
	const disposals: string[] = [];
	let opened = 0;
	const open = (): Registry => {
		const facade = forge.registry() as unknown as Registry & Disposable;
		const n = ++opened;
		const dispose = facade[Symbol.dispose];
		expect(typeof dispose).toBe("function");
		Object.defineProperty(facade, Symbol.dispose, {
			value: () => {
				disposals.push(`facade ${n}`);
				dispose.call(facade);
			},
		});
		return facade;
	};
	return { open, disposals, opened: () => opened };
};

describe("facade stub disposal (workerd)", () => {
	it("withRpc disposes the pipelined facade once the call settles", async () => {
		const c = counted();
		const version = await withRpc(c.open, (registry) => registry.extVersion());
		expect(typeof version).toBe("number");
		expect(c.disposals).toEqual(["facade 1"]);
	});

	it("disposingFacade opens and disposes one facade stub per call", async () => {
		const c = counted();
		const registry = disposingFacade(c.open, ["extVersion"]);
		expect(c.opened()).toBe(0);
		const first = await registry.extVersion();
		expect(await registry.extVersion()).toBe(first);
		expect(c.disposals).toEqual(["facade 1", "facade 2"]);
	});
});
