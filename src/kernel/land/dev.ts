// `/-/dev/land/<repoId>/<op>` (WP10 live acceptance, `scripts/live/wp10-land.ts`):
// dev stages with dev tools only (`TARTAN_STAGE` ^dev and `TARTAN_DEV_TOOLS=1`)
// and a caller holding the dev key (`hex(HMAC-SHA256(TARTAN_SECRET,
// "tartan:dev:land"))`); anyone else gets a plain 404. It stands in for the
// pieces a land needs that other work packages build (repo create: WP3;
// pushes through the gateway: WP4; the changes and review providers:
// WP12/WP14) so the real Advance can be exercised against real Artifacts and
// a real runner container:
//
//   POST setup    {path?} → Artifacts repo, RepoDO init, genesis (on `main`)
//   POST lane     {owner, files, message?} → a branch lane with one commit,
//                 pushed by the kernel's ref-only client and recorded as the
//                 owner's push (phase 1)
//   POST submit   {lanes, testPolicy?, batchId?} → changes.submitted and an
//                 auto approval per lane (installation-sourced), then
//                 `land.submit` (K4 runs as for any provider)
//   POST archive  {laneId, atticRef} → `archiveLane` (attic ref in the Worker)
//   POST gc       → `gcLanes` one day ahead (branch-lane refs deleted by the
//                 in-Worker `refWrite`)
//   GET  status?batch=<id>  → the batch
//   GET  verify   → a stock `git clone` of the canonical repo in the runner,
//                 `git log --notes=tartan` and the change refs (the read
//                 token stays in the kernel: K11)
//
// No Artifacts token is ever returned.

import {
	changeIdFromBytes,
	changeRef,
	CHANGES_PREFIX,
	gitSandboxName,
	httpStatus,
	invalid,
	isIdOf,
	isUlid,
	NOTES_REF,
	notFound,
	repoArtifactsName,
	repoDoName,
	toWire,
	trunkRef,
	ulid,
	ZERO_SHA,
} from "@tartan/contract";
import {
	isRepoStoreError,
	type RepoCoreFacade,
	type RepoEventsFacade,
} from "@tartan/contract/kernel.ts";
import {
	encodeCommit,
	encodeTree,
	type PackObject,
	writePack,
} from "@tartan/gitproto";
import type { Env } from "../../env.ts";
import type { RouteContext, RouteHandler } from "../../router.ts";
import { gitAuthEnv } from "../runs/shell.ts";
import { createKernelGitJobsFor } from "./gitjobs.ts";
import type { LandFacade } from "./types.ts";
import { createCanonicalAccess } from "./upstream.ts";

const DEV_KEY_LABEL = "tartan:dev:land";
/** The dev route's repos land on `main`. */
const DEV_BRANCH = "main";
/** The installations the dev route speaks for (fixed, never real). */
export const DEV_CHANGES_INST = "i_01k6devc000000000000000000";
export const DEV_REVIEW_INST = "i_01k6devr000000000000000000";
export const DEV_QUEUE_INST = "i_01k6devq000000000000000000";

