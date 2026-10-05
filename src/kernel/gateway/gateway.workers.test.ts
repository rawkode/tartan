/// <reference types="@cloudflare/vitest-pool-workers/types" />
// The gateway in workerd (vitest project `gateway`): the stream
// machinery the Deno suites cannot vouch for (FixedLengthStream, the tee and
// the held-back flush, DecompressionStream for gzip public-view requests), a
// real RepoDO over RPC (WP5a's core, WP6's event log, the pool's
// FakeArtifacts for upstream tokens), and the git routes through the route
// table.

import { createExecutionContext } from "cloudflare:test";
import {
	repoArtifactsName,
	repoDoName,
	ROLE,
	ulid,
	ZERO_SHA,
} from "@tartan/contract";
import {
	demuxSideband,
	encodePktLine,
	encodeSpecialPkt,
	negotiateCaps,
	parseReportStatus,
	synthReportStatus,
} from "@tartan/gitproto";
import type { RepoEventsFacade } from "@tartan/contract/kernel.ts";
import { afterAll, describe, expect, it } from "vitest";
import { settleBackground, testEnv as env } from "../../../test/env.ts";
import { createRouter, ROUTES, type SecurityMiddleware } from "../../router.ts";
import { createGatewayDeps } from "./deps.ts";
import { handleReceivePack } from "./receive.ts";
import {
	authOf,
	createUnitWorld,
	repoNode,
	scriptedUpstream,
	sha,
	type UnitWorld,
} from "./testing/fakes.ts";
import type { GatewayRepo } from "./types.ts";
import { handleUploadPack } from "./upload.ts";

const CAPS = "report-status side-band-64k agent=git/2.55.0";

/** A smart-HTTP body as text (`Response.text()` warns on its content type). */
const textOf = async (response: Response): Promise<string> =>
	new TextDecoder().decode(await response.arrayBuffer());

const concat = (parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
};

const pushBody = (ref: string, old: string, next: string, pack: Uint8Array) =>
	concat([
		encodePktLine(`${old} ${next} ${ref}\0${CAPS}\n`),
		encodeSpecialPkt("flush"),
		pack,
	]);

const okAnswer = (ref: string) => () =>
	new Response(
		synthReportStatus(
			{ unpack: "ok", refs: [{ ref, ok: true }] },
			negotiateCaps(CAPS.split(" ")),
		),
	);

const parse = async (response: Response) => {
	const bytes = new Uint8Array(await response.arrayBuffer());
	const demuxed = demuxSideband(bytes);
	return {
		flushed: demuxed.flushed,
		...parseReportStatus(demuxed.band1, negotiateCaps(CAPS.split(" "))),
	};
};

const push = (
	w: UnitWorld,
	body: Uint8Array<ArrayBuffer>,
	auth = authOf(),
) =>
	handleReceivePack(
		w.deps(),
		w.request("POST", "git-receive-pack", {
			auth,
			body,
			headers: {
				"content-type": "application/x-git-receive-pack-request",
				"content-length": String(body.length),
			},
		}),
	);

// The ForgeDO's first boot (isForgeOwner) and RepoDO's event pokes run in
// the background of these tests.
afterAll(() => settleBackground());

