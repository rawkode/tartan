// Effects are planned in the state transaction and delivered afterwards:
// a transient failure is retried (timer or next event) with the same keys;
// a refusal the kernel will never lift is dropped; nothing is lost when a
// handler's state was already applied.

import { denied, unavailable } from "@tartan/contract";
import {
	createRadar,
	equal,
	laneOpened,
	notices,
	ok,
	pushed,
	putLane,
	sha,
} from "./kit.ts";

const API = "services/api/src/middleware/limit.ts";

const twoLanes = async () => {
	const r = createRadar();
	const a = putLane(r.world, { n: 1 });
	const b = putLane(r.world, { n: 2 });
	await r.deliver(laneOpened(a), laneOpened(b));
	await r.deliver(pushed(r.world, a.id, { after: sha(10), paths: [API] }));
	return { r, a, b };
};

Deno.test("a transient notify failure stays in the outbox and the flush timer delivers it", async () => {
	const { r, b } = await twoLanes();
	r.world.notifyErrors.push(unavailable("inbox busy"));
	await r.deliver(pushed(r.world, b.id, { after: sha(20), paths: [API] }));
	equal(notices(r).length, 1, "one of two notices delivered");
	equal(r.q("SELECT kind, attempts FROM outbox"), [{
		kind: "notify",
		attempts: 1,
	}]);
	ok(r.recorder.timers.has("flush"), "the flush timer is set");
	await r.timer("flush");
	equal(notices(r).length, 2);
	equal(r.q("SELECT * FROM outbox"), []);
	// The redelivered notice kept its dedupe key (the inbox absorbs a duplicate).
	const keys = notices(r).map((n) => n.notice.dedupeKey);
	equal(new Set(keys).size, 2);
});

Deno.test("a refused notice is dropped (logged), never retried", async () => {
	const { r, b } = await twoLanes();
	r.world.notifyErrors.push(denied("scope", "recipient has no role"));
	await r.deliver(pushed(r.world, b.id, { after: sha(20), paths: [API] }));
	equal(r.q("SELECT * FROM outbox"), []);
	ok(
		r.logs.some((l) => l.level === "warn" && l.msg.includes("dropped notify")),
	);
});

Deno.test("a retried event delivers what an earlier run left behind", async () => {
	const { r, b } = await twoLanes();
	r.world.notifyErrors.push(unavailable("x"), unavailable("y"));
	const ev = pushed(r.world, b.id, { after: sha(20), paths: [API] });
	await r.deliver(ev);
	equal(notices(r).length, 0);
	// The host redelivers the same event (e.g. after a timeout): the state is
	// already applied, the outbox is flushed anyway.
	await r.deliver(ev);
	equal(notices(r).length, 2);
	equal(r.q("SELECT * FROM outbox"), []);
});

Deno.test("after five failed attempts an entry is dropped", async () => {
	const { r, b } = await twoLanes();
	for (let i = 0; i < 10; i++) r.world.notifyErrors.push(unavailable(`e${i}`));
	await r.deliver(pushed(r.world, b.id, { after: sha(20), paths: [API] }));
	for (let i = 0; i < 4; i++) await r.timer("flush");
	equal(r.q("SELECT * FROM outbox"), []);
	equal(r.logs.filter((l) => l.msg.includes("dropped notify")).length, 2);
});
