// The coordination fixtures are real contract values: every lane parses
// with `LaneSchema` (backend invariants included) and every event with the
// contract's `parseEvent` (envelope + kernel or interface payload schema).

import { describe, expect, it } from "vitest";
import { parseEvent } from "@tartan/contract/events.ts";
import { LaneSchema } from "@tartan/contract/lanes.ts";
import { EVENTS, LANES, livePush, swarmLanes } from "../src/api/mock/coord.ts";

describe("coordination fixtures", () => {
	it("every lane is a valid LaneDto", () => {
		for (const lane of [...LANES, ...swarmLanes(3)]) {
			const parsed = LaneSchema.safeParse(lane);
			expect(parsed.success, `${lane.id}: ${parsed.error?.message}`).toBe(
				true,
			);
		}
	});

	it("covers both backends, an opening lane and an adopted branch", () => {
		expect(new Set(LANES.map((l) => l.mode))).toEqual(
			new Set(["repo", "branch"]),
		);
		expect(LANES.some((l) => l.state === "opening")).toBe(true);
		expect(LANES.some((l) => l.kind === "adopted")).toBe(true);
	});

	it("every event parses with the contract", () => {
		for (const event of EVENTS) {
			const parsed = parseEvent(event);
			expect(parsed.ok, `${event.type}: ${JSON.stringify(parsed)}`).toBe(true);
		}
	});

	it("events are in seq order", () => {
		const seqs = EVENTS.map((e) => e.seq);
		expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
	});

	it("live pushes carry valid push.accepted data", () => {
		for (let n = 0; n < 3; n += 1) {
			const p = livePush(n);
			const parsed = parseEvent({
				...EVENTS[0],
				id: "01k6g000000000000000099999",
				seq: 9999,
				type: p.type,
				source: { kind: "kernel" },
				data: p.data,
			});
			expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
		}
	});
});
