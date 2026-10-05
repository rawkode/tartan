import assert from "node:assert/strict";
import { DEPLOY_FLAGS, k2FromFlags } from "./deploy.ts";
import { type CfApi, parseFlags, UsageError } from "./preflight.ts";
import {
	cfK2Streams,
	deleteLogStream,
	ensureLogStream,
	K2DeployError,
	type K2Stream,
	type K2StreamsApi,
	retentionFor,
} from "./k2.ts";

const hex = (n: number) => n.toString(16).padStart(32, "0");

const fakeStreams = (initial: K2Stream[] = []) => {
	const streams = [...initial];
	const calls: string[] = [];
	const api: K2StreamsApi = {
		list: () => {
			calls.push("list");
			return Promise.resolve([...streams]);
		},
		get: (id) => Promise.resolve(streams.find((s) => s.id === id) ?? null),
		create: ({ name, retentionSeconds }) => {
			calls.push(`create ${name} ${retentionSeconds}`);
			const stream = {
				id: hex(streams.length + 100),
				name,
				retentionSeconds,
				httpEnabled: false,
				bindingEnabled: true,
			};
			streams.push(stream);
			return Promise.resolve(stream);
		},
		delete: (id) => {
			calls.push(`delete ${id}`);
			streams.splice(streams.findIndex((s) => s.id === id), 1);
			return Promise.resolve();
		},
	};
	return { api, streams, calls };
};

const stream = (name: string, n: number, over: Partial<K2Stream> = {}) => ({
	id: hex(n),
	name,
	retentionSeconds: 86_400,
	httpEnabled: false,
	bindingEnabled: true,
	...over,
});

Deno.test("ensureLogStream creates tartan_<stage>_log with the stage's retention, HTTP off", async () => {
	const f = fakeStreams([stream("tartan_dev_log_old", 1)]);
	const r = await ensureLogStream(f.api, { stage: "dev-wp26" });
	assert.equal(r.created, true);
	assert.equal(r.stream.name, "tartan_dev_wp26_log");
	assert.deepEqual(f.calls, ["list", "create tartan_dev_wp26_log 86400"]);
	// Idempotent: the second deploy finds it by exact name.
	const again = await ensureLogStream(f.api, { stage: "dev-wp26" });
	assert.equal(again.created, false);
	assert.equal(again.stream.id, r.stream.id);
	const demo = await ensureLogStream(f.api, { stage: "dev-demo" });
	assert.equal(demo.stream.retentionSeconds, 604_800);
});

Deno.test("ensureLogStream refuses at the stream budget and warns on drift", async () => {
	const many = Array.from({ length: 18 }, (_, i) => stream(`other_${i}`, i));
	await assert.rejects(
		ensureLogStream(fakeStreams(many).api, { stage: "dev" }),
		/18 K2 streams/,
	);
	const ok = await ensureLogStream(fakeStreams(many).api, {
		stage: "dev",
		maxStreams: 19,
	});
	assert.equal(ok.created, true);
	const drifted = await ensureLogStream(
		fakeStreams([
			stream("tartan_dev_log", 1, {
				retentionSeconds: 3600,
				httpEnabled: true,
			}),
		]).api,
		{ stage: "dev" },
	);
	assert.equal(drifted.warnings.length, 2);
	await assert.rejects(
		ensureLogStream(
			fakeStreams([stream("tartan_dev_log", 1, { bindingEnabled: false })]).api,
			{ stage: "dev" },
		),
		K2DeployError,
	);
	assert.throws(() => retentionFor("dev", 60), /--k2-retention/);
	assert.throws(() => retentionFor("dev", 40 * 86_400), /--k2-retention/);
	assert.equal(retentionFor("acme", undefined), 604_800);
});

