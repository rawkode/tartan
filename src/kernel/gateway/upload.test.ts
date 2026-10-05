// Access decisions and upload-pack rewriting against a scripted upstream: who
// gets 401, 403, 404, the member view or the public view; the Artifacts-shaped
// v2 advertisement rewritten to the allowlist; member `ls-refs` answers
// filtered to the member's view.

import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { ROLE } from "@tartan/contract";
import { encodePktLine, encodeSpecialPkt } from "@tartan/gitproto";
import { resolveAccess } from "./access.ts";
import {
	authOf,
	createUnitWorld,
	LANE,
	repoNode,
	scriptedUpstream,
	sha,
} from "./testing/fakes.ts";
import { handleInfoRefs, handleUploadPack } from "./upload.ts";

const concat = (parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
};
const pkt = (line: string) => encodePktLine(`${line}\n`);
const FLUSH = encodeSpecialPkt("flush");

Deno.test("access: 401 for anonymous callers, 404 for roleless ones, 403 for Guests and narrow tokens; the views", async () => {
	const w = createUnitWorld();
	const decide = async (
		auth: ReturnType<typeof authOf> | null,
		service: "git-upload-pack" | "git-receive-pack",
	) => {
		const result = await resolveAccess(
			w.deps().tree,
			w.request("GET", `info/refs?service=${service}`, { auth }),
			service,
		);
		return result.kind === "ok" ? result.view : result.response.status;
	};
	// Private repo.
	equal(await decide(null, "git-upload-pack"), 401);
	equal(await decide(null, "git-receive-pack"), 401);
	// (`w.request` gives an unknown principal Developer; set roles first.)
	const stranger = authOf();
	w.roles.set(stranger.principal, 0);
	equal(await decide(stranger, "git-upload-pack"), 404);
	equal(await decide(stranger, "git-receive-pack"), 404);
	const guest = authOf();
	w.roles.set(guest.principal, ROLE.guest);
	equal(await decide(guest, "git-upload-pack"), 403);
	const reporter = authOf();
	w.roles.set(reporter.principal, ROLE.reporter);
	equal(await decide(reporter, "git-upload-pack"), "member");
	equal(await decide(reporter, "git-receive-pack"), 403);
	const dev = authOf();
	w.roles.set(dev.principal, ROLE.developer);
	equal(await decide(dev, "git-receive-pack"), "member");
	// A token without repo:read sees no code; without lanes/repo:write no push.
	const mcpOnly = authOf({ scopes: ["mcp"] });
	w.roles.set(mcpOnly.principal, ROLE.owner);
	equal(await decide(mcpOnly, "git-upload-pack"), 403);
	equal(await decide(mcpOnly, "git-receive-pack"), 403);
	// A token whose node subtree does not cover the repo has no role here.
	const elsewhere = authOf({ nodeId: "01k7zzzzzzzzzzzzzzzzzzzzzz" });
	w.roles.set(elsewhere.principal, ROLE.owner);
	equal(await decide(elsewhere, "git-upload-pack"), 404);
	// A role ceiling below Developer.
	const capped = authOf({ maxRole: ROLE.reporter });
	w.roles.set(capped.principal, ROLE.owner);
	equal(await decide(capped, "git-receive-pack"), 403);
	// A lane-pinned token is Reporter at most off its lane: it reads, and
	// receive-pack is decided at its pin.
	const pinned = authOf({ kind: "agent", via: "agent-token", laneId: LANE });
	w.roles.set(pinned.principal, ROLE.developer);
	equal(await decide(pinned, "git-upload-pack"), "member");
	equal(await decide(pinned, "git-receive-pack"), "member");

	// Public repo: everyone who is not a member gets the public view.
	w.node = repoNode({ visibility: "public" });
	equal(await decide(null, "git-upload-pack"), "public");
	equal(await decide(stranger, "git-upload-pack"), "public");
	equal(await decide(guest, "git-upload-pack"), "public");
	equal(await decide(mcpOnly, "git-upload-pack"), "public");
	equal(await decide(elsewhere, "git-upload-pack"), "public");
	equal(await decide(reporter, "git-upload-pack"), "member");
	equal(await decide(null, "git-receive-pack"), 401);
	equal(await decide(stranger, "git-receive-pack"), 403);

	// Internal repo: any signed-in caller is a Reporter; anonymous is 401.
	w.node = repoNode({ visibility: "internal" });
	equal(await decide(null, "git-upload-pack"), 401);
	equal(await decide(stranger, "git-upload-pack"), "member");
	equal(await decide(stranger, "git-receive-pack"), 403);
	// …but not through a token scoped to another subtree.
	equal(await decide(elsewhere, "git-upload-pack"), 404);
});

