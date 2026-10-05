// tartan-smoke-git Worker: wires the git smoke app (`app.ts`) to the
// Artifacts binding, a Recorder Durable Object and the push-event Workflow
// (`cf.artifacts.repo.pushed` → PushRecorder, A5). Smoke-only: never part of
// the product Worker or its wrangler.jsonc.

import {
	DurableObject,
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import { createGitApp, type GitApp, type RecordRow } from "./app.ts";

export interface Env {
	readonly ARTIFACTS: Artifacts;
	readonly RECORDER: DurableObjectNamespace<Recorder>;
	readonly PUSH_WF: Workflow<unknown>;
	/** The drivers' key: Bearer for /api, Basic password for /git (secret). */
	readonly SMOKE_KEY: string;
	readonly UPSTREAM_AUTH_MODE?: "bearer" | "basic";
}

export class Recorder extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS rec (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, ts INTEGER NOT NULL, data TEXT NOT NULL)",
		);
	}

	record(kind: string, data: unknown): number {
		const ts = Date.now();
		this.ctx.storage.sql.exec(
			"INSERT INTO rec (kind, ts, data) VALUES (?, ?, ?)",
			kind,
			ts,
			JSON.stringify(data),
		);
		return ts;
	}

	list(kind?: string, sinceTs = 0): RecordRow[] {
		const rows = kind
			? this.ctx.storage.sql.exec(
				"SELECT * FROM rec WHERE kind = ? AND ts >= ? ORDER BY seq",
				kind,
				sinceTs,
			).toArray()
			: this.ctx.storage.sql.exec(
				"SELECT * FROM rec WHERE ts >= ? ORDER BY seq",
				sinceTs,
			).toArray();
		return rows.map((r) => ({
			seq: r.seq as number,
			kind: r.kind as string,
			ts: r.ts as number,
			data: JSON.parse(r.data as string),
		}));
	}

	clear(): number {
		const n = this.ctx.storage.sql.exec("SELECT count(*) AS n FROM rec").one()
			.n as number;
		this.ctx.storage.sql.exec("DELETE FROM rec");
		return n;
	}
}

const recorder = (env: Env) => env.RECORDER.getByName("global");

type WaitTestParams = { waitTest: string; sleepS?: number };

const timestampOf = (t: unknown): number =>
	t instanceof Date ? t.getTime() : Number(t);

/** Records every trigger delivery (A5) and runs the A5b/A5c probes. */
export class PushRecorder extends WorkflowEntrypoint<Env, unknown> {
	override async run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
		const p = event.payload as Record<string, unknown> | undefined;
		if (p && typeof p === "object" && "waitTest" in p) {
			const w = p as WaitTestParams;
			const createdAt = timestampOf(event.timestamp);
			await step.sleep(
				"pre-wait",
				`${w.sleepS ?? 8} seconds` as `${number} seconds`,
			);
			const waitStartedAt = await step.do(
				"wait-start",
				() => Promise.resolve(Date.now()),
			);
			let got: unknown;
			try {
				const ev = await step.waitForEvent<{ sentAt: number; which: string }>(
					"ping",
					{ type: "smoke-ping", timeout: "40 seconds" },
				);
				got = { received: true, payload: ev.payload, type: ev.type };
			} catch (e) {
				got = { received: false, error: String(e) };
			}
			return await step.do("record-wait", async () => {
				const at = Date.now();
				await recorder(this.env).record("wf-wait", {
					instanceId: event.instanceId,
					waitTest: w.waitTest,
					createdAt,
					waitStartedAt,
					resolvedAt: at,
					waitMs: at - waitStartedAt,
					got,
				});
				return { at };
			});
		}
		const kind = p && typeof p === "object" && "smokeTest" in p
			? "wf-batch"
			: "wf-event";
		return await step.do("record", async () => {
			const startedAt = Date.now();
			await recorder(this.env).record(kind, {
				instanceId: event.instanceId,
				workflowName: event.workflowName,
				instanceCreatedAt: timestampOf(event.timestamp),
				stepStartedAt: startedAt,
				payload: event.payload,
			});
			return { recorded: kind, startedAt };
		});
	}
}

let app: GitApp | null = null;

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		app ??= createGitApp({
			artifacts: env.ARTIFACTS,
			smokeKey: env.SMOKE_KEY,
			recorder: {
				record: (kind, data) => recorder(env).record(kind, data),
				list: (kind, since) => recorder(env).list(kind, since),
				clear: () => recorder(env).clear(),
			},
			upstreamFetch: (r) => fetch(r),
			workflow: env.PUSH_WF,
			upstreamAuthMode: env.UPSTREAM_AUTH_MODE ?? "bearer",
		});
		return app.fetch(request, (p) => ctx.waitUntil(p));
	},
} satisfies ExportedHandler<Env>;
