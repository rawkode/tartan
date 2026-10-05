// The lane handle's git commands work verbatim (WP11) for both
// backends: `lanes_open` answers through the MCP host, and the `git.start` /
// `git.push` strings it returns run unchanged in a shell against a local
// smart-HTTP server with the gateway's URL shapes (`git http-backend` behind a
// CGI bridge): a `repo` lane fetches `main` of its lane remote and pushes
// `HEAD:refs/heads/main` to it; a `branch` lane uses `origin` and
// `refs/heads/lanes/<id>`. WP4's gateway is not merged: this proves the
// commands, not the gateway's policy.

import { equal, ok } from "node:assert/strict";
import { createUlid, type Lane, LaneSchema } from "@tartan/contract";
import {
	git,
	hasGit,
	initBare,
	makeSandbox,
	revParse,
	type Sandbox,
} from "../../../packages/gitproto/test/harness/git.ts";
import { createMcpFixture, handleOf } from "./testing/fixture.ts";

const ulid = createUlid();
const decoder = new TextDecoder();

/** `/acme/shop.git/<op>` → `canonical.git`; `/acme/shop/-/lanes/<id>.git/<op>` → `lane-<id>.git`. */
const ROUTE =
	/^\/acme\/shop(?:\/-\/lanes\/(ln_[0-9a-z]{26}))?\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

const serveGateway = (sandbox: Sandbox) =>
	Deno.serve(
		{ hostname: "127.0.0.1", port: 0, onListen: () => {} },
		async (req) => {
			const url = new URL(req.url);
			const match = ROUTE.exec(url.pathname);
			if (match === null) return new Response("not found", { status: 404 });
			const repo = match[1] ? `lane-${match[1]}` : "canonical";
			const body = new Uint8Array(await req.arrayBuffer());
			const env: Record<string, string> = {
				PATH: sandbox.env.PATH,
				HOME: sandbox.root,
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: sandbox.env.GIT_CONFIG_GLOBAL,
				GIT_PROJECT_ROOT: `${sandbox.root}/srv`,
				GIT_HTTP_EXPORT_ALL: "1",
				PATH_INFO: `/${repo}.git/${match[2]}`,
				QUERY_STRING: url.search.replace(/^\?/, ""),
				REQUEST_METHOD: req.method,
				CONTENT_TYPE: req.headers.get("content-type") ?? "",
				REMOTE_USER: "agent",
				REMOTE_ADDR: "127.0.0.1",
				...(req.method === "POST"
					? { CONTENT_LENGTH: String(body.length) }
					: {}),
				...(req.headers.get("git-protocol")
					? { GIT_PROTOCOL: req.headers.get("git-protocol")! }
					: {}),
				...(req.headers.get("content-encoding")
					? { HTTP_CONTENT_ENCODING: req.headers.get("content-encoding")! }
					: {}),
			};
			const child = new Deno.Command("git", {
				args: ["http-backend"],
				env,
				clearEnv: true,
				stdin: "piped",
				stdout: "piped",
				stderr: "piped",
			}).spawn();
			const writer = child.stdin.getWriter();
			await writer.write(body);
			await writer.close();
			const out = await child.output();
			const raw = out.stdout;
			const split = decoder.decode(raw).indexOf("\r\n\r\n");
			let status = 200;
			const headers = new Headers();
			for (const line of decoder.decode(raw.subarray(0, split)).split("\r\n")) {
				const colon = line.indexOf(":");
				if (colon < 0) continue;
				const key = line.slice(0, colon).trim();
				const value = line.slice(colon + 1).trim();
				if (key.toLowerCase() === "status") status = parseInt(value, 10);
				else headers.set(key, value);
			}
			return new Response(raw.slice(split + 4), { status, headers });
		},
	);

const sh = async (sandbox: Sandbox, cwd: string, command: string) => {
	const out = await new Deno.Command("sh", {
		args: ["-c", command],
		cwd,
		env: sandbox.env,
		clearEnv: true,
		stdout: "piped",
		stderr: "piped",
	}).output();
	equal(out.code, 0, `${command}: ${decoder.decode(out.stderr)}`);
};

const laneOf = (repoId: string, extra: Partial<Lane>): Lane =>
	LaneSchema.parse({
		repoId,
		kind: "lane",
		owner: "a_00000000000000000000000000",
		delegates: [],
		footprint: { projects: [], prefixes: [] },
		state: "open",
		quarantined: false,
		leaseExpiresAt: 1_900_000_000_000,
		pushes: 0,
		createdAt: 0,
		...extra,
	});