Deno.test("access: unknown paths, non-repo nodes and redirects", async () => {
	const w = createUnitWorld();
	const dev = authOf();
	const tree = w.deps().tree;
	const missing = await resolveAccess(
		{ ...tree, resolvePath: () => Promise.resolve(null) },
		w.request("GET", "info/refs", { auth: dev }),
		"git-upload-pack",
	);
	equal(missing.kind === "response" && missing.response.status, 404);
	const group = await resolveAccess(
		{
			...tree,
			resolvePath: () =>
				Promise.resolve({ node: repoNode({ kind: "group" }), rest: "" }),
		},
		w.request("GET", "info/refs", { auth: dev }),
		"git-upload-pack",
	);
	equal(group.kind === "response" && group.response.status, 404);
	const deeper = await resolveAccess(
		{
			...tree,
			resolvePath: () => Promise.resolve({ node: repoNode(), rest: "x" }),
		},
		w.request("GET", "info/refs", { auth: dev }),
		"git-upload-pack",
	);
	equal(deeper.kind === "response" && deeper.response.status, 404);
	const movedTo = (visibility: "private" | "public") => ({
		...tree,
		resolvePath: () =>
			Promise.resolve({
				node: repoNode({ visibility }),
				rest: "",
				redirectTo: "acme/new",
			}),
	});
	const redirect = async (
		visibility: "private" | "public",
		auth: ReturnType<typeof authOf> | null,
	) => {
		const result = await resolveAccess(
			movedTo(visibility),
			w.request("GET", "info/refs?service=git-upload-pack", { auth }),
			"git-upload-pack",
		);
		ok(result.kind === "response");
		return result.response;
	};
	const moved = await redirect("private", dev);
	equal(moved.status, 301);
	equal(
		moved.headers.get("location"),
		"/acme/new.git/info/refs?service=git-upload-pack",
	);
	equal((await redirect("public", null)).status, 301);
	// A moved private repo's new path is never shown to a caller it would
	// not admit: the answer of a missing repo instead.
	equal((await redirect("private", null)).status, 401);
	const stranger = authOf();
	w.roles.set(stranger.principal, 0);
	const hidden = await redirect("private", stranger);
	equal(hidden.status, 404);
	equal(hidden.headers.get("location"), null);
});

Deno.test("dumb HTTP (no service) is refused", async () => {
	const w = createUnitWorld();
	const response = await handleInfoRefs(
		w.deps(),
		w.request("GET", "info/refs", { auth: authOf() }),
	);
	equal(response.status, 403);
	await response.body?.cancel();
	equal(w.upstream.calls.length, 0);
});

Deno.test("the Artifacts-shaped v2 advertisement is rewritten to the allowlist for every caller", async () => {
	const advert = concat([
		pkt("# service=git-upload-pack"),
		FLUSH,
		pkt("version 2"),
		pkt("agent=artifacts/1.0"),
		pkt("ls-refs=unborn"),
		pkt("fetch=shallow wait-for-done filter sideband-all packfile-uris"),
		pkt("server-option"),
		pkt("object-format=sha1"),
		pkt("object-info"),
		pkt("bundle-uri"),
		pkt("session-id=abc"),
		pkt("frobnicate=1"),
		FLUSH,
	]);
	for (const visibility of ["private", "public"] as const) {
		const w = createUnitWorld();
		w.node = repoNode({ visibility });
		w.upstream = scriptedUpstream(() => new Response(advert));
		const response = await handleInfoRefs(
			w.deps(),
			w.request("GET", "info/refs?service=git-upload-pack", {
				auth: visibility === "public" ? null : authOf(),
				headers: { "git-protocol": "version=2" },
			}),
		);
		equal(response.status, 200);
		equal(
			response.headers.get("content-type"),
			"application/x-git-upload-pack-advertisement",
		);
		const text = await response.text();
		ok(text.includes("ls-refs=unborn"), text);
		ok(text.includes("fetch=shallow filter"), text);
		for (
			const banned of [
				"sideband-all",
				"packfile-uris",
				"wait-for-done",
				"server-option",
				"object-info",
				"bundle-uri",
				"session-id",
				"frobnicate",
			]
		) {
			ok(!text.includes(banned), `${banned} (${visibility})`);
		}
		// The client's credential never reaches upstream; the git protocol does.
		const [call] = w.upstream.calls;
		match(call.headers.get("authorization") ?? "", /^Bearer art_v2_/);
		equal(call.headers.get("git-protocol"), "version=2");
	}
});

