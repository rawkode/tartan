// Stock git end to end through gitproto (the fail-closed cases). A local `git
// http-backend` plays upstream; the harness interceptor plays the gateway with
// gitproto's parsers, rewriters, synthesizer and relay.

import { equal, ok } from "node:assert/strict";
import {
	createReceivePackRelay,
	MAX_COMMANDS,
	negotiateCaps,
	parseUploadRequest,
	peekCommands,
	PUBLIC_VIEW_PROFILE,
	RECEIVE_PACK_CAPABILITIES,
	RELAY_HOLD_BACK_MAX_BYTES,
	rewriteAdvertisement,
	rewriteLsRefsResponse,
	rewriteV2Capabilities,
	synthReportStatus,
	UPLOAD_DECODE_MAX_BYTES,
	UPLOAD_PACK_V0_CAPABILITIES,
	UPLOAD_PACK_V2_CAPABILITIES,
} from "../src/index.ts";
import {
	commitFile,
	git,
	type GitServer,
	hasGit,
	initBare,
	initWork,
	type InterceptRequest,
	revParse,
	type Sandbox,
	withGitServer,
} from "./harness/git.ts";
import { chunked, readAll } from "./helpers.ts";

const ESC_LINE =
	"tartan \x1b[31m▸\x1b[0m main is woven by Tartan\x1b]0;owned\x07; nobody pushes it directly.";
const GUIDE =
	"  push your lane:  git push origin HEAD:refs/heads/lanes/ln_01k6x";

const receiveAd = async (
	request: InterceptRequest,
	names: readonly string[],
) => {
	const upstream = await request.backend();
	const body = rewriteAdvertisement(
		new Uint8Array(await upstream.arrayBuffer()),
		{
			service: "git-receive-pack",
			keepRef: () => true,
			capabilities: { protocol: "v0", names },
		},
	);
	return new Response(body, { status: 200, headers: upstream.headers });
};

const RESULT_TYPE = {
	"content-type": "application/x-git-receive-pack-result",
	"cache-control": "no-cache",
};

/** The gateway's rejection path: peek, then a synthesized report (nothing forwarded). */
const rejectAll =
	(names: readonly string[], forwarded: { count: number }) =>
	async (request: InterceptRequest): Promise<Response | undefined> => {
		if (
			request.op === "info/refs" && request.query.includes("git-receive-pack")
		) {
			return await receiveAd(request, names);
		}
		if (request.op !== "git-receive-pack") return undefined;
		const peeked = await peekCommands(chunked(request.body), {
			maxCommands: MAX_COMMANDS.agent,
			maxSectionBytes: 64 * 1024,
			capabilities: names,
		});
		if (peeked.kind === "probe") {
			forwarded.count++;
			return await request.backend();
		}
		if (peeked.kind === "rejected") {
			return new Response("bad request", { status: 400 });
		}
		const caps = negotiateCaps(peeked.capabilities);
		const body = synthReportStatus(
			{
				unpack: "ok",
				refs: peeked.commands.map((command, index) => ({
					ref: command.ref,
					ok: false as const,
					reason: index === 0
						? "woven-by-tartan"
						: "atomic: another ref was rejected",
				})),
			},
			caps,
			[ESC_LINE, GUIDE],
		);
		return new Response(body, { status: 200, headers: RESULT_TYPE });
	};

const setup = async (sandbox: Sandbox, server: GitServer) => {
	const bare = await initBare(sandbox, "repo");
	const work = await initWork(sandbox, "work", 1);
	const url = `${server.url}/repo.git`;
	await git(sandbox, ["push", "-q", url, "main"], { cwd: work });
	await commitFile(sandbox, work, "next.txt", "next\n");
	return { bare, work, url };
};

/** The client-side caps matrix stock git can select for receive-pack. */
const MATRIX: { names: readonly string[]; flags: string[]; expect: string }[] =
	[
		{
			names: RECEIVE_PACK_CAPABILITIES,
			flags: ["-q"],
			expect: "report-status-v2/side-band-64k/quiet",
		},
		{
			names: RECEIVE_PACK_CAPABILITIES,
			flags: ["--progress"],
			expect: "report-status-v2/side-band-64k",
		},
		{
			names: RECEIVE_PACK_CAPABILITIES.filter((n) => n !== "report-status-v2"),
			flags: ["-q"],
			expect: "report-status/side-band-64k/quiet",
		},
		{
			names: RECEIVE_PACK_CAPABILITIES.filter((n) => n !== "side-band-64k"),
			flags: [],
			expect: "report-status-v2/none/quiet",
		},
		{
			names: RECEIVE_PACK_CAPABILITIES.filter((n) =>
				n !== "side-band-64k" && n !== "report-status-v2"
			),
			flags: ["--progress"],
			expect: "report-status/none",
		},
		{
			names: RECEIVE_PACK_CAPABILITIES.filter((n) =>
				n !== "side-band-64k" && n !== "report-status-v2" && n !== "quiet"
			),
			flags: [],
			expect: "report-status/none (no quiet advertised)",
		},
	];

