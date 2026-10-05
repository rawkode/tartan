// Test-only fakes shared by the Deno harness and the workerd tests (no
// `node:sqlite`, no `cloudflare:*`): WP6's event log kept in the same
// database as the module under test (so a rolled-back transaction drops its
// events too; payloads are validated against the contract like WP6 will),
// and WP10's land internals. WP1's `@tartan/testkit` does not exist yet.

import {
	type AppendInput,
	type AppendResult,
	createUlid,
	type Envelope,
	isLaneEventType,
	validateEventData,
} from "@tartan/contract";
import type {
	AdvanceRow,
	LandingRow,
	RepoCoreInternal,
	RepoInternals,
} from "@tartan/contract/kernel.ts";

export const EVENTS_DDL = `CREATE TABLE IF NOT EXISTS test_events (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	id TEXT NOT NULL UNIQUE,
	idem_key TEXT NOT NULL UNIQUE,
	type TEXT NOT NULL,
	envelope_json TEXT NOT NULL
)`;

export type FakeEvents = RepoInternals["events"] & {
	all(): Envelope[];
	ofType(type: string): Envelope[];
	types(): string[];
};

export const createFakeEvents = (
	sql: SqlStorage,
	clock: { now(): number },
	core: () => RepoCoreInternal,
): FakeEvents => {
	sql.exec(EVENTS_DDL);
	const storage = { sql };
	const ulid = createUlid({ now: () => clock.now() });
	const read = (): Envelope[] =>
		storage.sql.exec<{ envelope_json: string }>(
			"SELECT envelope_json FROM test_events ORDER BY seq",
		).toArray().map((row) => JSON.parse(row.envelope_json) as Envelope);
	const appendSync = (input: AppendInput): AppendResult => {
		const existing = storage.sql.exec<{ id: string; seq: number }>(
			"SELECT id, seq FROM test_events WHERE idem_key = ?",
			input.idemKey,
		).toArray()[0];
		if (existing !== undefined) {
			return {
				id: existing.id,
				seq: existing.seq,
				hash: "0".repeat(64),
				created: false,
			};
		}
		const valid = validateEventData(input.type, input.data);
		if (!valid.ok) {
			throw new Error(`invalid ${input.type}: ${valid.errors.join("; ")}`);
		}
		const id = ulid();
		const seq = (storage.sql.exec<{ n: number | null }>(
			"SELECT MAX(seq) AS n FROM test_events",
		).one().n ?? 0) + 1;
		const envelope = {
			id,
			seq,
			stream: `repo:${input.repo}`,
			type: input.type,
			v: input.v ?? 1,
			source: input.source,
			actor: input.actor,
			node: input.node,
			...(input.repo ? { repo: input.repo } : {}),
			...(input.subject ? { subject: input.subject } : {}),
			...(input.causedBy ? { causedBy: input.causedBy } : {}),
			depth: input.depth,
			shadow: input.shadow,
			at: clock.now(),
			data: input.data,
		} as unknown as Envelope;
		storage.sql.exec(
			"INSERT INTO test_events (seq, id, idem_key, type, envelope_json) VALUES (?, ?, ?, ?, ?)",
			seq,
			id,
			input.idemKey,
			input.type,
			JSON.stringify(envelope),
		);
		if (!input.shadow && isLaneEventType(input.type)) {
			core().applyLaneEventSync(envelope);
		}
		return { id, seq, hash: "0".repeat(64), created: true };
	};
	return {
		appendSync,
		existingSync: (ids) =>
			read().filter((e) => ids.includes(e.id)).map((e) => e.id),
		getSync: (ids) => {
			const all = read();
			return ids.map((id) => all.find((e) => e.id === id)).filter((e) =>
				e !== undefined
			);
		},
		pinSync: () => {},
		headSync: () => ({ seq: read().length, hash: "0".repeat(64) }),
		all: read,
		ofType: (type) => read().filter((e) => e.type === type),
		types: () => read().map((e) => e.type),
	};
};

export type FakeLand = RepoInternals["land"] & {
	readonly inflight: Map<string, AdvanceRow>;
	readonly landings: Map<string, LandingRow>;
};

export const createFakeLand = (): FakeLand => {
	const inflight = new Map<string, AdvanceRow>();
	const landings = new Map<string, LandingRow>();
	return {
		inflight,
		landings,
		inflightAdvanceSync: (ref) => inflight.get(ref) ?? null,
		advanceSync: () => null,
		landingsSinceSync: () => [],
		landingByLaneSync: (laneId) => landings.get(laneId) ?? null,
	};
};