Deno.test("an upstream advertisement that does not parse, or a 5xx, is a 502", async () => {
	for (
		const answer of [
			() => new Response("garbage"),
			() => new Response("", { status: 503 }),
			() => Promise.reject(new Error("down")),
		]
	) {
		const w = createUnitWorld();
		w.upstream = scriptedUpstream(answer);
		const response = await handleInfoRefs(
			w.deps(),
			w.request("GET", "info/refs?service=git-upload-pack", {
				auth: authOf(),
			}),
		);
		equal(response.status, 502);
		await response.body?.cancel();
		ok(w.logs.length > 0);
	}
});

const lsRefsAnswer = () =>
	new Response(concat([
		pkt(`${sha(0)} HEAD symref-target:refs/heads/main`),
		pkt(`${sha(0)} refs/heads/main`),
		pkt(`${sha(1)} refs/heads/lanes/${LANE}`),
		pkt(`${sha(2)} refs/heads/lanes/ln_01k7zzzzzzzzzzzzzzzzzzzzzz`),
		pkt(`${sha(3)} refs/tartan/changes/c1`),
		pkt(`${sha(4)} refs/tags/v1`),
		FLUSH,
	]));

const lsRefsRequest = (prefixes: readonly string[]) =>
	concat([
		pkt("command=ls-refs"),
		pkt("agent=git/2.55.0"),
		encodeSpecialPkt("delim"),
		pkt("symrefs"),
		...prefixes.map((p) => pkt(`ref-prefix ${p}`)),
		FLUSH,
	]);

const refsOf = (text: string): string[] =>
	text.split("\n").map((line) => line.slice(4).split(" ")[1]).filter((r) =>
		r !== undefined
	);

Deno.test("member ls-refs: own lanes always, other hidden refs only under a requested hidden prefix", async () => {
	const run = async (
		prefixes: readonly string[],
		ownLane: boolean,
		gzip = false,
	) => {
		const w = createUnitWorld();
		w.upstream = scriptedUpstream(lsRefsAnswer);
		w.repo.read = {
			ownLanes: ownLane
				? [{ laneId: LANE, ref: `refs/heads/lanes/${LANE}`, headSha: sha(1) }]
				: [],
		};
		let body: Uint8Array<ArrayBuffer> = lsRefsRequest(prefixes);
		if (gzip) {
			body = new Uint8Array(
				await new Response(
					new Response(body).body!.pipeThrough(new CompressionStream("gzip")),
				).arrayBuffer(),
			);
		}
		const response = await handleUploadPack(
			w.deps(),
			w.request("POST", "git-upload-pack", {
				auth: authOf(),
				body,
				headers: {
					"git-protocol": "version=2",
					...(gzip ? { "content-encoding": "gzip" } : {}),
				},
			}),
		);
		// Member requests are forwarded as sent (gzip included).
		if (gzip) {
			equal(w.upstream.calls[0].headers.get("content-encoding"), "gzip");
		}
		return refsOf(await response.text());
	};
	deepStrictEqual(await run(["refs/heads/"], false), [
		"HEAD",
		"refs/heads/main",
		"refs/tags/v1",
	]);
	deepStrictEqual(await run(["refs/heads/"], true), [
		"HEAD",
		"refs/heads/main",
		`refs/heads/lanes/${LANE}`,
		"refs/tags/v1",
	]);
	// (The scripted upstream ignores `ref-prefix`; the gateway's filter is
	// what is checked.)
	deepStrictEqual(await run(["refs/heads/lanes/"], false), [
		"HEAD",
		"refs/heads/main",
		`refs/heads/lanes/${LANE}`,
		"refs/heads/lanes/ln_01k7zzzzzzzzzzzzzzzzzzzzzz",
		"refs/tags/v1",
	]);
	deepStrictEqual(await run(["refs/tartan/"], false, true), [
		"HEAD",
		"refs/heads/main",
		"refs/tartan/changes/c1",
		"refs/tags/v1",
	]);
});

Deno.test("public ls-refs: hidden prefixes return nothing; the body is forwarded decoded", async () => {
	const w = createUnitWorld();
	w.node = repoNode({ visibility: "public" });
	w.upstream = scriptedUpstream(lsRefsAnswer);
	const response = await handleUploadPack(
		w.deps(),
		w.request("POST", "git-upload-pack", {
			auth: null,
			body: lsRefsRequest(["refs/heads/lanes/", "refs/tartan/"]),
			headers: { "git-protocol": "version=2" },
		}),
	);
	deepStrictEqual(refsOf(await response.text()), [
		"HEAD",
		"refs/heads/main",
		"refs/tags/v1",
	]);
	equal(w.upstream.calls[0].headers.get("content-encoding"), null);
});
