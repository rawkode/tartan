// Test fakes for the runs modules (Deno only; local until @tartan/testkit,
// WP1, ships shared ones): an event log, Artifacts token minting in the live
// token format, a scripted sandbox, module deps and a timer table.

import type { AppendInput, AppendResult } from "@tartan/contract";
import type { ModuleTimersApi } from "@tartan/contract/kernel.ts";
import type {
	ExecOutput,
	LogEvent,
	MintedToken,
	PortExecOptions,
	ProcessInfo,
	SandboxPort,
} from "../jobs.ts";
import { createFakeStorage } from "./sqlite.ts";

/** A token in the binding's format: `art_v2_x_<40 hex>?expires=<unix>`. */
export const LIVE_TOKEN = `art_v2_x_${
	"0123456789abcdef".repeat(2)
}01234567?expires=1791234567`;

// ---------------------------------------------------------------------------
// Events (RepoEventsInternal.appendSync, idempotent on idemKey)
// ---------------------------------------------------------------------------

export const fakeEvents = () => {
	const appended: AppendInput[] = [];
	const byKey = new Map<string, AppendResult>();
	const appendSync = (input: AppendInput): AppendResult => {
		const existing = byKey.get(input.idemKey);
		if (existing) return { ...existing, created: false };
		appended.push(input);
		const result = {
			id: `e${appended.length}`,
			seq: appended.length,
			hash: "0".repeat(64),
			created: true,
		};
		byKey.set(input.idemKey, result);
		return result;
	};
	return { appended, internal: { appendSync } };
};

// ---------------------------------------------------------------------------
// Artifacts tokens: one live-format token per mint, valid for one repo only
// ---------------------------------------------------------------------------

export const fakeTokens = () => {
	let n = 0;
	const minted: {
		repo: string;
		scope: "read" | "write";
		token: string;
		revoked: boolean;
	}[] = [];
	const mint = (repo: string, scope: "read" | "write"): MintedToken => {
		n += 1;
		const token = `art_v2_x_${
			n.toString(16).padStart(40, "0")
		}?expires=1791234567`;
		const record = { repo, scope, token, revoked: false };
		minted.push(record);
		return {
			remote: `https://artifacts.fake.test/ns/${repo}.git`,
			token,
			revoke: () => {
				record.revoked = true;
				return Promise.resolve();
			},
		};
	};
	/** Whether `token` authorizes `scope` on `repo` (as Artifacts scopes tokens). */
	const allows = (token: string, repo: string, scope: "read" | "write") =>
		minted.some((m) =>
			m.token === token && m.repo === repo && !m.revoked &&
			(m.scope === "write" || scope === "read")
		);
	return { mint, minted, allows };
};

// ---------------------------------------------------------------------------
// A scripted sandbox (SandboxPort)
// ---------------------------------------------------------------------------

type Proc = {
	id: string;
	command: string;
	env: Readonly<Record<string, string>>;
	cwd?: string;
	status: ProcessInfo["status"];
	exitCode: number | null;
	events: LogEvent[];
	waiters: (() => void)[];
};

export type ExecCall = {
	readonly command: string;
	readonly options?: PortExecOptions;
	readonly startedAt: number;
	endedAt?: number;
};

