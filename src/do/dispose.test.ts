// Facade stubs are disposed once a call settles, success or failure,
// and plain fakes (no `Symbol.dispose`) pass through untouched.

import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { disposeRpc, disposingFacade, withRpc } from "./dispose.ts";

type Registry = {
	inForce(nodeId: string): Promise<string[]>;
	fail(): Promise<never>;
	secret(): Promise<string>;
};

/** A stub-like facade that records calls and disposals, as workerd's would. */
const recorder = () => {
	const log: string[] = [];
	let opened = 0;
	const open = (): Registry & Disposable => {
		const n = ++opened;
		return {
			inForce: (nodeId) => {
				log.push(`call ${n} inForce ${nodeId}`);
				return Promise.resolve([nodeId]);
			},
			fail: () => {
				log.push(`call ${n} fail`);
				return Promise.reject(new Error("boom"));
			},
			secret: () => Promise.resolve("never exposed"),
			[Symbol.dispose]: () => {
				log.push(`dispose ${n}`);
			},
		};
	};
	return { log, open };
};

Deno.test("withRpc disposes the facade after the call resolves", async () => {
	const r = recorder();
	deepStrictEqual(await withRpc(r.open, (f) => f.inForce("n_1")), ["n_1"]);
	deepStrictEqual(r.log, ["call 1 inForce n_1", "dispose 1"]);
});

Deno.test("withRpc disposes the facade when the call rejects or throws", async () => {
	const r = recorder();
	await rejects(withRpc(r.open, (f) => f.fail()), /boom/);
	await rejects(
		withRpc(r.open, () => {
			throw new Error("sync");
		}),
		/sync/,
	);
	deepStrictEqual(r.log, ["call 1 fail", "dispose 1", "dispose 2"]);
});

Deno.test("disposingFacade opens one stub per call, disposes it, and exposes only the listed methods", async () => {
	const r = recorder();
	const view = disposingFacade(r.open, ["inForce", "fail"]);
	deepStrictEqual(r.log, [], "building the view opens nothing");
	deepStrictEqual(await view.inForce("n_1"), ["n_1"]);
	deepStrictEqual(await view.inForce("n_2"), ["n_2"]);
	await rejects(view.fail(), /boom/);
	deepStrictEqual(r.log, [
		"call 1 inForce n_1",
		"dispose 1",
		"call 2 inForce n_2",
		"dispose 2",
		"call 3 fail",
		"dispose 3",
	]);
	equal((view as unknown as Record<string, unknown>).secret, undefined);
});

Deno.test("disposeRpc ignores values without a disposer", () => {
	for (const value of [null, undefined, 1, "x", {}, () => 1]) disposeRpc(value);
	let disposed = 0;
	disposeRpc({ [Symbol.dispose]: () => disposed++ });
	equal(disposed, 1);
});
