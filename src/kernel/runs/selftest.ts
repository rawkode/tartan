// The deploy warm-up (`POST /-/health/warm`): the `selftest` sandbox starts the
// container (so a cold start is paid before the first job), checks the runner
// image (git ≥ 2.38 with a real `merge-tree --write-tree`, pnpm on PATH, both
// users) and records what it found for `/-/health`. One start per 10 minutes:
// the endpoint is unauthenticated, so the limit is what keeps it from running
// up container cost. Kept in the `selftest` sandbox DO itself (a singleton by
// name), not ForgeDO.

import { withStartRetries } from "./jobs.ts";
import { safeText } from "./joblog.ts";

export const SELFTEST_INTERVAL_MS = 10 * 60 * 1000;
export const MIN_GIT = [2, 38] as const;

/** What the warm-up found (shown by `/-/health`). */
export type RunnerInfo = {
	readonly ok: boolean;
	readonly gitVersion: string | null;
	readonly pnpmVersion: string | null;
	readonly mergeTree: boolean;
	readonly users: boolean;
	/** `/etc/tartan-runner.json` written by the Dockerfile (base digest, pins). */
	readonly image: Readonly<Record<string, string>> | null;
	readonly checkedAt: number;
	readonly error?: string;
};

/** The shell script the selftest runs as root; one `key=value` per line. */
export const SELFTEST_SCRIPT = [
	"set +e",
	'echo "git=$(git --version | sed -n "s/^git version //p")"',
	'echo "pnpm=$(su -s /bin/sh tartan-git -c "pnpm --version" 2>/dev/null)"',
	"id tartan-git >/dev/null 2>&1 && id tartan-push >/dev/null 2>&1 && echo users=1 || echo users=0",
	'D=$(mktemp -d) && cd "$D" && git init -q -b main . && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m base && git checkout -q -b o && echo o > f && git add f && git -c user.name=t -c user.email=t@t commit -qm o && git checkout -q main && echo m > g && git add g && git -c user.name=t -c user.email=t@t commit -qm m && git merge-tree --write-tree main o >/dev/null && echo mergetree=1 || echo mergetree=0',
	'echo "image=$(base64 -w0 /etc/tartan-runner.json 2>/dev/null)"',
].join("\n");

/** `2.55.0` ≥ 2.38? */
export const gitAtLeast = (
	version: string | null,
	min: readonly [number, number] = MIN_GIT,
): boolean => {
	const m = /^(\d+)\.(\d+)/.exec(version ?? "");
	if (m === null) return false;
	const [major, minor] = [Number(m[1]), Number(m[2])];
	return major > min[0] || (major === min[0] && minor >= min[1]);
};

export const parseSelftest = (stdout: string, at: number): RunnerInfo => {
	const values = new Map(
		stdout.split("\n").map((line) => {
			const i = line.indexOf("=");
			return [line.slice(0, i), line.slice(i + 1).trim()] as const;
		}),
	);
	const text = (key: string): string | null => {
		const value = values.get(key);
		return value === undefined || value === "" ? null : value;
	};
	let image: Record<string, string> | null = null;
	const raw = text("image");
	if (raw !== null) {
		try {
			const parsed = JSON.parse(atob(raw)) as Record<string, unknown>;
			image = Object.fromEntries(
				Object.entries(parsed).map(([k, v]) => [k, String(v)]),
			);
		} catch {
			image = null;
		}
	}
	const gitVersion = text("git");
	const pnpmVersion = text("pnpm");
	const mergeTree = text("mergetree") === "1";
	const users = text("users") === "1";
	return {
		ok: gitAtLeast(gitVersion) && mergeTree && pnpmVersion !== null && users,
		gitVersion,
		pnpmVersion,
		mergeTree,
		users,
		image,
		checkedAt: at,
	};
};

export const createSelftest = (deps: {
	readonly sql: SqlStorage;
	readonly exec: (
		command: string,
	) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
	readonly destroy: () => Promise<void>;
	readonly now?: () => number;
	readonly sleep?: (ms: number) => Promise<void>;
}) => {
	const now = deps.now ?? (() => Date.now());
	deps.sql.exec(
		"CREATE TABLE IF NOT EXISTS job_state (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
	);
	const get = (key: string): string | null =>
		deps.sql.exec<{ v: string }>("SELECT v FROM job_state WHERE k = ?", key)
			.toArray()[0]?.v ?? null;
	const put = (key: string, value: string): void => {
		deps.sql.exec(
			"INSERT INTO job_state (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v",
			key,
			value,
		);
	};

	const last = (): RunnerInfo | null => {
		const raw = get("selftest:last");
		return raw === null ? null : JSON.parse(raw) as RunnerInfo;
	};

	const run = async (): Promise<
		RunnerInfo | { limited: true; retryAfterMs: number }
	> => {
		const started = Number(get("selftest:started") ?? "0");
		const at = now();
		if (at - started < SELFTEST_INTERVAL_MS) {
			const previous = last();
			if (previous !== null && previous.checkedAt >= started) return previous;
			return {
				limited: true,
				retryAfterMs: started + SELFTEST_INTERVAL_MS - at,
			};
		}
		put("selftest:started", String(at));
		let info: RunnerInfo;
		try {
			// A new app's first start may answer a 500 once: retry.
			const out = await withStartRetries(
				() => deps.exec(SELFTEST_SCRIPT),
				deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
			);
			info = parseSelftest(out.stdout, now());
		} catch (error) {
			info = {
				ok: false,
				gitVersion: null,
				pnpmVersion: null,
				mergeTree: false,
				users: false,
				image: null,
				checkedAt: now(),
				error: safeText(String(error), 500),
			};
		}
		put("selftest:last", JSON.stringify(info));
		await deps.destroy().catch(() => undefined);
		return info;
	};

	return { run, last };
};