describe("gateway streams in workerd", () => {
	it("an accepted push is forwarded byte for byte (FixedLengthStream), relayed, and recorded before the final flush", async () => {
		const w = createUnitWorld();
		w.upstream = scriptedUpstream(okAnswer("refs/heads/feat"));
		const pack = new Uint8Array(3 * 1024 * 1024).fill(7);
		const body = pushBody("refs/heads/feat", ZERO_SHA, sha(1), pack);
		const release = w.repo.holdRecord();
		const response = await push(w, body);
		let finished = false;
		const result = parse(response).then((r) => {
			finished = true;
			return r;
		});
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(finished).toBe(false);
		release();
		const parsed = await result;
		expect(parsed.flushed).toBe(true);
		expect(parsed.refs).toEqual([{ ref: "refs/heads/feat", ok: true }]);
		expect(w.upstream.calls[0].bodyBytes).toBe(body.length);
		await w.settle();
		expect(w.repo.pushes).toHaveLength(1);
		expect(w.repo.pushes[0].bytes).toBe(body.length);
		expect(w.repo.diffs).toHaveLength(1);
	});

	it("a client that cancels mid-relay leaves the push recorded", async () => {
		const w = createUnitWorld();
		let finish!: () => void;
		const finished = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const report = synthReportStatus(
			{ unpack: "ok", refs: [{ ref: "refs/heads/feat", ok: true }] },
			negotiateCaps(CAPS.split(" ")),
		);
		w.upstream = scriptedUpstream(() =>
			new Response(
				new ReadableStream<Uint8Array>({
					async start(controller) {
						controller.enqueue(
							encodePktLine(
								new Uint8Array([2, ...new TextEncoder().encode("progress\n")]),
							),
						);
						await finished;
						controller.enqueue(report);
						controller.close();
					},
				}),
			)
		);
		const response = await push(
			w,
			pushBody("refs/heads/feat", ZERO_SHA, sha(1), new Uint8Array(10)),
		);
		const reader = response.body!.getReader();
		await reader.read();
		await reader.cancel();
		finish();
		await w.settle();
		expect(w.repo.pushes.map((p) => p.refs[0].ref)).toEqual([
			"refs/heads/feat",
		]);
	});

	it("an agent's push to main is a synthesized ng; nothing is forwarded", async () => {
		const w = createUnitWorld();
		const agent = authOf({
			kind: "agent",
			via: "agent-token",
			principal: `a_${ulid()}`,
		});
		w.repo.context = {
			ownLanes: [{
				laneId: `ln_${ulid()}`,
				mode: "branch",
				ref: "refs/heads/lanes/x",
				state: "open",
				headSha: null,
				resumable: true,
				leased: false,
			}],
		};
		const parsed = await parse(
			await push(
				w,
				pushBody("refs/heads/main", sha(0), sha(1), new Uint8Array(10)),
				agent,
			),
		);
		expect(parsed.refs).toEqual([
			{ ref: "refs/heads/main", ok: false, reason: "woven-by-tartan" },
		]);
		expect(w.upstream.calls).toHaveLength(0);
		await w.settle();
		expect(w.repo.rejections.map((r) => r.reason)).toEqual(["woven-by-tartan"]);
	});

	it("a gzip-encoded anonymous want of a hidden SHA is refused after decoding; a gzip bomb is 415", async () => {
		const w = createUnitWorld();
		w.node = repoNode({ visibility: "public" });
		const request = concat([
			encodePktLine("command=fetch\n"),
			encodePktLine("agent=git/2.55.0\n"),
			encodeSpecialPkt("delim"),
			encodePktLine(`want ${sha(9)}\n`),
			encodePktLine("done\n"),
			encodeSpecialPkt("flush"),
		]);
		const gzip = async (bytes: Uint8Array<ArrayBuffer>) =>
			new Uint8Array(
				await new Response(
					new Response(bytes).body!.pipeThrough(new CompressionStream("gzip")),
				).arrayBuffer(),
			);
		const call = async (body: Uint8Array) =>
			await handleUploadPack(
				w.deps(),
				w.request("POST", "git-upload-pack", {
					auth: null,
					body: body as Uint8Array<ArrayBuffer>,
					headers: {
						"git-protocol": "version=2",
						"content-encoding": "gzip",
					},
				}),
			);
		const refused = await call(await gzip(request));
		expect(refused.status).toBe(200);
		expect(await textOf(refused)).toContain("ERR want-not-advertised");
		const bomb = await call(await gzip(new Uint8Array(16 * 1024 * 1024)));
		expect(bomb.status).toBe(415);
		await bomb.body?.cancel();
		expect(w.upstream.calls).toHaveLength(0);
	});
});

describe("gateway with a real RepoDO over RPC", () => {
	const setup = async () => {
		const repoId = ulid();
		await env.ARTIFACTS.create(repoArtifactsName(repoId));
		const core = env.REPO.getByName(repoDoName(repoId)).core();
		const trunk = sha(1);
		await core.init({
			repoId,
			nodeId: repoId,
			path: "acme/shop",
			defaultBranch: "main",
			refs: { "refs/heads/main": trunk },
		});
		const w = createUnitWorld();
		w.node = repoNode({ id: repoId });
		const repo = core as unknown as GatewayRepo;
		w.deps = ((base) => () => ({ ...base(), repo: () => repo }))(w.deps);
		return { w, repoId, trunk, core };
	};

	it("pushContext and recordRejection over RPC: an agent without a branch lane gets agents-lanes-only and no write token", async () => {
		const { w, core } = await setup();
		const agent = authOf({
			kind: "agent",
			via: "agent-token",
			principal: `a_${ulid()}`,
		});
		w.roles.set(agent.principal, ROLE.developer);
		const parsed = await parse(
			await push(
				w,
				pushBody("refs/heads/main", sha(1), sha(2), new Uint8Array(10)),
				agent,
			),
		);
		expect(parsed.refs).toEqual([
			{ ref: "refs/heads/main", ok: false, reason: "agents-lanes-only" },
		]);
		expect(w.upstream.calls).toHaveLength(0);
		await w.settle();
		const log = env.REPO.getByName(repoDoName(w.node.id))
			.events() as unknown as RepoEventsFacade;
		const events = await log.read({ since: 0 });
		expect(events.map((e) => e.type)).toContain("push.rejected");
		expect(await core.refs()).toEqual([
			expect.objectContaining({ ref: "refs/heads/main", sha: sha(1) }),
		]);
	});

	it("readContext('anon') over RPC drives the public-view want check", async () => {
		const { w, trunk } = await setup();
		w.node = { ...w.node, visibility: "public" };
		w.upstream = scriptedUpstream(() => new Response("0008NAK\n"));
		const fetchWant = (want: string) =>
			handleUploadPack(
				w.deps(),
				w.request("POST", "git-upload-pack", {
					auth: null,
					body: concat([
						encodePktLine(`want ${want} side-band-64k\n`),
						encodeSpecialPkt("flush"),
						encodePktLine("done\n"),
					]),
				}),
			);
		const allowed = await fetchWant(trunk);
		expect(await textOf(allowed)).toBe("0008NAK\n");
		const refused = await fetchWant(sha(5));
		expect(await textOf(refused)).toContain("ERR want-not-advertised");
		expect(w.upstream.calls).toHaveLength(1);
		// The upstream read token came from the pool's FakeArtifacts via RepoDO.
		expect(w.upstream.calls[0].headers.get("authorization")).toMatch(
			/^Bearer /,
		);
	});
});

