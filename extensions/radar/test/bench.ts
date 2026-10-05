// The radar join benchmark: N active lanes × P touched paths each, seeded
// straight into radar's tables (same statements the handlers use), then the
// per-push join (`analyzeLane`) timed for a sample of lanes. Portable: it
// takes any `Sql` (the Deno harness's node:sqlite storage, or a Durable
// Object's `ctx.storage.sql` behind the host's guard).

import type { Sql } from "@tartan/contract";
import { db } from "@tartan/ext-api";
import { analyzeLane } from "../src/analyze.ts";
import { replaceTouches, setFootprint, upsertLane } from "../src/store.ts";

export type BenchShape = {
	readonly lanes: number;
	readonly pathsPerLane: number;
	readonly projects: number;
	readonly filesPerProject: number;
};

/** 1,000 lanes × 10 paths across 50 projects of 200 files (≈ one other lane per path). */
export const SPREAD: BenchShape = {
	lanes: 1000,
	pathsPerLane: 10,
	projects: 50,
	filesPerProject: 200,
};

/** 1,000 lanes × 10 paths in one project of 100 files (≈ 100 lanes per path). */
export const HOT: BenchShape = {
	lanes: 1000,
	pathsPerLane: 10,
	projects: 1,
	filesPerProject: 100,
};

const lane = (i: number) => `ln_01k6${String(i).padStart(22, "0")}`;
const agent = (i: number) => `a_01k6${String(i).padStart(22, "0")}`;
const hex = (i: number) => i.toString(16).padStart(40, "0");

/** Deterministic xorshift for path choice. */
const rng = (seed: number) => () => {
	seed ^= seed << 13;
	seed ^= seed >>> 17;
	seed ^= seed << 5;
	return (seed >>> 0) / 0x1_0000_0000;
};

export const seedBench = (sql: Sql, shape: BenchShape): void => {
	const d = db(sql);
	const next = rng(42);
	d.tx(() => {
		for (let i = 1; i <= shape.lanes; i++) {
			const project = i % shape.projects;
			const root = `services/s${project}`;
			upsertLane(d, {
				laneId: lane(i),
				owner: agent(i),
				base: hex(1),
				state: "open",
				mode: "branch",
				ref: `refs/heads/lanes/${lane(i)}`,
				ownerLabel: `agent-${i}`,
				openedAt: 1,
			});
			setFootprint(d, lane(i), {
				projects: [],
				prefixes: [`${root}/src/m${i % 7}`],
			});
			const files = new Set<number>();
			while (files.size < shape.pathsPerLane) {
				files.add(Math.floor(next() * shape.filesPerProject));
			}
			replaceTouches(
				d,
				lane(i),
				[...files].map((f) => ({
					path: `${root}/src/m${f % 7}/f${f}.ts`,
					project: `s${project}`,
					change: "modified",
				})),
				{
					head: hex(1000 + i),
					rangeBase: hex(1),
					rangeTruncated: false,
					commits: [hex(1000 + i)],
					truncated: false,
					at: 1,
				},
			);
		}
	});
};

export type BenchResult = {
	readonly samples: number;
	readonly medianMs: number;
	readonly maxMs: number;
	readonly findings: number;
};

/** Times `analyzeLane` for `samples` lanes spread over the seeded set. */
export const timeJoin = (
	sql: Sql,
	shape: BenchShape,
	samples = 25,
	now: () => number = () => performance.now(),
): BenchResult => {
	const d = db(sql);
	// Warm the statement cache once, as a live DO would be.
	analyzeLane(d, lane(1));
	const times: number[] = [];
	let findings = 0;
	for (let s = 0; s < samples; s++) {
		const id = lane(1 + Math.floor((s * shape.lanes) / samples));
		const t0 = now();
		findings += analyzeLane(d, id).length;
		times.push(now() - t0);
	}
	times.sort((a, b) => a - b);
	return {
		samples,
		medianMs: times[Math.floor(times.length / 2)],
		maxMs: times[times.length - 1],
		findings,
	};
};
