/// <reference types="@cloudflare/vitest-pool-workers/types" />
// WP6 in workerd: InboxDO over real DO RPC (deliver with dedupe
// and sanitizing, peek marks delivered highest severity first, read, ack,
// unread count, the `wait` long-poll woken by `deliver`) and, on a host with
// an injected RepoDO port, presence flushed at most once a minute.

import { runInDurableObject } from "cloudflare:test";
import {
	createUlid,
	fromRpcError,
	inboxDoName,
	type Notice,
	NOTICE_TEXT_MAX_BYTES,
} from "@tartan/contract";
import { describe, expect, it } from "vitest";
import { testEnv as env } from "../../../test/env.ts";
import { createDoHost } from "../../do/host.ts";
import { COMMON_MIGRATIONS } from "../../do/migrations.ts";
import {
	createInboxModule,
	FLUSH_TIMER_KEY,
	type InboxApi,
	PRESENCE_FLUSH_MS,
	type PresenceEntry,
} from "./module.ts";

const ulid = createUlid();
const REPO_A = ulid();
const REPO_B = ulid();
const LANE = `ln_${ulid()}`;

const freshInbox = () => {
	const principal = `a_${ulid()}`;
	const stub = env.INBOX.getByName(inboxDoName(principal));
	return { principal, stub, inbox: stub as unknown as InboxApi };
};

const notice = (
	text: string,
	extra: Partial<Parameters<InboxApi["deliver"]>[0]> = {},
): Parameters<InboxApi["deliver"]>[0] => ({
	kind: "conflict",
	severity: "info",
	text,
	source: "kernel",
	...extra,
});

describe("InboxDO notices", () => {
	it("dedupes, sanitizes and peeks highest severity first, marking delivered", async () => {
		const { inbox } = freshInbox();
		const a = await inbox.deliver(notice("low", { dedupeKey: "c:1:info" }));
		expect(a.created).toBe(true);
		expect(await inbox.deliver(notice("again", { dedupeKey: "c:1:info" })))
			.toEqual({ id: a.id, created: false });
		await inbox.deliver(
			notice("\u001b[31mred\u001b[0m alert\u0007", {
				severity: "critical",
				repoId: REPO_A,
				laneId: LANE,
				source: "i_x",
				sourceLabel: "radar\u0000",
			}),
		);
		await inbox.deliver(notice("x".repeat(3000), { severity: "warn" }));
		expect(await inbox.unreadCount()).toBe(3);
		const peeked = await inbox.peek(10, "mcp");
		expect(peeked.map((n) => n.severity)).toEqual(["critical", "warn", "info"]);
		// Control characters stripped on write; ≤ 1 KB.
		// deno-lint-ignore no-control-regex
		expect(peeked[0].text).not.toMatch(/[\u0000-\u001f\u007f]/);
		expect(peeked[0].text).toContain("red");
		expect(peeked[0].sourceLabel).toBe("radar");
		expect(new TextEncoder().encode(peeked[1].text).length)
			.toBeLessThanOrEqual(NOTICE_TEXT_MAX_BYTES);
		expect(peeked.every((n) => n.deliveredVia === "mcp")).toBe(true);
		expect(await inbox.unreadCount()).toBe(0);
		expect(await inbox.peek(10, "mcp")).toEqual([]);
		// read pages by seq and shows delivery state.
		const all = await inbox.read({ since: 0 });
		expect(all.map((n) => n.seq)).toEqual([1, 2, 3]);
		expect((await inbox.read({ since: 1, limit: 1 })).map((n) => n.seq))
			.toEqual([2]);
		expect((await inbox.read({ since: 0, repoId: REPO_B })).length).toBe(2);
		expect(await inbox.ack([a.id, "nope"])).toEqual({ acked: 1 });
		expect(await inbox.ack([a.id])).toEqual({ acked: 0 });
		expect((await inbox.read({ since: 0 }))[0].ackedAt).toBeTypeOf("number");
	});

	it("filters peek by repo (global notices always included)", async () => {
		const { inbox } = freshInbox();
		await inbox.deliver(notice("a", { repoId: REPO_A }));
		await inbox.deliver(notice("b", { repoId: REPO_B }));
		await inbox.deliver(notice("global"));
		const forA = await inbox.peek(10, "api", REPO_A);
		expect(forA.map((n) => n.text).sort()).toEqual(["a", "global"]);
		expect(await inbox.unreadCount()).toBe(1);
	});

	it("rejects malformed notices", async () => {
		const { inbox } = freshInbox();
		// RPC promises are proxies: settle them with `.catch` before asserting.
		const message = async (p: Promise<unknown>) =>
			fromRpcError(await p.then(() => null, (e: unknown) => e)).text;
		expect(
			await message(
				inbox.deliver({ ...notice("x"), kind: "bogus" as "message" }),
			),
		).toBe("invalid notice");
		expect(await message(inbox.deliver({ ...notice("x"), source: "" })))
			.toBe("notice source");
		expect(await message(inbox.peek(5, "carrier-pigeon" as "api"))).toBe(
			"delivery channel",
		);
	});
});

