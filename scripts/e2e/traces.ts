// Retained Playwright traces after a run. e2e rewrites only registered
// secrets in them, so a failed attempt's `trace.zip` still holds the forge
// session cookie of the persona it ran as (request headers). After every run
// the launcher:
//
// 1. opens every retained trace, collects each `__Host-tartan-session`
//    value and ends that session (`POST /-/auth/logout` with the cookie and
//    `Origin: <canonical>`), logging only the count;
// 2. deletes every trace when a revocation failed, a trace could not be
//    read, or `--drop-traces` was given; otherwise keeps them (the cookies
//    in them are dead) for local debugging. Traces never enter evidence.

import { sessionCookiesInZip } from "./leakscan.ts";

export type TraceFs = {
	walk(dir: string): Promise<string[]>;
	read(file: string): Promise<Uint8Array>;
	remove(file: string): Promise<void>;
};

export const findTraces = async (
	fs: Pick<TraceFs, "walk">,
	outputDir: string,
): Promise<string[]> =>
	(await fs.walk(`${outputDir}/artifacts`)).filter((f) => f.endsWith(".zip"));

export type TraceSweep = {
	readonly traces: number;
	readonly sessions: number;
	readonly revoked: ReadonlySet<string>;
	readonly failed: number;
	readonly unreadable: number;
	readonly deleted: boolean;
};

export const sweepTraces = async (deps: {
	readonly fs: TraceFs;
	readonly outputDir: string;
	readonly signOut: (session: string) => Promise<boolean>;
	readonly drop: boolean;
	readonly log: (line: string) => void;
}): Promise<TraceSweep> => {
	const traces = await findTraces(deps.fs, deps.outputDir);
	const sessions = new Set<string>();
	let unreadable = 0;
	for (const trace of traces) {
		try {
			for (const s of await sessionCookiesInZip(await deps.fs.read(trace))) {
				sessions.add(s);
			}
		} catch {
			unreadable++;
		}
	}
	const revoked = new Set<string>();
	let failed = 0;
	for (const s of sessions) {
		const ok = await deps.signOut(s).catch(() => false);
		if (ok) revoked.add(s);
		else failed++;
	}
	const deleted = traces.length > 0 &&
		(deps.drop || failed > 0 || unreadable > 0);
	if (deleted) {
		for (const trace of traces) await deps.fs.remove(trace);
	}
	if (traces.length > 0) {
		deps.log(
			`traces: ${traces.length} retained, ${revoked.size} session(s) in them ended${
				failed > 0 ? `, ${failed} could not be ended` : ""
			}${unreadable > 0 ? `, ${unreadable} unreadable` : ""}${
				deleted ? "; traces deleted" : ""
			}`,
		);
	}
	return {
		traces: traces.length,
		sessions: sessions.size,
		revoked,
		failed,
		unreadable,
		deleted,
	};
};