describe("the production ports", () => {
	it("phase 2 reaches the real RepoProbe through the loopback exports", async () => {
		const deps = createGatewayDeps(env, createExecutionContext());
		// An uninitialized repo: RepoProbe answers (WP5a's not_found), which
		// proves the call left the gateway and reached the entrypoint.
		const error = await deps.probe().laneDiff({ repoId: ulid() }, sha(1))
			.then(() => null, (e: unknown) => e);
		expect(error).not.toBeNull();
		expect(String((error as Error).message)).toMatch(/not_found/);
	});

	it("isForgeOwner asks WP2's identity on ForgeDO", async () => {
		const deps = createGatewayDeps(env, createExecutionContext());
		// No claimed Owner in this pool: a principal is never the forge Owner.
		expect(await deps.isForgeOwner(`u_${ulid()}`)).toBe(false);
	});
});

describe("git routes through the route table", () => {
	const passThrough: SecurityMiddleware = (_c, next) => next(null);
	const router = createRouter(ROUTES, passThrough);
	const call = (method: string, path: string, init: RequestInit = {}) =>
		router(
			new Request(`https://tartan.test${path}`, { method, ...init }),
			env,
			createExecutionContext(),
		);

	it("anonymous receive-pack is 401 with the Basic challenge, before any lookup", async () => {
		for (
			const [method, path] of [
				["GET", "/acme/shop.git/info/refs?service=git-receive-pack"],
				["GET", "/acme/shop/info/refs?service=git-receive-pack"],
				["POST", "/acme/shop.git/git-receive-pack"],
			] as const
		) {
			const response = await call(method, path, {
				...(method === "POST" ? { body: "0000" } : {}),
			});
			expect(response.status).toBe(401);
			expect(response.headers.get("www-authenticate")).toMatch(
				/^Basic realm=/,
			);
			await response.body?.cancel();
		}
	});

	it("lane remotes answer anonymous callers 401 on every op, before any lookup", async () => {
		const lane = `ln_${ulid().toLowerCase()}`;
		for (
			const [method, op] of [
				["GET", "info/refs?service=git-upload-pack"],
				["GET", "info/refs?service=git-receive-pack"],
				["POST", "git-upload-pack"],
				["POST", "git-receive-pack"],
			] as const
		) {
			const response = await call(
				method,
				`/acme/shop/-/lanes/${lane}.git/${op}`,
				method === "POST" ? { body: "0000" } : {},
			);
			expect(response.status).toBe(401);
			expect(response.headers.get("www-authenticate")).toMatch(
				/^Basic realm=/,
			);
			await response.body?.cancel();
		}
	});

	it("the capability route answers malformed, expired and other-op paths a plain 404 without a body", async () => {
		const lane = `ln_${ulid().toLowerCase()}`;
		const repo = ulid().toLowerCase();
		const expired = `/-/cap/v1/1790000000/${lane}/${"0".repeat(32)}/${
			"ab".repeat(32)
		}/${repo}.git`;
		for (
			const [method, path] of [
				["GET", `${expired}/info/refs?service=git-upload-pack`],
				["POST", `${expired}/git-upload-pack`],
				["POST", `${expired}/git-receive-pack`],
				["GET", `${expired}/HEAD`],
				["GET", "/-/cap/v1/garbage"],
			] as const
		) {
			const response = await call(
				method,
				path,
				method === "POST" ? { body: "0000" } : {},
			);
			expect(response.status).toBe(404);
			expect(await response.text()).toBe("");
		}
	});
});