describe("inbox_wait long-poll", () => {
	it("wakes on deliver", async () => {
		const { inbox } = freshInbox();
		const started = Date.now();
		const waiting = inbox.wait(10_000, REPO_A);
		await new Promise((r) => setTimeout(r, 150));
		// A notice for another repo does not wake a repo-scoped waiter…
		await inbox.deliver(notice("other", { repoId: REPO_B }));
		await new Promise((r) => setTimeout(r, 100));
		// …one for its repo does.
		await inbox.deliver(notice("wake", { repoId: REPO_A, severity: "warn" }));
		const got: Notice[] = await waiting;
		const elapsed = Date.now() - started;
		expect(got.map((n) => n.text)).toEqual(["wake"]);
		expect(got[0].deliveredVia).toBe("mcp");
		expect(elapsed).toBeLessThan(2000);
	});

	it("returns at once when something is unread, and [] after the timeout", async () => {
		const { inbox } = freshInbox();
		await inbox.deliver(notice("ready"));
		const t0 = Date.now();
		expect((await inbox.wait(10_000)).map((n) => n.text)).toEqual(["ready"]);
		expect(Date.now() - t0).toBeLessThan(500);
		const t1 = Date.now();
		expect(await inbox.wait(200, undefined, "api")).toEqual([]);
		expect(Date.now() - t1).toBeGreaterThanOrEqual(190);
	});
});

describe("presence", () => {
	it("flushes changed rows to each repo's RepoDO at most once a minute", async () => {
		const { principal, stub } = freshInbox();
		await runInDurableObject(stub, async (_instance, state) => {
			const flushed: { repoId: string; entries: PresenceEntry[] }[] = [];
			let now = 1_000_000;
			const host = createDoHost({
				kind: "test",
				ctx: state,
				env,
				modules: {
					inbox: createInboxModule({
						flush: () => (repoId, entries) => {
							flushed.push({ repoId, entries });
							return Promise.resolve();
						},
						log: () => {},
					}),
				},
				common: [COMMON_MIGRATIONS.base],
				clock: { now: () => now },
			});
			await host.ready;
			const inbox = host.facade("inbox");
			await inbox.touch({ repoId: REPO_A, laneId: LANE, at: now });
			await inbox.touch({ repoId: REPO_B, status: "idle", at: now });
			expect(host.timers.get("inbox", FLUSH_TIMER_KEY)).toBe(now);
			await host.alarm();
			expect(flushed.map((f) => f.repoId).sort()).toEqual(
				[REPO_A, REPO_B].sort(),
			);
			expect(flushed.find((f) => f.repoId === REPO_A)?.entries).toEqual([
				{ principal, laneId: LANE, status: "active", at: now },
			]);
			expect(await inbox.presence(REPO_B)).toEqual({
				principal,
				status: "idle",
				lastSeenAt: now,
			});
			// The next touch waits for the minute to pass.
			now += 5_000;
			await inbox.touch({ repoId: REPO_A, at: now });
			expect(host.timers.get("inbox", FLUSH_TIMER_KEY)).toBe(
				now - 5_000 + PRESENCE_FLUSH_MS,
			);
			flushed.length = 0;
			now += PRESENCE_FLUSH_MS;
			await host.alarm();
			expect(flushed.map((f) => f.repoId)).toEqual([REPO_A]);
			// Nothing changed: no flush, no timer.
			expect(host.timers.get("inbox", FLUSH_TIMER_KEY)).toBeNull();
		});
	});

	it("keeps rows dirty and retries when RepoDO refuses", async () => {
		const { stub } = freshInbox();
		await runInDurableObject(stub, async (_instance, state) => {
			let fail = true;
			const sent: string[] = [];
			const now = 2_000_000;
			const host = createDoHost({
				kind: "test",
				ctx: state,
				env,
				modules: {
					inbox: createInboxModule({
						flush: () => (repoId) => {
							if (fail) return Promise.reject(new Error("not yet"));
							sent.push(repoId);
							return Promise.resolve();
						},
						log: () => {},
					}),
				},
				common: [COMMON_MIGRATIONS.base],
				clock: { now: () => now },
			});
			await host.ready;
			await host.facade("inbox").touch({ repoId: REPO_A, at: now });
			const [outcome] = await host.alarm();
			expect(outcome).toMatchObject({ module: "inbox", ok: false });
			fail = false;
			const retryAt = host.timers.get("inbox", FLUSH_TIMER_KEY);
			expect(retryAt).toBeGreaterThan(now);
		});
	});
});
