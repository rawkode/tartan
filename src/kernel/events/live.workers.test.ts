/// <reference types="@cloudflare/vitest-pool-workers/types" />
// WP6 in workerd: the `/-/live` feed inside a real RepoDO (hibernatable
// WebSocket accepted by the `events` module through the module fetch seam):
// hello, replay after `since`, coalesced frames, reconnect with `since`, the
// `gap` frame past `LIVE_REPLAY_MAX`, shadow exclusion, ping.

import {
	type AppendInput,
	createUlid,
	LIVE_REPLAY_MAX,
	type LiveFrame,
	repoDoName,
} from "@tartan/contract";
import { moduleRequest } from "@tartan/contract/kernel.ts";
import { describe, expect, it } from "vitest";
import { testEnv as env } from "../../../test/env.ts";
import { LIVE_ROLE_HEADER } from "./live.ts";

const ulid = createUlid();
const USER = `u_${ulid()}`;
const INST = `i_${ulid()}`;

let n = 0;
const event = (repo: string, shadow = false): AppendInput => ({
	type: "x.acme.radar.ping",
	source: { kind: "installation", id: INST, ext: "acme.radar@1.0.0" },
	actor: { kind: "user", id: USER },
	node: repo,
	depth: 0,
	shadow,
	data: { n },
	idemKey: `${INST}:live${n++}:x.acme.radar.ping:0`,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Client = {
	frames: LiveFrame[];
	ws: WebSocket;
	seqs(): number[];
	until(pred: (frames: LiveFrame[]) => boolean, ms?: number): Promise<void>;
};

const connect = async (
	repoId: string,
	query: string,
	headers: Record<string, string> = {
		upgrade: "websocket",
		[LIVE_ROLE_HEADER]: "20",
	},
): Promise<Client | Response> => {
	const stub = env.REPO.getByName(repoDoName(repoId));
	const res = await stub.fetch(
		moduleRequest(
			"events",
			new Request(`https://forge.test/-/live${query}`, { headers }),
		),
	);
	if (res.webSocket === null) return res;
	const ws = res.webSocket;
	const frames: LiveFrame[] = [];
	ws.addEventListener("message", (e) => {
		frames.push(JSON.parse(e.data as string) as LiveFrame);
	});
	ws.accept();
	return {
		frames,
		ws,
		seqs: () =>
			frames.flatMap((f) => f.t === "events" ? f.events.map((e) => e.seq) : []),
		until: async (pred, ms = 2000) => {
			const started = Date.now();
			while (!pred(frames)) {
				if (Date.now() - started > ms) throw new Error("timed out");
				await sleep(20);
			}
		},
	};
};

const asClient = (value: Client | Response): Client => {
	if (value instanceof Response) {
		throw new Error(`upgrade refused: ${value.status}`);
	}
	return value;
};

describe("/-/live in RepoDO", () => {
	it("says hello, then streams coalesced frames without shadow events", async () => {
		const repoId = ulid();
		const stub = env.REPO.getByName(repoDoName(repoId));
		const client = asClient(await connect(repoId, "?since=0"));
		await client.until((f) => f.length >= 1);
		// The DO knows its repo from its name (`repo:<id>`).
		expect(client.frames[0]).toEqual({ t: "hello", repo: repoId, head: 0 });
		await stub.events().append(event(repoId));
		await stub.events().append(event(repoId, true));
		await stub.events().append(event(repoId));
		await client.until(() => client.seqs().length >= 2);
		expect(client.seqs()).toEqual([1, 3]);
		const frames = client.frames.filter((f) => f.t === "events");
		// Three appends in one tick: one coalesced frame.
		expect(frames.length).toBe(1);
		expect(frames[0]).toMatchObject({ head: 3 });
		client.ws.send("ping");
		await client.until((f) => f.some((x) => x.t === "ping"));
		client.ws.close(1000, "done");
	});

	it("replays after `since` on reconnect and never repeats a frame", async () => {
		const repoId = ulid();
		const stub = env.REPO.getByName(repoDoName(repoId));
		for (let i = 0; i < 5; i++) await stub.events().append(event(repoId));
		const client = asClient(await connect(repoId, "?since=2"));
		await client.until(() => client.seqs().length >= 3);
		expect(client.frames[0]).toEqual({ t: "hello", repo: repoId, head: 5 });
		expect(client.seqs()).toEqual([3, 4, 5]);
		await stub.events().append(event(repoId));
		await client.until(() => client.seqs().length >= 4);
		await sleep(300);
		expect(client.seqs()).toEqual([3, 4, 5, 6]);
		client.ws.close(1000, "done");

		// No `since`: start at the head, nothing replayed.
		const fresh = asClient(await connect(repoId, ""));
		await client.until(() => fresh.frames.length >= 1);
		await sleep(100);
		expect(fresh.frames).toEqual([{ t: "hello", repo: repoId, head: 6 }]);
		fresh.ws.close(1000, "done");
	});

	it(`sends a gap frame when more than ${LIVE_REPLAY_MAX} events were missed`, async () => {
		const repoId = ulid();
		const stub = env.REPO.getByName(repoDoName(repoId));
		await Promise.all(
			Array.from({ length: 603 }, () => stub.events().append(event(repoId))),
		);
		const client = asClient(await connect(repoId, "?since=0"));
		await client.until(() => client.seqs().length >= LIVE_REPLAY_MAX);
		expect(client.frames[1]).toEqual({ t: "gap", from: 1, to: 103 });
		expect(client.seqs()[0]).toBe(104);
		expect(client.seqs().at(-1)).toBe(603);
		client.ws.close(1000, "done");
	});

	it("refuses requests that are not a well-formed forwarded upgrade", async () => {
		const repoId = ulid();
		const noUpgrade = await connect(repoId, "?since=0", {
			[LIVE_ROLE_HEADER]: "20",
		});
		expect((noUpgrade as Response).status).toBe(426);
		const noRole = await connect(repoId, "?since=0", { upgrade: "websocket" });
		expect((noRole as Response).status).toBe(400);
		const badSince = await connect(repoId, "?since=-1", {
			upgrade: "websocket",
			[LIVE_ROLE_HEADER]: "20",
		});
		expect((badSince as Response).status).toBe(400);
	});
});