export const fakeSandbox = (
	options: {
		/** Answers for `exec`; default exit 0 with empty output. */
		exec?: (command: string, options?: PortExecOptions) => ExecOutput;
		/** Throw this many times on the first container call (a cold start's 500). */
		failFirstCalls?: number;
		execDelayMs?: number;
	} = {},
) => {
	const procs = new Map<string, Proc>();
	const execs: ExecCall[] = [];
	const background: Promise<unknown>[] = [];
	let failures = options.failFirstCalls ?? 0;
	let destroyed = 0;
	let watchdogs = 0;
	let keepAlive = false;
	let clock = 0;
	let generation = 0;
	const coldStart = () => {
		if (failures > 0) {
			failures -= 1;
			throw new Error(
				"Default session initialization was invalidated by a container stop",
			);
		}
	};
	const wake = (proc: Proc) => {
		const waiters = proc.waiters.splice(0);
		for (const w of waiters) w();
	};
	const port: SandboxPort = {
		exec: async (command, opts) => {
			coldStart();
			const call: ExecCall = { command, options: opts, startedAt: clock++ };
			execs.push(call);
			if (options.execDelayMs) {
				await new Promise((r) => setTimeout(r, options.execDelayMs));
			}
			call.endedAt = clock++;
			return options.exec?.(command, opts) ??
				{ exitCode: 0, stdout: "", stderr: "" };
		},
		startProcess: (command, opts) => {
			coldStart();
			const id = opts?.processId ?? `p${procs.size + 1}`;
			if (procs.has(id)) {
				return Promise.reject(new Error(`process ${id} already exists`));
			}
			procs.set(id, {
				id,
				command,
				env: { ...(opts?.env ?? {}) },
				cwd: opts?.cwd,
				status: "running",
				exitCode: null,
				events: [],
				waiters: [],
			});
			return Promise.resolve({ id });
		},
		getProcess: (id) => {
			const proc = procs.get(id);
			return Promise.resolve(
				proc === undefined
					? null
					: { status: proc.status, exitCode: proc.exitCode },
			);
		},
		killProcess: async (id) => {
			const proc = procs.get(id);
			if (proc !== undefined && proc.status === "running") {
				proc.status = "killed";
				proc.exitCode = 143;
				proc.events.push({ type: "exit", exitCode: 143 });
				wake(proc);
				// As live: the pump sees the exit before the killer resumes.
				await new Promise((r) => setTimeout(r, 5));
			}
		},
		streamLogs: (id) => {
			const proc = procs.get(id);
			if (proc === undefined) return Promise.reject(new Error("no process"));
			// Replays everything from the start, then follows (as the SDK does).
			const mine = generation;
			async function* follow(): AsyncIterable<LogEvent> {
				let i = 0;
				while (true) {
					if (mine !== generation) return;
					while (i < proc!.events.length) {
						const event = proc!.events[i++];
						yield event;
						if (event.type === "exit") return;
					}
					await new Promise<void>((r) => proc!.waiters.push(r));
				}
			}
			return Promise.resolve(follow());
		},
		destroy: () => {
			destroyed += 1;
			for (const proc of procs.values()) {
				if (proc.status === "running") {
					proc.status = "killed";
					wake(proc);
				}
			}
			return Promise.resolve();
		},
		setKeepAlive: (on) => {
			coldStart();
			keepAlive = on;
			return Promise.resolve();
		},
		scheduleWatchdog: () => {
			watchdogs += 1;
			return Promise.resolve();
		},
		waitUntil: (work) => {
			background.push(work);
		},
	};
	return {
		port,
		procs,
		execs,
		/** Appends output to a process (as its stream would deliver it). */
		emit: (id: string, ...events: LogEvent[]) => {
			const proc = procs.get(id)!;
			for (const event of events) {
				proc.events.push(event);
				if (event.type === "exit") {
					proc.status = "completed";
					proc.exitCode = event.exitCode ?? null;
				}
			}
			wake(proc);
		},
		/** The process ends without the stream noticing (an evicted pump). */
		exitSilently: (id: string, exitCode: number) => {
			const proc = procs.get(id)!;
			proc.status = "completed";
			proc.exitCode = exitCode;
		},
		/** Ends every open log stream without an exit (the DO was evicted). */
		dropStreams: () => {
			generation += 1;
			for (const proc of procs.values()) wake(proc);
		},
		/** Lets background pumps and flush timers run (they may stay open). */
		settle: async (ms = 25) => {
			await new Promise((r) => setTimeout(r, ms));
		},
		get destroyed() {
			return destroyed;
		},
		get watchdogs() {
			return watchdogs;
		},
		get keepAlive() {
			return keepAlive;
		},
	};
};

// ---------------------------------------------------------------------------
// Module deps
// ---------------------------------------------------------------------------

export const fakeTimers = () => {
	const pending = new Map<string, number>();
	const api: ModuleTimersApi = {
		schedule: (key, at) => {
			pending.set(key, at);
		},
		cancel: (key) => {
			pending.delete(key);
		},
		get: (key) => pending.get(key) ?? null,
	};
	return { api, pending };
};

export const fakeClock = (start = 1_790_000_000_000) => {
	let now = start;
	return {
		now: () => now,
		advance: (ms: number) => {
			now += ms;
		},
		set: (at: number) => {
			now = at;
		},
	};
};

export const fakeIds = () => {
	let n = 0;
	const BASE32 = "0123456789abcdefghjkmnpqrstvwxyz";
	return {
		ulid: () => {
			n += 1;
			let suffix = "";
			let v = n;
			for (let i = 0; i < 6; i++) {
				suffix = BASE32[v % 32] + suffix;
				v = Math.floor(v / 32);
			}
			return `01k6${"0".repeat(16)}${suffix}`;
		},
	};
};

/** A fresh SQLite-backed `ctx` with `waitUntil` collecting background work. */
export const fakeDoState = () => {
	const { sql, storage, db } = createFakeStorage();
	const background: Promise<unknown>[] = [];
	const ctx = {
		storage,
		waitUntil: (p: Promise<unknown>) => {
			background.push(p);
		},
	} as unknown as DurableObjectState;
	return {
		sql,
		storage,
		db,
		ctx,
		background,
		settle: async () => {
			await Promise.all(background.splice(0));
		},
	};
};

/** Every value in a SQLite database, as text (for leak scans). */
export const dumpDatabase = (
	db: ReturnType<typeof createFakeStorage>["db"],
): string => {
	const tables = db.prepare(
		"SELECT name FROM sqlite_master WHERE type = 'table'",
	).all() as { name: string }[];
	return tables.map(({ name }) =>
		JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all())
	).join("\n");
};
