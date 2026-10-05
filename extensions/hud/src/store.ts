// tartan.hud storage (migrations 1 and 2): per-minute counters, all-time
// totals, the lanes behind the active-lanes gauge, the reviewed changes
// behind "needed a human", and one cursor per stream so every event is
// applied exactly once (a redelivered or backfilled event is skipped).
//
// Counter rows are `(minute, metric)`; `metric.sim` rows count simulated
// agents only (events flagged `sim`). Gauge rows
// (`lanes.active`) hold the value at the end of the minute; the reader carries
// the last value forward over quiet minutes.

import type { Envelope, Sql } from "@tartan/contract";
import { type Db, db } from "@tartan/ext-api";
import { foldEvent, type HudEffect, METRIC, type Metric } from "./fold.ts";

export const MINUTE_MS = 60_000;
/** Per-minute counters older than this are pruned (totals stay). */
export const RETENTION_MINUTES = 7 * 24 * 60;

export const minuteOf = (at: number): number => Math.floor(at / MINUTE_MS);

const simName = (metric: string): string => `${metric}.sim`;

export type Gauge = { readonly total: number; readonly sim: number };

export const createStore = (sql: Sql) => {
	const d: Db = db(sql);

	const bump = (minute: number, metric: string, n: number): void => {
		d.run(
			`INSERT INTO counters (minute, metric, value) VALUES (?, ?, ?)
			 ON CONFLICT (minute, metric) DO UPDATE SET value = value + excluded.value`,
			minute,
			metric,
			n,
		);
		d.run(
			`INSERT INTO totals (metric, value) VALUES (?, ?)
			 ON CONFLICT (metric) DO UPDATE SET value = value + excluded.value`,
			metric,
			n,
		);
	};

	const setGauge = (minute: number, metric: string, value: number): void => {
		d.run(
			`INSERT INTO counters (minute, metric, value) VALUES (?, ?, ?)
			 ON CONFLICT (minute, metric) DO UPDATE SET value = excluded.value`,
			minute,
			metric,
			value,
		);
	};

	const count = (minute: number, metric: string, n: number, sim: boolean) => {
		bump(minute, metric, n);
		if (sim) bump(minute, simName(metric), n);
	};

	const activeLanes = (): Gauge => {
		const row = d.first<{ total: number; sim: number }>(
			`SELECT count(*) AS total, coalesce(sum(sim), 0) AS sim FROM lanes
			 WHERE state IN ('opening','open')`,
		);
		return { total: row?.total ?? 0, sim: row?.sim ?? 0 };
	};

	const moveLane = (
		laneId: string,
		repo: string | null,
		state: "opening" | "open" | "gone",
		sim: boolean,
		at: number,
		resumed: boolean,
	): void => {
		const current = d.value<string>(
			"SELECT state FROM lanes WHERE lane_id = ?",
			laneId,
		);
		// A closed lane never reopens (lane ids are never reused); a lost lane
		// its agent renewed does (`lane.opened{reason: "resumed"}`).
		if (current === state) return;
		if (current === "gone" && !(resumed && state === "open")) return;
		d.run(
			`INSERT INTO lanes (lane_id, repo, state, sim, at) VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT (lane_id) DO UPDATE SET state = excluded.state, at = excluded.at`,
			laneId,
			repo,
			state,
			sim ? 1 : 0,
			at,
		);
	};

	const review = (
		repo: string,
		changeId: string,
		human: boolean,
		sim: boolean,
		at: number,
		minute: number,
	): void => {
		const row = d.first<{ human: number }>(
			"SELECT human FROM reviews WHERE repo = ? AND change_id = ?",
			repo,
			changeId,
		);
		if (row === null) {
			d.run(
				`INSERT INTO reviews (repo, change_id, human, sim, at) VALUES (?, ?, ?, ?, ?)`,
				repo,
				changeId,
				human ? 1 : 0,
				sim ? 1 : 0,
				at,
			);
			count(minute, METRIC.reviewed, 1, sim);
			if (human) count(minute, METRIC.human, 1, sim);
			return;
		}
		if (human && row.human === 0) {
			d.run(
				"UPDATE reviews SET human = 1 WHERE repo = ? AND change_id = ?",
				repo,
				changeId,
			);
			count(minute, METRIC.human, 1, sim);
		}
	};

	const prune = (minute: number): void => {
		const last = d.value<number>(
			"SELECT value FROM totals WHERE metric = 'prune.minute'",
		);
		if (last !== null && last >= minute) return;
		d.run(
			"DELETE FROM counters WHERE minute < ?",
			minute - RETENTION_MINUTES,
		);
		d.run(
			`INSERT INTO totals (metric, value) VALUES ('prune.minute', ?)
			 ON CONFLICT (metric) DO UPDATE SET value = excluded.value`,
			minute,
		);
	};

	const applyEffect = (
		ev: Envelope,
		effect: HudEffect,
		minute: number,
		sim: boolean,
	): boolean => {
		switch (effect.kind) {
			case "count":
				count(minute, effect.metric, effect.n, sim);
				return false;
			case "lane":
				moveLane(
					effect.laneId,
					ev.repo ?? null,
					effect.state,
					sim,
					ev.at,
					effect.resumed === true,
				);
				return true;
			case "review":
				review(
					ev.repo ?? ev.node,
					effect.changeId,
					effect.human,
					sim,
					ev.at,
					minute,
				);
				return false;
		}
	};

	/**
	 * Applies one event unless its stream's cursor is already past it.
	 * Returns true when the event was applied (false: a redelivery).
	 */
	const apply = (ev: Envelope): boolean =>
		d.tx(() => {
			const seen = d.value<number>(
				"SELECT seq FROM cursors WHERE stream = ?",
				ev.stream,
			);
			if (seen !== null && ev.seq <= seen) return false;
			d.run(
				`INSERT INTO cursors (stream, seq) VALUES (?, ?)
				 ON CONFLICT (stream) DO UPDATE SET seq = excluded.seq`,
				ev.stream,
				ev.seq,
			);
			const minute = minuteOf(ev.at);
			const sim = ev.sim === true;
			let lanesMoved = false;
			for (const effect of foldEvent(ev)) {
				lanesMoved = applyEffect(ev, effect, minute, sim) || lanesMoved;
			}
			if (lanesMoved) {
				const gauge = activeLanes();
				setGauge(minute, METRIC.lanesActive, gauge.total);
				setGauge(minute, simName(METRIC.lanesActive), gauge.sim);
			}
			prune(minute);
			return true;
		});

	/** The last `n` minutes ending at `end` (inclusive), oldest first. */
	const series = (
		metric: Metric,
		end: number,
		n: number,
		options: { readonly sim?: boolean; readonly gauge?: boolean } = {},
	): number[] => {
		const name = options.sim ? simName(metric) : metric;
		const start = end - n + 1;
		const rows = d.all<{ minute: number; value: number }>(
			`SELECT minute, value FROM counters
			 WHERE metric = ? AND minute BETWEEN ? AND ? ORDER BY minute`,
			name,
			start,
			end,
		);
		const byMinute = new Map(rows.map((r) => [r.minute, r.value]));
		let carry = options.gauge
			? d.value<number>(
				`SELECT value FROM counters WHERE metric = ? AND minute < ?
				 ORDER BY minute DESC LIMIT 1`,
				name,
				start,
			) ?? 0
			: 0;
		return Array.from({ length: n }, (_, i) => {
			const value = byMinute.get(start + i);
			if (options.gauge) {
				if (value !== undefined) carry = value;
				return carry;
			}
			return value ?? 0;
		});
	};

	const total = (metric: Metric, sim = false): number =>
		d.value<number>(
			"SELECT value FROM totals WHERE metric = ?",
			sim ? simName(metric) : metric,
		) ?? 0;

	return { apply, series, total, activeLanes };
};

export type HudStore = ReturnType<typeof createStore>;