Deno.test("deleteLogStream refuses any stream not named for the stage", async () => {
	const f = fakeStreams([
		stream("tartan_dev_wp26_log", 1),
		stream("production_events", 2),
	]);
	await assert.rejects(
		deleteLogStream(f.api, { stage: "dev-wp26", streamId: hex(2) }),
		/refusing to delete K2 stream production_events/,
	);
	await assert.rejects(
		deleteLogStream(f.api, { stage: "dev", streamId: hex(1) }),
		/refusing/,
	);
	assert.equal(
		await deleteLogStream(f.api, { stage: "dev-wp26", streamId: hex(1) }),
		"deleted",
	);
	assert.equal(
		await deleteLogStream(f.api, { stage: "dev-wp26", streamId: hex(1) }),
		"absent",
	);
	await assert.rejects(
		deleteLogStream(f.api, { stage: "dev-wp26", streamId: "tartan_x" }),
		/not a K2 stream id/,
	);
	assert.deepEqual(f.calls, [`delete ${hex(1)}`]);
});

Deno.test("cfK2Streams speaks the account API (create with HTTP input off)", async () => {
	const requests: { method: string; path: string; body?: unknown }[] = [];
	const api: CfApi = {
		accountId: "acct",
		request: () => Promise.reject(new Error("unused")),
		account: (method, path, body) => {
			requests.push({ method, path, body });
			if (method === "POST") {
				return Promise.resolve({
					status: 200,
					body: {
						result: {
							id: hex(7),
							name: "tartan_dev_log",
							retention_seconds: 86400,
							http: { enabled: false },
							worker_binding: { enabled: true },
						},
					},
				});
			}
			if (method === "GET") {
				return Promise.resolve({ status: 404, body: null });
			}
			return Promise.resolve({ status: 200, body: { result: {} } });
		},
		list: (path) => {
			requests.push({ method: "LIST", path });
			return Promise.resolve([{ id: hex(1), name: "x" }]);
		},
	};
	const k2 = cfK2Streams(api);
	assert.equal((await k2.list())[0].name, "x");
	const created = await k2.create({
		name: "tartan_dev_log",
		retentionSeconds: 86400,
	});
	assert.equal(created.id, hex(7));
	assert.equal(created.httpEnabled, false);
	assert.equal(await k2.get(hex(9)), null);
	await k2.delete(hex(7));
	assert.deepEqual(requests.map((r) => `${r.method} ${r.path}`), [
		"LIST /accounts/acct/k2/streams",
		"POST /k2/streams",
		`GET /k2/streams/${hex(9)}`,
		`DELETE /k2/streams/${hex(7)}`,
	]);
	assert.deepEqual(requests[1].body, {
		name: "tartan_dev_log",
		retention_seconds: 86400,
		http: { enabled: false },
		worker_binding: { enabled: true },
	});
});

Deno.test("deploy --k2 flags: stream, retention, budget and the token's Secrets Store names", () => {
	const flags = (args: string[]) => parseFlags(args, DEPLOY_FLAGS);
	assert.equal(k2FromFlags(flags(["--stage", "dev"])), undefined);
	assert.deepEqual(k2FromFlags(flags(["--k2"])), {});
	assert.deepEqual(
		k2FromFlags(flags([
			"--k2",
			"--k2-retention",
			"3600",
			"--k2-token-store",
			hex(1),
			"--k2-token-secret",
			"k2-consumer",
		])),
		{
			retentionSeconds: 3600,
			token: { storeId: hex(1), secretName: "k2-consumer" },
		},
	);
	assert.deepEqual(k2FromFlags(flags(["--k2-stream", hex(2)])), {
		streamId: hex(2),
	});
	assert.throws(
		() => k2FromFlags(flags(["--k2", "--k2-token-store", hex(1)])),
		UsageError,
	);
	assert.throws(
		() => k2FromFlags(flags(["--k2-stream", hex(2), "--k2-retention", "3600"])),
		UsageError,
	);
	assert.throws(
		() => k2FromFlags(flags(["--k2", "--k2-max-streams", "x"])),
		UsageError,
	);
});
