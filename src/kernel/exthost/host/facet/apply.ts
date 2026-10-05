// Host side of a js/wasm call: the call
// environment a facet (or the in-process `wasm-bundled` runtime) receives,
// and what the host does with its outcome: log lines into the installation
// console, buffered wasm effects applied through the call's `KernelCaps`
// (only after an OK export), errors rethrown as TartanErrors.

import {
	type ExtCtx,
	type Manifest,
	type NoticeKind,
	TartanError,
} from "@tartan/contract";
import type { CallEnv, CallOutcome, Effect, ErrorData } from "./core.ts";

const ERROR_CODES = new Set([
	"invalid",
	"unauthenticated",
	"denied",
	"not_found",
	"conflict",
	"stale",
	"rate_limited",
	"unavailable",
	"timeout",
	"not_implemented",
	"setup_required",
	"protocol_mismatch",
	"internal",
]);

/** The repo of a repo-scoped installation (`scopeKey` `repo:<id>`). */
export const scopeRepoOf = (x: Pick<ExtCtx, "install">): string | undefined =>
	x.install.scopeKey.startsWith("repo:")
		? x.install.scopeKey.slice("repo:".length)
		: undefined;

export const callEnvOf = (
	manifest: Manifest,
	method: string,
	x: ExtCtx,
	now: number,
): CallEnv => {
	const repo = scopeRepoOf(x);
	return {
		method,
		readOnly: x.readOnly,
		install: x.install,
		actor: x.actor,
		config: x.config,
		now,
		quotaBytes: manifest.storage.quotaMB * 1024 * 1024,
		grants: {
			notify: manifest.permissions.notify === true,
			notes: manifest.permissions.notes === true,
		},
		...(repo === undefined ? {} : { repo }),
	};
};

/** An error that crossed the facet boundary as data. */
export const toTartanError = (e: ErrorData): TartanError =>
	new TartanError(
		ERROR_CODES.has(e.code) ? e.code as TartanError["code"] : "internal",
		e.text,
		{
			...(e.reason === undefined ? {} : { reason: e.reason }),
			...(e.details === undefined
				? {}
				: { details: e.details as TartanError["details"] }),
		},
	);

const LEVELS = ["debug", "info", "warn", "error"] as const;

const applyEffect = async (x: ExtCtx, e: Effect): Promise<void> => {
	switch (e.kind) {
		case "emit":
			await x.caps.events.emit(
				e.type,
				e.data,
				e.subject === undefined ? undefined : { subject: e.subject },
			);
			return;
		case "notify": {
			const n = e.notice;
			await x.caps.notify.send(e.principal, {
				kind: n.kind as NoticeKind,
				severity: n.severity as "info" | "warn" | "critical",
				text: n.text,
				...(n.data === undefined || n.data === null ? {} : { data: n.data }),
				...(n.dedupeKey === undefined ? {} : { dedupeKey: n.dedupeKey }),
				...(n.repo === undefined ? {} : { repo: { id: n.repo } }),
				...(n.lane === undefined ? {} : { laneId: n.lane }),
			});
			return;
		}
		case "note": {
			const repo = scopeRepoOf(x);
			if (repo === undefined) {
				throw new TartanError(
					"invalid",
					"contribute-note needs a repo-scoped installation",
				);
			}
			await x.caps.notes.contribute({ id: repo }, e.changeId, e.section);
			return;
		}
		case "timer":
			await x.caps.timers.set(e.key, e.atMs);
			return;
	}
};

/**
 * Logs, then the error or the effects, then the value. A storage-quota
 * refusal carries its size, so the host reports it (`details.size`).
 */
export const settleOutcome = async (
	outcome: CallOutcome,
	x: ExtCtx,
): Promise<unknown> => {
	for (const line of outcome.logs) {
		const level = (LEVELS as readonly string[]).includes(line.level)
			? line.level as typeof LEVELS[number]
			: "info";
		x.log[level](line.msg);
	}
	if (!outcome.ok) throw toTartanError(outcome.error);
	for (const effect of outcome.effects) await applyEffect(x, effect);
	return outcome.value;
};
