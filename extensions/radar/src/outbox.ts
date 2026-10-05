// Delivers the outbox (events and notices planned in a state transaction).
// At least once: an entry is deleted only after its call succeeded; each
// carries a stable key (`idemKey` for events, `dedupeKey` for notices), so a
// redelivery after a crash is absorbed by the host and the inbox. A failure
// the kernel will never accept (denied, invalid, not found) drops the entry;
// anything else is retried by the `flush` timer, at most 5 times. Never
// throws: a delivery problem must not fail the state change that planned it.

import { type ExtCtx, isTartanError } from "@tartan/contract";
import { type Db, json } from "@tartan/ext-api";
import {
	FLUSH_BATCH,
	FLUSH_MAX_ATTEMPTS,
	FLUSH_RETRY_MS,
	FLUSH_TIMER,
} from "./model.ts";
import type { EmitBody, NotifyBody } from "./reconcile.ts";
import { pendingOutbox } from "./store.ts";

const permanent = (error: unknown): boolean =>
	isTartanError(error) &&
	(error.code === "invalid" || error.code === "not_found" ||
		(error.code === "denied" && error.reason !== "quota"));

export const flushOutbox = async (x: ExtCtx, d: Db): Promise<number> => {
	const rows = pendingOutbox(d, FLUSH_BATCH);
	let sent = 0;
	for (const row of rows) {
		try {
			if (row.kind === "emit") {
				const body = json.decode<EmitBody | null>(row.body_json, null);
				if (body) {
					await x.caps.events.emit(body.type, body.data, {
						subject: body.subject,
						correlation: body.correlation,
						idemKey: row.id,
					});
				}
			} else {
				const body = json.decode<NotifyBody | null>(row.body_json, null);
				if (body) await x.caps.notify.send(body.principal, body.notice);
			}
			d.run("DELETE FROM outbox WHERE id = ?", row.id);
			sent++;
		} catch (error) {
			const attempts = row.attempts + 1;
			if (permanent(error) || attempts >= FLUSH_MAX_ATTEMPTS) {
				x.log.warn(`radar: dropped ${row.kind} ${row.id}`, {
					error: error instanceof Error ? error.message : String(error),
					attempts,
				});
				d.run("DELETE FROM outbox WHERE id = ?", row.id);
			} else {
				d.run("UPDATE outbox SET attempts = ? WHERE id = ?", attempts, row.id);
			}
		}
	}
	const left = d.value<number>("SELECT COUNT(*) FROM outbox") ?? 0;
	if (left > 0) {
		try {
			await x.caps.timers.set(
				FLUSH_TIMER,
				x.caps.clock.now() + FLUSH_RETRY_MS,
			);
		} catch (error) {
			// The next event or tool call flushes what is left.
			x.log.warn("radar: could not set the flush timer", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return sent;
};