Deno.test({
	name:
		"stock git parses synthesized rejections across the caps matrix (porcelain and human)",
	ignore: !hasGit,
	fn: () =>
		withGitServer(async (sandbox, server) => {
			const { bare, work, url } = await setup(sandbox, server);
			const before = await revParse(sandbox, bare, "refs/heads/main");
			for (const { names, flags, expect } of MATRIX) {
				const forwarded = { count: 0 };
				server.setIntercept(rejectAll(names, forwarded));
				const start = server.requests.length;
				const human = await git(sandbox, [
					"push",
					...flags,
					url,
					"main",
					"HEAD:refs/heads/feat",
				], {
					cwd: work,
					allowFail: true,
				});
				equal(human.code, 1, expect);
				ok(
					human.stderr.includes(
						"! [remote rejected] main -> main (woven-by-tartan)",
					),
					`${expect}: ${human.stderr}`,
				);
				ok(
					human.stderr.includes(
						"! [remote rejected] HEAD -> feat (atomic: another ref was rejected)",
					),
					expect,
				);
				ok(
					!human.stderr.includes("\x1b"),
					`${expect}: no ESC reaches the terminal`,
				);
				const sideBand = names.includes("side-band-64k");
				ok(
					human.stderr.includes(
						"remote: tartan [31m▸[0m main is woven by Tartan]0;owned; nobody pushes it directly.",
					) === sideBand,
					`${expect}: band-2 lines ${
						sideBand ? "shown" : "absent"
					}\n${human.stderr}`,
				);
				ok(human.stderr.includes(`remote: ${GUIDE}`) === sideBand, expect);
				const porcelain = await git(sandbox, [
					"push",
					"--porcelain",
					...flags,
					url,
					"main",
				], {
					cwd: work,
					allowFail: true,
				});
				equal(porcelain.code, 1, expect);
				ok(
					porcelain.text.includes(
						"!\trefs/heads/main:refs/heads/main\t[remote rejected] (woven-by-tartan)",
					),
					`${expect}: ${porcelain.text}`,
				);
				// What the client selected matches the advertisement we served.
				const post = server.requests.slice(start).find((r) =>
					r.method === "POST" && r.body.length > 4
				);
				const selected = new TextDecoder().decode(post!.body);
				ok(
					selected.includes("report-status-v2") ===
						names.includes("report-status-v2"),
					expect,
				);
				equal(forwarded.count, 0, "nothing reached upstream");
			}
			equal(
				await revParse(sandbox, bare, "refs/heads/main"),
				before,
				"upstream unchanged",
			);
		}),
});

Deno.test({
	name:
		"stock git through the relay: report parsed, sanitized echo lines shown, push lands",
	ignore: !hasGit,
	fn: () =>
		withGitServer(async (sandbox, server) => {
			const { bare, work, url } = await setup(sandbox, server);
			const reports: unknown[] = [];
			server.setIntercept(async (request) => {
				if (
					request.op === "info/refs" &&
					request.query.includes("git-receive-pack")
				) {
					return await receiveAd(request, RECEIVE_PACK_CAPABILITIES);
				}
				if (request.op !== "git-receive-pack") return undefined;
				const peeked = await peekCommands(chunked(request.body, 100), {
					maxCommands: MAX_COMMANDS.user,
					maxSectionBytes: 64 * 1024,
					capabilities: RECEIVE_PACK_CAPABILITIES,
				});
				if (peeked.kind !== "commands") return await request.backend();
				const caps = negotiateCaps(peeked.capabilities);
				const forwardedBody = await readAll(peeked.body);
				const upstream = await request.backend();
				ok(forwardedBody.length === request.body.length);
				const relay = createReceivePackRelay({
					caps,
					holdBackMaxBytes: RELAY_HOLD_BACK_MAX_BYTES,
				});
				const out = upstream.body!.pipeThrough(relay.stream);
				relay.report.then((report) => {
					reports.push(report);
					relay.release([
						"[radar] \x1b[1mpaths overlap\x1b[0m ln_01k6y: src/api.ts",
					]);
				});
				return new Response(out, {
					status: upstream.status,
					headers: upstream.headers,
				});
			});
			const pushed = await git(sandbox, ["push", url, "main"], {
				cwd: work,
				allowFail: true,
			});
			equal(pushed.code, 0, pushed.stderr);
			ok(
				pushed.stderr.includes(
					"remote: [radar] [1mpaths overlap[0m ln_01k6y: src/api.ts",
				),
				pushed.stderr,
			);
			ok(!pushed.stderr.includes("\x1b"));
			equal(reports.length, 1);
			equal(
				await revParse(sandbox, bare, "refs/heads/main"),
				await revParse(sandbox, work, "HEAD"),
			);
		}),
});

