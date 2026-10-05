// tartan-smoke-lanes Worker: wires the capability-route app (`app.ts`) to
// the Artifacts binding, a CapState Durable Object (one atomic state call per
// verified request) and the platform fetch. Smoke-only: never part of the
// product Worker or its wrangler.jsonc.

import { DurableObject } from "cloudflare:workers";
import {
	CAP_INFO_USES_MAX,
	type CapRecord,
	type CapStore,
	createLanesApp,
	type LanesApp,
} from "./app.ts";

export interface Env {
	readonly ARTIFACTS: Artifacts;
	readonly CAP_STATE: DurableObjectNamespace<CapState>;
	/** Dedicated capability MAC key (wrangler secret). */
	readonly LANE_CAP_KEY: string;
	/** The drivers' bearer key (wrangler secret). */
	readonly SMOKE_KEY: string;
	/** "1" serves the pinned base when trunk moved (U55). */
	readonly LANE_CAP_PIN_BASE?: string;
}

export class CapState extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS caps (nonce TEXT PRIMARY KEY, record TEXT NOT NULL)",
		);
	}

	put(record: CapRecord): void {
		this.ctx.storage.sql.exec(
			"INSERT OR REPLACE INTO caps (nonce, record) VALUES (?, ?)",
			record.nonce,
			JSON.stringify(record),
		);
	}

	use(
		laneId: string,
		nonce: string,
		repoId: string,
		op: "info" | "pack",
		now: number,
	): CapRecord | null {
		return this.ctx.storage.transactionSync(() => {
			const row = this.ctx.storage.sql
				.exec<{ record: string }>(
					"SELECT record FROM caps WHERE nonce = ?",
					nonce,
				)
				.toArray()[0];
			if (!row) return null;
			const r = JSON.parse(row.record) as CapRecord;
			if (
				r.laneId !== laneId || r.repoId !== repoId || r.closed ||
				r.consumedAt !== null || now >= r.exp * 1000 ||
				(op === "info" && r.infoUses >= CAP_INFO_USES_MAX)
			) {
				return null;
			}
			const next = op === "info"
				? { ...r, infoUses: r.infoUses + 1 }
				: { ...r, consumedAt: now };
			this.put(next);
			return next;
		});
	}

	close(nonce: string): boolean {
		const row = this.ctx.storage.sql
			.exec<{ record: string }>(
				"SELECT record FROM caps WHERE nonce = ?",
				nonce,
			)
			.toArray()[0];
		if (!row) return false;
		this.put({ ...(JSON.parse(row.record) as CapRecord), closed: true });
		return true;
	}
}

const storeOf = (env: Env): CapStore => {
	const stub = () => env.CAP_STATE.getByName("caps");
	return {
		put: async (r) => {
			await stub().put(r);
		},
		use: async (...args) => (await stub().use(...args)) as CapRecord | null,
		close: async (nonce) => await stub().close(nonce),
	};
};

let app: LanesApp | null = null;

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		app ??= createLanesApp({
			artifacts: env.ARTIFACTS,
			capKey: env.LANE_CAP_KEY,
			smokeKey: env.SMOKE_KEY,
			store: storeOf(env),
			upstreamFetch: (r) => fetch(r),
			pinBase: env.LANE_CAP_PIN_BASE === "1",
		});
		return app.fetch(request, (p) => ctx.waitUntil(p));
	},
} satisfies ExportedHandler<Env>;
