// reconcileLane + planEffects directly: notice dedupe per severity (one
// announcement per severity a conflict reaches, again on escalation, never
// on de-escalation), escalation events, and key canonicalization.

import { db, json } from "@tartan/ext-api";
import { CONFLICTS_EVENTS } from "@tartan/contract";
import type { Finding } from "../src/analyze.ts";
import { planEffects, reconcileLane, type Run } from "../src/reconcile.ts";
import { getLane } from "../src/store.ts";
import { createRadar, equal, laneOpened, ok, putLane, REPO } from "./kit.ts";

const PATH = "services/api/a.ts";

Deno.test("dedupe per severity: announce once per severity reached; escalation re-announces", async () => {
	const r = createRadar();
	const a = putLane(r.world, { n: 2 });
	const b = putLane(r.world, { n: 1 });
	await r.deliver(laneOpened(a), laneOpened(b));
	const d = db(r.ctx().sql);
	let n = 0;
	const run: Run = {
		d,
		now: 1,
		ulid: () => `01k6${String(++n).padStart(22, "0")}`,
		repoId: REPO,
		env: { origin: null, trunk: "main", repoPath: "acme/platform/router" },
	};
	const apply = (severity: Finding["severity"]) =>
		d.tx(() => {
			const lane = getLane(d, a.id)!;
			const changes = reconcileLane(run, lane, [{
				other: b.id,
				path: PATH,
				project: "api",
				severity,
				detail: {},
			}], { scope: "all", avoidable: true });
			planEffects(run, lane, changes);
			return changes.map((c) => [c.kind, c.announce]);
		});
	const notifies = () =>
		r.q<{ body_json: string }>(
			"SELECT body_json FROM outbox WHERE kind = 'notify' ORDER BY id",
		).length;
	const emits = () =>
		r.q<{ body_json: string }>(
			"SELECT body_json FROM outbox WHERE kind = 'emit' ORDER BY id",
		).map((e) =>
			json.decode<{ type: string; data: unknown }>(e.body_json, {
				type: "",
				data: null,
			})
		);

	equal(apply("same_file"), [["detected", true]]);
	equal(notifies(), 2, "both owners");
	equal(apply("same_file"), [["kept", false]]);
	equal(notifies(), 2, "same severity: nothing new");
	equal(apply("textual"), [["escalated", true]]);
	equal(notifies(), 4, "escalation is announced to both again");
	equal(apply("same_file"), [["kept", false]]);
	equal(notifies(), 4, "de-escalation is not announced");
	equal(emits().map((e) => e.type), [
		"conflicts.detected",
		"conflicts.escalated",
	]);
	for (const e of emits()) {
		ok(
			CONFLICTS_EVENTS[e.type as keyof typeof CONFLICTS_EVENTS].safeParse(
				e.data,
			).success,
		);
	}
	// The pair is stored once, smaller lane id first, whichever side reports it.
	equal(
		r.q("SELECT a, b, path FROM conflicts"),
		[{ a: b.id, b: a.id, path: PATH }],
	);
});