Deno.test({
	name:
		"stock git clones and fetches through the rewritten advertisements and the public-view parser",
	ignore: !hasGit,
	fn: () =>
		withGitServer(async (sandbox, server) => {
			const { work, url } = await setup(sandbox, server);
			await git(sandbox, [
				"push",
				"-q",
				url,
				"main",
				"HEAD:refs/heads/lanes/ln_01k6hidden",
				"HEAD:refs/tartan/attic/x",
			], {
				cwd: work,
			});
			const visible = (ref: string) =>
				!ref.startsWith("refs/heads/lanes/") && !ref.startsWith("refs/tartan/");
			const rejections: string[] = [];
			server.setIntercept(async (request) => {
				const v2 = (request.headers.get("git-protocol") ?? "").includes(
					"version=2",
				);
				if (
					request.op === "info/refs" &&
					request.query.includes("git-upload-pack")
				) {
					const upstream = await request.backend();
					const raw = new Uint8Array(await upstream.arrayBuffer());
					const body = v2
						? rewriteV2Capabilities(raw, {
							protocol: "v2",
							commands: UPLOAD_PACK_V2_CAPABILITIES,
						})
						: rewriteAdvertisement(raw, {
							service: "git-upload-pack",
							keepRef: visible,
							capabilities: {
								protocol: "v0",
								names: UPLOAD_PACK_V0_CAPABILITIES,
							},
						});
					return new Response(body, { status: 200, headers: upstream.headers });
				}
				if (request.op !== "git-upload-pack") return undefined;
				const parsed = await parseUploadRequest(chunked(request.body, 512), {
					encoding: request.headers.get("content-encoding"),
					gitProtocol: request.headers.get("git-protocol"),
					maxDecodedBytes: UPLOAD_DECODE_MAX_BYTES,
					profile: PUBLIC_VIEW_PROFILE,
				});
				if (parsed.kind === "rejected") {
					rejections.push(parsed.code);
					return new Response(`ERR ${parsed.reason}`, { status: 403 });
				}
				// Forward the decoded (identity) body, as the gateway does for the public view.
				const headers = new Headers(request.headers);
				headers.delete("content-encoding");
				const upstream = await request.backend({ headers, body: parsed.body });
				if (parsed.command === "ls-refs") {
					const raw = new Uint8Array(await upstream.arrayBuffer());
					return new Response(rewriteLsRefsResponse(raw, visible), {
						status: 200,
						headers: upstream.headers,
					});
				}
				return upstream;
			});
			for (const version of ["2", "0", "1"]) {
				const dir = `${sandbox.root}/clone-${version}`;
				await git(sandbox, [
					"-c",
					`protocol.version=${version}`,
					"clone",
					"-q",
					"--no-tags",
					url,
					dir,
				]);
				const remoteRefs = await git(sandbox, [
					"-c",
					`protocol.version=${version}`,
					"ls-remote",
					url,
				]);
				ok(
					!remoteRefs.text.includes("lanes/") &&
						!remoteRefs.text.includes("refs/tartan"),
					remoteRefs.text,
				);
				ok(remoteRefs.text.includes("refs/heads/main"));
				// Many local commits and no known common commit (no tracking ref,
				// no tags) make the next fetch send enough haves to be gzipped.
				for (let i = 0; i < 60; i++) {
					await commitFile(sandbox, dir, `l${i}`, `${version}-${i}\n`);
				}
				await git(sandbox, ["update-ref", "-d", "refs/remotes/origin/main"], {
					cwd: dir,
				});
				await commitFile(sandbox, work, `up-${version}`, "u\n");
				await git(sandbox, ["push", "-q", url, "main"], { cwd: work });
				await git(sandbox, [
					"-c",
					`protocol.version=${version}`,
					"fetch",
					"-q",
					"--no-tags",
					"origin",
				], {
					cwd: dir,
				});
				equal(
					await revParse(sandbox, dir, "origin/main"),
					await revParse(sandbox, work, "HEAD"),
				);
			}
			const gzipped = server.requests.filter((r) =>
				r.headers["content-encoding"] === "gzip"
			);
			ok(gzipped.length > 0, "a gzip-encoded fetch went through the parser");
			equal(rejections.length, 0, rejections.join(","));
		}),
});
