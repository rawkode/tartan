// Test-only fixtures for the global log (Deno and workerd): an in-memory
// events source for the relay core, envelopes, and the RepoDO/ForgeDO module
// sets wired to FakeK2 for `createTestDo`. Runtime code never imports this.

import type { AppendInput, Envelope } from "@tartan/contract";
import { type FakeK2 } from "@tartan/testkit/k2/fake.ts";
import { createForgeEventsModule } from "../../events/forge.ts";
import { createRepoEventsModule } from "../../events/repo.ts";
import type { EventLogRow, EventsRelaySource } from "../contract.ts";
import { createForgeBusModule, createRepoBusModule } from "../relay.ts";
import { manualSchedule, type TestClock } from "./do.ts";

export const REPO = "01k6aaaaaaaaaaaaaaaaaaaaaa";
export const STAGE = "dev-wp26";
export const EXT = "i_01k6aaaaaaaaaaaaaaaaaaaaab";

const BASE32 = "0123456789abcdefghjkmnpqrstvwxyz";
/** A ULID-shaped id for event `n`. */
export const eventId = (n: number): string => {
	let suffix = "";
	let v = n;
	for (let i = 0; i < 8; i++) {
		suffix = BASE32[v % 32] + suffix;
		v = Math.floor(v / 32);
	}
	return `01k8${"0".repeat(14)}${suffix}`;
};

export const testEnvelope = (
	seq: number,
	over: Partial<Envelope> = {},
): Envelope => ({
	id: eventId(seq),
	seq,
	stream: `repo:${REPO}`,
	type: "presence.changed",
	v: 1,
	source: { kind: "kernel" },
	actor: { kind: "system", id: "sys_kernel" },
	node: REPO,
	repo: REPO,
	depth: 0,
	shadow: false,
	at: 1_000 + seq,
	hash: seq.toString(16).padStart(64, "0"),
	data: { principal: "u_01k6aaaaaaaaaaaaaaaaaaaaac", status: `s${seq}` },
	...over,
});

/** An in-memory `EventsRelaySource` (the relay core's sibling). */
export const memorySource = (epoch = "01k6eeeeeeeeeeeeeeeeeeeeee") => {
	let rows: EventLogRow[] = [];
	const hooks: (() => void)[] = [];
	const source: EventsRelaySource = {
		readSync: ({ since, limit }) =>
			rows.filter((r) => r.seq > since).slice(0, limit),
		epochSync: () => epoch,
		oldestSeqSync: () => rows[0]?.seq ?? null,
		headSync: () => ({ seq: rows.at(-1)?.seq ?? 0 }),
		onFlush: () => {},
		onAppendSync: (hook) => {
			hooks.push(() => hook({ seq: rows.at(-1)?.seq ?? 0 }));
		},
	};
	return {
		source,
		/** Appends rows `from..to` (or with `over`). */
		add: (
			count: number,
			over: (seq: number) => Partial<Envelope> = () => ({}),
		) => {
			const start = (rows.at(-1)?.seq ?? 0) + 1;
			for (let seq = start; seq < start + count; seq++) {
				const envelope = testEnvelope(seq, over(seq));
				rows.push({
					seq,
					idemKey: `k${seq}`,
					prevHash: (seq - 1).toString(16).padStart(64, "0"),
					hash: envelope.hash ?? null,
					repo: REPO,
					envelope,
				});
				for (const hook of hooks) hook();
			}
		},
		/** Drops every row with `seq ≤ upTo` (retention). */
		prune: (upTo: number) => {
			rows = rows.filter((r) => r.seq > upTo);
		},
		rows: () => rows,
	};
};

/** An append the RepoDO log accepts (a valid kernel `presence.changed`). */
export const presence = (
	n: number,
	over: Partial<AppendInput> = {},
): AppendInput => ({
	type: "presence.changed",
	source: { kind: "kernel" },
	actor: { kind: "system", id: "sys_kernel" },
	node: REPO,
	repo: REPO,
	depth: 0,
	shadow: false,
	data: { principal: "u_01k6aaaaaaaaaaaaaaaaaaaaac", status: `s${n}` },
	idemKey: `test:presence:${n}`,
	...over,
});

const coreStub = {
	name: "core",
	range: [100, 199] as const,
	migrations: [],
	create: () => ({ facade: {}, internal: { applyLaneEventSync: () => {} } }),
};

/** RepoDO modules for `createTestDo`: the real log and relay over FakeK2. */
export const repoBusModules = (
	k2: FakeK2 | null,
	options: { nudges?: string[]; clock: TestClock },
) => {
	const schedule = manualSchedule();
	const silent = () => {};
	return {
		schedule,
		env: {
			TARTAN_STAGE: STAGE,
			...(k2 === null
				? {}
				: { TARTAN_K2_STREAM: k2.streamId, EVENT_LOG: k2.producer }),
		},
		modules: {
			core: coreStub,
			events: createRepoEventsModule({
				poke: () => () => Promise.resolve(),
				subscribers: () => ({
					extVersion: () => Promise.resolve(0),
					load: () => Promise.resolve({ rows: [], extVersion: 0 }),
				}),
				schedule: schedule.schedule,
				log: silent,
			}),
			bus: createRepoBusModule({
				nudge: () => () => {
					options.nudges?.push(String(options.clock.now()));
					return Promise.resolve();
				},
				log: silent,
			}),
		},
	};
};

/** ForgeDO modules for `createTestDo`: the forge stream and its relay. */
export const forgeBusModules = (k2: FakeK2 | null) => {
	const schedule = manualSchedule();
	const silent = () => {};
	const stub = (
		name: string,
		range: readonly [number, number],
		internal: object,
	) => ({
		name,
		range,
		migrations: [],
		create: () => ({ facade: {}, internal }),
	});
	return {
		schedule,
		env: {
			TARTAN_STAGE: STAGE,
			...(k2 === null
				? {}
				: { TARTAN_K2_STREAM: k2.streamId, EVENT_LOG: k2.producer }),
		},
		modules: {
			tree: stub("tree", [200, 299], {}),
			registry: stub("registry", [300, 399], { inForceSync: () => [] }),
			events: createForgeEventsModule({
				poke: () => () => Promise.resolve(),
				schedule: schedule.schedule,
				log: silent,
			}),
			bus: createForgeBusModule({
				nudge: () => () => Promise.resolve(),
				log: silent,
			}),
		},
	};
};