Deno.test({
	name:
		"git.start and git.push of an MCP lane handle work verbatim for a repo lane and a branch lane",
	ignore: !hasGit,
	fn: async () => {
		const sandbox = await makeSandbox();
		const server = serveGateway(sandbox);
		const origin = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
		try {
			// Trunk in the canonical repo; a lane repo seeded at the same base.
			const canonical = await initBare(sandbox, "canonical");
			const seed = `${sandbox.root}/seed`;
			await git(sandbox, ["init", "-q", "--initial-branch=main", seed]);
			await Deno.writeTextFile(`${seed}/README.md`, "# shop\n");
			await git(sandbox, ["add", "README.md"], { cwd: seed });
			await git(sandbox, ["commit", "-q", "-m", "trunk"], { cwd: seed });
			const base = await revParse(sandbox, seed, "HEAD");
			await git(sandbox, ["push", "-q", canonical, "main"], { cwd: seed });
			const repoLaneId = `ln_${ulid()}`;
			const laneRepo = await initBare(sandbox, `lane-${repoLaneId}`);
			await git(sandbox, ["push", "-q", laneRepo, "main"], { cwd: seed });
			const branchLaneId = `ln_${ulid()}`;

			const fx = createMcpFixture();
			fx.forge.setOrigin(origin);
			const repoLane = laneOf(fx.router, {
				id: repoLaneId,
				mode: "repo",
				seed: "import",
				ref: "refs/heads/main",
				branch: `lanes/${repoLaneId}`,
				base,
				head: base,
				remote: `/acme/shop/-/lanes/${repoLaneId}.git`,
			});
			const branchLane = laneOf(fx.router, {
				id: branchLaneId,
				mode: "branch",
				ref: `refs/heads/lanes/${branchLaneId}`,
				branch: `lanes/${branchLaneId}`,
				base,
				remote: "/acme/shop.git",
			});
			const queue = [repoLane, branchLane];
			fx.forge.setRepo(fx.router, {
				core: {
					openLane: () => Promise.resolve(queue.shift()!),
					awaitLane: (id: string) =>
						Promise.resolve(id === repoLaneId ? repoLane : branchLane),
				} as never,
			});
			const session = await fx.open(fx.claude, "rawkode/platform/router");
			const open = async () =>
				handleOf(
					await fx.call(session, "lanes_open", {
						repo: "rawkode/platform/router",
						purpose: "change",
					}),
				);
			const repoHandle = await open();
			const branchHandle = await open();
			equal(repoHandle.remote, `${origin}/acme/shop/-/lanes/${repoLaneId}.git`);
			equal(branchHandle.remote, `${origin}/acme/shop.git`);

			// An agent clones trunk from the repo's git URL, then follows each handle.
			const work = `${sandbox.root}/agent`;
			await git(sandbox, ["clone", "-q", `${origin}/acme/shop.git`, work]);

			await sh(sandbox, work, repoHandle.git!.start);
			await Deno.writeTextFile(`${work}/repo-lane.txt`, "repo lane\n");
			await git(sandbox, ["add", "repo-lane.txt"], { cwd: work });
			await git(sandbox, ["commit", "-q", "-m", "repo lane work"], {
				cwd: work,
			});
			const repoHead = await revParse(sandbox, work, "HEAD");
			await sh(sandbox, work, repoHandle.git!.push);
			equal(await revParse(sandbox, laneRepo, "refs/heads/main"), repoHead);

			await sh(sandbox, work, branchHandle.git!.start);
			equal(await revParse(sandbox, work, "HEAD"), base, "starts at the base");
			await Deno.writeTextFile(`${work}/branch-lane.txt`, "branch lane\n");
			await git(sandbox, ["add", "branch-lane.txt"], { cwd: work });
			await git(sandbox, ["commit", "-q", "-m", "branch lane work"], {
				cwd: work,
			});
			const branchHead = await revParse(sandbox, work, "HEAD");
			await sh(sandbox, work, branchHandle.git!.push);
			equal(
				await revParse(sandbox, canonical, `refs/heads/lanes/${branchLaneId}`),
				branchHead,
			);
			equal(
				await revParse(sandbox, canonical, "refs/heads/main"),
				base,
				"trunk untouched",
			);
			ok(true);
		} finally {
			await server.shutdown();
			await sandbox.cleanup();
		}
	},
});