const encoder = new TextEncoder();
const hex = (buffer: ArrayBuffer): string =>
	[...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0"))
		.join("");

/** `hex(HMAC-SHA256(secret, "tartan:dev:land"))`. */
export const devLandKey = async (secret: string): Promise<string> => {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return hex(
		await crypto.subtle.sign("HMAC", key, encoder.encode(DEV_KEY_LABEL)),
	);
};

const constantTimeEqual = (a: string, b: string): boolean => {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
};

const devToolsEnabled = (env: Env): boolean =>
	/^dev/.test(env.TARTAN_STAGE) && env.TARTAN_DEV_TOOLS === "1";

const hasDevKey = async (c: RouteContext): Promise<boolean> => {
	const given = c.req.headers.get("x-tartan-dev-key");
	const secret = c.env.TARTAN_SECRET;
	if (!devToolsEnabled(c.env) || given === null || !secret) return false;
	return constantTimeEqual(given, await devLandKey(secret));
};

const json = (body: unknown, status = 200) =>
	Response.json(body, { status, headers: { "cache-control": "no-store" } });

const readJson = async (req: Request): Promise<Record<string, unknown>> => {
	try {
		const body = await req.json();
		return typeof body === "object" && body !== null
			? body as Record<string, unknown>
			: {};
	} catch {
		throw invalid("the body must be JSON");
	}
};

const repoOf = (env: Env, repoId: string) => {
	const stub = env.REPO.getByName(repoDoName(repoId));
	return {
		core: stub.core() as unknown as RepoCoreFacade,
		land: stub.land() as unknown as LandFacade,
		events: stub.events() as unknown as RepoEventsFacade,
	};
};

const setup = async (c: RouteContext, repoId: string) => {
	const body = await readJson(c.req);
	const defaultBranch = DEV_BRANCH;
	const name = repoArtifactsName(repoId);
	try {
		await c.env.ARTIFACTS.create(name, { setDefaultBranch: defaultBranch });
	} catch (error) {
		if (!isRepoStoreError(error, "ALREADY_EXISTS")) throw error;
	}
	const { core } = repoOf(c.env, repoId);
	// Idempotent for the same repo (WP5a). `core.info()` is not used: it reads
	// the repo node from WP3's tree.
	await core.init({
		repoId,
		nodeId: repoId,
		path: typeof body.path === "string" ? body.path : `dev/${repoId}`,
		defaultBranch,
	});
	const { commit } = await createKernelGitJobsFor(c.env, c.ctx).genesis(
		repoId,
		{
			defaultBranch,
			message: "Initial commit",
			author: { name: "Tartan", email: "tartan@kernel.invalid" },
		},
	);
	return { repoId, trunk: commit };
};

const lane = async (c: RouteContext, repoId: string) => {
	const body = await readJson(c.req);
	const owner = body.owner;
	if (typeof owner !== "string" || !isIdOf("agent", owner)) {
		throw invalid("owner is an agent id");
	}
	const files = body.files as Record<string, unknown> | undefined;
	if (typeof files !== "object" || files === null) {
		throw invalid("files is {name: content}");
	}
	const names = Object.keys(files);
	if (
		names.length === 0 || names.length > 20 ||
		names.some((n) => !/^[A-Za-z0-9._-]{1,100}$/.test(n) || n === ".git") ||
		Object.values(files).some((v) => typeof v !== "string" || v.length > 65536)
	) {
		throw invalid("1–20 top-level files, ≤ 64 KiB each");
	}
	const { core } = repoOf(c.env, repoId);
	const trunk = await core.resolveRef(trunkRef(DEV_BRANCH));
	if (trunk === null) throw invalid("the repo has no trunk");
	const parent = typeof body.parent === "string" ? body.parent : trunk;
	const opened = await core.openLane({
		owner,
		actor: { kind: "agent", id: owner },
	});
	const repo = await c.env.ARTIFACTS.get(repoArtifactsName(repoId));
	const base = await repo.readCommit(parent);
	if (base === null) throw notFound(`no commit ${parent}`);
	const entries = (await repo.readTree(base.treeHash)) ?? [];
	const blobs: PackObject[] = names.map((n) => ({
		type: "blob",
		data: encoder.encode(files[n] as string),
	}));
	const { ids: blobIds } = await writePack(blobs);
	const tree = encodeTree([
		...entries.filter((e) => !names.includes(e.name)).map((e) => ({
			mode: e.mode as "100644",
			name: e.name,
			id: e.hash,
		})),
		...names.map((n, i) => ({
			mode: "100644" as const,
			name: n,
			id: blobIds[i],
		})),
	]);
	const at = Math.floor(Date.now() / 1000);
	const message = typeof body.message === "string"
		? body.message
		: `work on ${opened.id}`;
	const commit = encodeCommit({
		tree: (await writePack([{ type: "tree", data: tree }])).ids[0],
		parents: [parent],
		author: { name: owner, email: `${owner}@agents.dev.invalid`, at },
		message: `${message}\n`,
	});
	const { pack, ids } = await writePack([
		...blobs,
		{ type: "tree", data: tree },
		{ type: "commit", data: commit },
	]);
	const head = ids[ids.length - 1];
	const access = createCanonicalAccess({ artifacts: c.env.ARTIFACTS, repoId });
	const [status] = await access.pushRefs(
		[{ ref: opened.ref, old: ZERO_SHA, new: head }],
		{ pack },
	);
	if (status?.ok !== true) {
		throw invalid(`lane push refused: ${status?.reason ?? "no status"}`);
	}
	await core.recordPush({
		target: "repo",
		refs: [{ ref: opened.ref, before: ZERO_SHA, after: head }],
		principal: owner,
		via: "gateway",
		requestId: `dev_${ulid()}`,
	});
	return { laneId: opened.id, ref: opened.ref, head };
};

const submit = async (c: RouteContext, repoId: string) => {
	const body = await readJson(c.req);
	const lanes = body.lanes;
	if (
		!Array.isArray(lanes) || lanes.length === 0 || lanes.length > 16 ||
		!lanes.every((l) => typeof l === "string" && isIdOf("lane", l))
	) {
		throw invalid("lanes is a list of 1–16 lane ids");
	}
	const testPolicy = body.testPolicy === "checks" ? "checks" : "none";
	const batchId =
		typeof body.batchId === "string" && isIdOf("batch", body.batchId)
			? body.batchId
			: `lb_${ulid()}`;
	const { core, land, events } = repoOf(c.env, repoId);
	const batch = [];
	const reason: string[] = [];
	for (const [i, laneId] of (lanes as string[]).entries()) {
		const l = await core.getLane(laneId);
		if (l === null || l.head === undefined) {
			throw invalid(`lane ${laneId} has no head`);
		}
		const changeId = changeIdFromBytes(
			crypto.getRandomValues(new Uint8Array(16)),
		);
		const common = {
			node: repoId,
			repo: repoId,
			depth: 0,
			shadow: false,
		};
		const submitted = await events.append({
			...common,
			type: "changes.submitted",
			source: {
				kind: "installation",
				id: DEV_CHANGES_INST,
				ext: "tartan.changes@0.0.0",
			},
			actor: { kind: "agent", id: l.owner },
			data: {
				changeId,
				laneId,
				revision: 1,
				head: l.head,
				base: l.base,
				affected: [],
			},
			idemKey: `dev:${changeId}:submitted`,
		});
		const approved = await events.append({
			...common,
			type: "review.decided",
			source: {
				kind: "installation",
				id: DEV_REVIEW_INST,
				ext: "tartan.review@0.0.0",
			},
			actor: { kind: "system", id: "sys_kernel" },
			data: {
				changeId,
				revision: 1,
				head: l.head,
				decision: "approve",
				route: "auto",
				decidedBy: { kind: "system", id: "sys_kernel" },
			},
			idemKey: `dev:${changeId}:approved`,
		});
		reason.push(submitted.id, approved.id);
		batch.push({
			changeId,
			laneId,
			head: l.head,
			title: `dev change ${i + 1}`,
			message: `Landed by the WP10 live acceptance (${laneId}).`,
			trailers: [{ key: "Tartan-Change", value: changeId }],
		});
	}
	const out = await land.submit({
		batchId,
		repo: { id: repoId },
		ref: trunkRef(DEV_BRANCH),
		batch,
		reason: { events: reason, summary: "wp10 live acceptance" },
		testPolicy,
	}, DEV_QUEUE_INST);
	return {
		...out,
		changes: batch.map((b) => ({
			changeId: b.changeId,
			laneId: b.laneId,
			head: b.head,
		})),
	};
};

const verify = async (c: RouteContext, repoId: string) => {
	const access = createCanonicalAccess({ artifacts: c.env.ARTIFACTS, repoId });
	const token = await access.token("read");
	const sandbox = c.env.SANDBOX.getByName(gitSandboxName(repoId));
	const dir = `/tmp/verify-${ulid()}`;
	const env = gitAuthEnv([{ remote: token.remote, token: token.token }]);
	const run = async (argv: string[]) => {
		const out = await sandbox.gitExec(argv, { env, timeoutMs: 120_000 });
		return { exitCode: out.exitCode, stdout: out.stdout, stderr: out.stderr };
	};
	try {
		const clone = await run(["git", "clone", "--quiet", token.remote, dir]);
		const fetch = await run([
			"git",
			"-C",
			dir,
			"fetch",
			"--quiet",
			"origin",
			"refs/notes/*:refs/notes/*",
			`+${CHANGES_PREFIX}*:refs/remotes/changes/*`,
		]);
		const log = await run([
			"git",
			"-C",
			dir,
			"log",
			"--notes=tartan",
			"-8",
			"--format=commit %H%nparents %P%n%B%nnote %N%n----",
		]);
		const changes = await run([
			"git",
			"-C",
			dir,
			"for-each-ref",
			"--format=%(refname) %(objectname)",
			"refs/remotes/changes/",
		]);
		const lsRemote = await run(["git", "ls-remote", token.remote]);
		await run(["rm", "-rf", dir]);
		return { clone, fetch, log, changes, lsRemote };
	} finally {
		await token.revoke();
	}
};

export const handleDevLand: RouteHandler = async (c) => {
	if (!(await hasDevKey(c))) {
		return new Response(null, {
			status: 404,
			headers: { "cache-control": "no-store" },
		});
	}
	try {
		const [repoId, op, ...extra] = (c.params.rest ?? "").split("/").filter((
			p,
		) => p !== "");
		if (
			repoId === undefined || !isUlid(repoId) || op === undefined ||
			extra.length > 0
		) {
			throw notFound("not found");
		}
		const method = c.req.method;
		if (method === "POST" && op === "setup") {
			return json(await setup(c, repoId), 201);
		}
		if (method === "POST" && op === "lane") {
			return json(await lane(c, repoId), 201);
		}
		if (method === "POST" && op === "submit") {
			return json(await submit(c, repoId), 201);
		}
		if (method === "POST" && op === "archive") {
			const body = await readJson(c.req);
			const { core } = repoOf(c.env, repoId);
			const laneId = String(body.laneId);
			const l = await core.getLane(laneId);
			if (l === null) throw notFound(`no lane ${laneId}`);
			return json(
				await core.archiveLane(
					laneId,
					{ atticRef: String(body.atticRef) },
					{ kind: "agent", id: l.owner },
				),
			);
		}
		if (method === "POST" && op === "gc") {
			const { core } = repoOf(c.env, repoId);
			return json(await core.gcLanes(Date.now() + 25 * 60 * 60 * 1000));
		}
		if (method === "GET" && op === "status") {
			const batchId = c.url.searchParams.get("batch") ?? "";
			const { land, core } = repoOf(c.env, repoId);
			const status = await land.status(batchId);
			if (status === null) throw notFound(`no batch ${batchId}`);
			const lanes = [];
			for (const ch of status.changes) {
				const l = await core.getLane(ch.laneId);
				lanes.push({ laneId: ch.laneId, state: l?.state ?? null });
			}
			const refs = await core.refs();
			return json({
				status,
				lanes,
				refs: refs.filter((r) =>
					r.ref === NOTES_REF || r.ref.startsWith(CHANGES_PREFIX) ||
					r.ref.startsWith("refs/heads/")
				).map((r) => ({ ref: r.ref, sha: r.sha })),
				changeRefs: status.changes.map((ch) => changeRef(ch.changeId)),
			});
		}
		if (method === "GET" && op === "verify") {
			return json(await verify(c, repoId));
		}
		throw notFound("not found");
	} catch (error) {
		const wire = toWire(error);
		return Response.json(wire, {
			status: httpStatus(wire.error),
			headers: { "cache-control": "no-store" },
		});
	}
};
