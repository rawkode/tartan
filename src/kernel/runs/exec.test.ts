import { deepEqual, equal, ok, rejects } from "node:assert/strict";
import { createMutex, createSerializedGitExec, type WarmPort } from "./exec.ts";
import { KILL_CONTENT_UID } from "./shell.ts";
import { LIVE_TOKEN } from "./testing/fakes.ts";

type Call = {
	command: string;
	env?: Record<string, string>;
	start: number;
	end: number;
};

/** A sandbox where each exec takes `ms` and a `pkill` kills running fetches. */
const warmPort = (ms = 15) => {
	const calls: Call[] = [];
	const running = new Set<Call>();
	const killed: string[] = [];
	let warmed = 0;
	let t = 0;
	const port: WarmPort = {
		warm: () => {
			warmed += 1;
			return Promise.resolve();
		},
		exec: async (command, options) => {
			const call: Call = {
				command,
				env: options?.env as Record<string, string>,
				start: t++,
				end: -1,
			};
			calls.push(call);
			if (command === KILL_CONTENT_UID) {
				for (const other of running) {
					if (other.command.includes("--reuid=tartan-git")) {
						killed.push(other.command);
					}
				}
			}
			running.add(call);
			await new Promise((r) => setTimeout(r, ms));
			running.delete(call);
			call.end = t++;
			return {
				exitCode: 0,
				stdout: command.includes("echo-token") ? `x ${LIVE_TOKEN}\n` : "ok\n",
				stderr: "",
			};
		},
	};
	return {
		port,
		calls,
		killed,
		get warmed() {
			return warmed;
		},
	};
};

Deno.test("a FIFO mutex runs one task at a time and survives a failure", async () => {
	const lock = createMutex();
	const order: string[] = [];
	const task = (name: string, fail = false) =>
		lock(async () => {
			order.push(`start ${name}`);
			await new Promise((r) => setTimeout(r, 5));
			order.push(`end ${name}`);
			if (fail) throw new Error(name);
		});
	const results = await Promise.allSettled([
		task("a"),
		task("b", true),
		task("c"),
	]);
	deepEqual(results.map((r) => r.status), [
		"fulfilled",
		"rejected",
		"fulfilled",
	]);
	deepEqual(order, [
		"start a",
		"end a",
		"start b",
		"end b",
		"start c",
		"end c",
	]);
});

Deno.test("two fetch-then-push jobs started together run one after the other; no fetch is killed", async () => {
	const box = warmPort();
	const exec = createSerializedGitExec({
		port: box.port,
		sleep: () => Promise.resolve(),
	});
	const job = (n: number) => ({
		fetch: exec.exec(["git", "fetch", "origin", `head${n}`], {
			env: { GIT_CONFIG_COUNT: "0" },
		}),
		push: exec.exec(["git", "push", "origin", `head${n}:refs/tartan/x${n}`], {
			uid: "tartan-push",
			env: { GIT_CONFIG_VALUE_0: `Authorization: Bearer ${LIVE_TOKEN}` },
		}),
	});
	const one = job(1);
	const two = job(2);
	await Promise.all([one.fetch, one.push, two.fetch, two.push]);
	// Strictly sequential: every call ends before the next starts.
	for (let i = 1; i < box.calls.length; i++) {
		ok(box.calls[i].start > box.calls[i - 1].end, "no overlap");
	}
	deepEqual(box.killed, [], "pkill never met a running fetch");
	deepEqual(
		box.calls.map((c) => c.command.split(" ").slice(0, 2).join(" ")),
		[
			"setpriv --reuid=tartan-git",
			"pkill -KILL",
			"setpriv --reuid=tartan-push",
			"setpriv --reuid=tartan-git",
			"pkill -KILL",
			"setpriv --reuid=tartan-push",
		],
	);
	equal(box.warmed, 1, "sleepAfter 10m set once");
	// The write token is only in the push exec's environment.
	const withToken = box.calls.filter((c) =>
		JSON.stringify(c.env ?? {}).includes(LIVE_TOKEN)
	);
	ok(withToken.every((c) => c.command.includes("--reuid=tartan-push")));
	equal(withToken.length, 2);
});

Deno.test("stdin travels base64 in one env var; output is redacted; bad input is refused", async () => {
	const box = warmPort(0);
	const exec = createSerializedGitExec({ port: box.port });
	const result = await exec.exec([
		"git",
		"hash-object",
		"--stdin",
		"echo-token",
	], {
		stdin: "héllo\n",
		cwd: "/srv/git/r",
	});
	equal(result.exitCode, 0);
	equal(result.stdout.includes("expires="), false);
	ok(result.stdout.includes("art_v2_<redacted>"));
	const call = box.calls.at(-1)!;
	ok(
		call.command.startsWith(
			'printf %s "$TARTAN_STDIN_B64" | base64 -d | setpriv',
		),
	);
	equal(
		new TextDecoder().decode(
			Uint8Array.from(atob(call.env!.TARTAN_STDIN_B64), (c) => c.charCodeAt(0)),
		),
		"héllo\n",
	);
	equal(call.env!.HOME, "/home/tartan-git");
	await rejects(exec.exec([]), /argv required/);
	await rejects(
		exec.exec(["id"], { uid: "root" as "tartan-git" }),
		/unknown uid/,
	);
});
