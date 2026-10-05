// Test-only: a stand-in for WP4's capability route that
// FakeArtifacts' `import()` pulls through, so the seeder's tests run the
// whole import path against RepoDO's REAL capability state. It checks the
// path's syntax, TTL and MAC in the "isolate" before any RepoDO call, then
// `capUse`, then synthesizes `HEAD` → `refs/heads/main` at the attempt's base
// (never the upstream ref names), compares the upstream tip with the base
// (503 + `capReport(trunk-moved)` unless explained and pinned), accepts
// exactly one `want` = base, serves the pack from the canonical repo's
// objects and reports `served` with its size. Never imported by runtime
// code; the real route is WP4's.

import {
	CAP_PATH_PREFIX,
	parseCapPath,
	repoArtifactsName,
} from "@tartan/contract";
import type { CapMac, RepoCoreFacade } from "@tartan/contract/kernel.ts";
import {
	concat,
	type FakeArtifacts,
	flushPkt,
	type GitObject,
	parsePkts,
	pkt,
	pktText,
	reachableObjects,
	writePack,
} from "@tartan/testkit";
import { LANE_CAP_TTL_S } from "../../../../../constants.ts";

export type CapRouteLog = {
	readonly method: string;
	readonly op: string;
	readonly status: number;
	/** The DO was called for this request. */
	readonly reachedDo: boolean;
};

export type TestCapRoute = {
	(request: Request): Promise<Response>;
	readonly requests: CapRouteLog[];
	/** Every request answers 404 before the DO while set (zone security blocking /-/cap/*). */
	blocked: boolean;
	/** Overrides the upstream default-branch tip the route reads (trunk moved). */
	upstreamTip: string | null | (() => string | null);
	/** Holds the NEXT pack response until it resolves (an import in flight); consumed by one request. */
	holdNext: Promise<void> | null;
	/** Pack requests parked on `holdNext` right now. */
	held: number;
};

const plain = (status: number) =>
	new Response(null, { status, headers: { "cache-control": "no-store" } });

const CAPS =
	"multi_ack thin-pack side-band side-band-64k ofs-delta shallow no-progress include-tag";

export const createTestCapRoute = (deps: {
	readonly capMac: CapMac;
	readonly fake: FakeArtifacts;
	/** RepoDO core of a repo id (the repo the path names). */
	core(repoId: string): Pick<RepoCoreFacade, "capUse" | "capReport">;
	now(): number;
}): TestCapRoute => {
	const requests: CapRouteLog[] = [];
	const route = (async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		const log = (op: string, status: number, reachedDo: boolean) => {
			requests.push({ method: request.method, op, status, reachedDo });
		};
		if (route.blocked || !url.pathname.startsWith(CAP_PATH_PREFIX)) {
			log("blocked", 404, false);
			return plain(404);
		}
		const parts = parseCapPath(url.pathname);
		const nowS = Math.floor(deps.now() / 1000);
		if (
			parts === null || parts.exp <= nowS ||
			parts.exp > nowS + LANE_CAP_TTL_S + 5 ||
			!(await deps.capMac.verify(parts, parts.mac))
		) {
			log(parts?.op ?? "syntax", 404, false);
			return plain(404);
		}
		const core = deps.core(parts.repoId);
		if (parts.op === "info/refs") {
			if (
				request.method !== "GET" ||
				url.searchParams.get("service") !== "git-upload-pack"
			) {
				log("info", 404, false);
				return plain(404);
			}
			const use = await core.capUse(parts.laneId, parts.nonce, "info");
			if (!use.ok) {
				log("info", 404, true);
				return plain(404);
			}
			const base = use.ctx.base;
			const canonical = repoArtifactsName(parts.repoId);
			const override = typeof route.upstreamTip === "function"
				? route.upstreamTip()
				: route.upstreamTip;
			const tip = override ??
				deps.fake.inspect.refs(canonical)[
					`refs/heads/${use.ctx.defaultBranch}`
				] ??
				null;
			if (
				tip !== base &&
				!(use.ctx.pinBase && tip !== null &&
					use.ctx.explainedTips.includes(tip))
			) {
				await core.capReport(parts.laneId, parts.nonce, {
					op: "info",
					outcome: "trunk-moved",
					...(tip !== null ? { upstreamTip: tip } : {}),
				});
				log("info", 503, true);
				return plain(503);
			}
			const body = concat([
				pkt("# service=git-upload-pack\n"),
				flushPkt(),
				pkt(`${base} HEAD\0${CAPS} symref=HEAD:refs/heads/main agent=tartan\n`),
				pkt(`${base} refs/heads/main\n`),
				flushPkt(),
			]);
			log("info", 200, true);
			return new Response(body, {
				headers: {
					"content-type": "application/x-git-upload-pack-advertisement",
					"cache-control": "no-store",
				},
			});
		}
		if (request.method !== "POST") {
			log("pack", 404, false);
			return plain(404);
		}
		const use = await core.capUse(parts.laneId, parts.nonce, "pack");
		if (!use.ok) {
			log("pack", 404, true);
			return plain(404);
		}
		const raw = new Uint8Array(await request.arrayBuffer());
		const lines = parsePkts(raw, 0).pkts.map(pktText).filter((t) =>
			t !== null
		) as string[];
		const wants = lines.filter((l) => l.startsWith("want "));
		const refused = wants.length !== 1 ||
			wants[0].split(" ")[1]?.trim() !== use.ctx.base ||
			lines.some((l) =>
				l.startsWith("have ") || l.startsWith("shallow ") ||
				l.startsWith("deepen")
			);
		if (refused) {
			log("pack", 400, true);
			return plain(400);
		}
		const hold = route.holdNext;
		if (hold !== null) {
			route.holdNext = null;
			route.held++;
			await hold;
			route.held--;
		}
		const store = deps.fake.inspect.store(repoArtifactsName(parts.repoId));
		const { oids } = reachableObjects(store, [use.ctx.base]);
		const pack = writePack(
			oids.map((oid) => store.get(oid)).filter((o): o is GitObject =>
				o !== undefined
			),
		);
		await core.capReport(parts.laneId, parts.nonce, {
			op: "pack",
			bytes: pack.length,
			outcome: "served",
		});
		log("pack", 200, true);
		return new Response(concat([pkt("NAK\n"), pack]), {
			headers: {
				"content-type": "application/x-git-upload-pack-result",
				"cache-control": "no-store",
			},
		});
	}) as TestCapRoute;
	Object.assign(route, {
		requests,
		blocked: false,
		upstreamTip: null,
		holdNext: null,
		held: 0,
	});
	return route;
};
