// The global log's deploy steps (WP26): the stage's K2 stream
// `tartan_<stage>_log` through the account API (the wrangler OAuth token
// carries `k2.read`/`k2.write`), and the destroy guard. The consume token is
// never handled here: it lives in the deployer's Secrets Store and is only
// named (`--k2-token-store`, `--k2-token-secret`).
//
// - `ensureLogStream` finds the stream by exact name (the list matches
//   substrings, so the match is made here) or creates it with the HTTP input
//   disabled (only the forge's own Worker can write) and the binding enabled,
//   with the stage's retention (≤ 30 d, never longer than the DO log). It
//   refuses to create one more stream at `K2_STREAM_BUDGET` streams (K2
//   allows 20 streams per account, shared by every stage deployed there).
// - `deleteLogStream` deletes a stream only when its name is exactly
//   `tartan_<stage>_log` for the stage being destroyed.
//
// Deploy tooling only; runtime code never imports it.

import {
	K2_RETENTION_MAX_S,
	K2_RETENTION_MIN_S,
	K2_STREAM_BUDGET,
	K2_STREAM_ID_RE,
	logStreamName,
	stageBudget,
} from "../src/kernel/bus/config.ts";
import { type CfApi, CfApiError, cfErrorText } from "./preflight.ts";

export type K2Stream = {
	readonly id: string;
	readonly name: string;
	readonly retentionSeconds: number | null;
	readonly httpEnabled: boolean | null;
	readonly bindingEnabled: boolean | null;
};

export type K2StreamsApi = {
	list(): Promise<K2Stream[]>;
	get(id: string): Promise<K2Stream | null>;
	create(
		input: { name: string; retentionSeconds: number },
	): Promise<K2Stream>;
	delete(id: string): Promise<void>;
};

export class K2DeployError extends Error {
	override name = "K2DeployError";
}

// deno-lint-ignore no-explicit-any
const toStream = (raw: any): K2Stream => ({
	id: String(raw?.id ?? ""),
	name: String(raw?.name ?? ""),
	retentionSeconds: typeof raw?.retention_seconds === "number"
		? raw.retention_seconds
		: null,
	httpEnabled: typeof raw?.http?.enabled === "boolean"
		? raw.http.enabled
		: null,
	bindingEnabled: typeof raw?.worker_binding?.enabled === "boolean"
		? raw.worker_binding.enabled
		: null,
});

/** The K2 control plane over the account API. */
export const cfK2Streams = (api: CfApi): K2StreamsApi => ({
	list: async () =>
		(await api.list(`/accounts/${api.accountId}/k2/streams`))
			.map(toStream),
	get: async (id) => {
		const { status, body } = await api.account("GET", `/k2/streams/${id}`);
		if (status === 404) return null;
		if (status !== 200) {
			throw new CfApiError(status, "GET k2 stream", cfErrorText(body));
		}
		return toStream(body?.result);
	},
	create: async ({ name, retentionSeconds }) => {
		const { status, body } = await api.account("POST", "/k2/streams", {
			name,
			retention_seconds: retentionSeconds,
			http: { enabled: false },
			worker_binding: { enabled: true },
		});
		if (status !== 200 && status !== 201) {
			throw new CfApiError(status, "create k2 stream", cfErrorText(body));
		}
		return toStream(body?.result);
	},
	delete: async (id) => {
		const { status, body } = await api.account("DELETE", `/k2/streams/${id}`);
		if (status !== 200 && status !== 404) {
			throw new CfApiError(status, "delete k2 stream", cfErrorText(body));
		}
	},
});

/** The stage's retention: `--k2-retention` or the stage budget, within K2's bounds. */
export const retentionFor = (stage: string, override?: number): number => {
	const value = override ?? stageBudget(stage).retentionSeconds;
	if (
		!Number.isInteger(value) || value < K2_RETENTION_MIN_S ||
		value > K2_RETENTION_MAX_S
	) {
		throw new K2DeployError(
			`--k2-retention must be ${K2_RETENTION_MIN_S}-${K2_RETENTION_MAX_S} seconds, not ${value}`,
		);
	}
	return value;
};

/** Finds or creates the stage's stream; never touches another stream. */
export const ensureLogStream = async (
	streams: K2StreamsApi,
	input: {
		readonly stage: string;
		readonly retentionSeconds?: number;
		readonly maxStreams?: number;
	},
): Promise<{ stream: K2Stream; created: boolean; warnings: string[] }> => {
	const name = logStreamName(input.stage);
	const retentionSeconds = retentionFor(input.stage, input.retentionSeconds);
	const all = await streams.list();
	const mine = all.filter((s) => s.name.toLowerCase() === name.toLowerCase());
	if (mine.length > 1) {
		throw new K2DeployError(`more than one K2 stream is named ${name}`);
	}
	const warnings: string[] = [];
	if (mine.length === 1) {
		const stream = mine[0];
		if (!K2_STREAM_ID_RE.test(stream.id)) {
			throw new K2DeployError(`K2 stream ${name} has an unexpected id`);
		}
		if (stream.httpEnabled === true) {
			warnings.push(
				`K2 stream ${name} accepts HTTP produce; only the Worker binding is needed`,
			);
		}
		if (stream.bindingEnabled === false) {
			throw new K2DeployError(
				`K2 stream ${name} has its Worker binding disabled`,
			);
		}
		if (
			stream.retentionSeconds !== null &&
			stream.retentionSeconds !== retentionSeconds
		) {
			warnings.push(
				`K2 stream ${name} keeps records ${stream.retentionSeconds} s (this stage asks ${retentionSeconds} s)`,
			);
		}
		return { stream, created: false, warnings };
	}
	const max = input.maxStreams ?? K2_STREAM_BUDGET;
	if (all.length >= max) {
		throw new K2DeployError(
			`the account has ${all.length} K2 streams (budget ${max}; K2 allows 20 per account): delete one, raise --k2-max-streams, or deploy with --no-k2`,
		);
	}
	const stream = await streams.create({ name, retentionSeconds });
	if (!K2_STREAM_ID_RE.test(stream.id)) {
		throw new K2DeployError(`K2 created ${name} with an unexpected id`);
	}
	return { stream, created: true, warnings };
};

/** Deletes the stage's stream, refusing any stream not named `tartan_<stage>_log`. */
export const deleteLogStream = async (
	streams: K2StreamsApi,
	input: { readonly stage: string; readonly streamId: string },
): Promise<"deleted" | "absent"> => {
	if (!K2_STREAM_ID_RE.test(input.streamId)) {
		throw new K2DeployError(`not a K2 stream id: ${input.streamId}`);
	}
	const stream = await streams.get(input.streamId);
	if (stream === null) return "absent";
	const expected = logStreamName(input.stage);
	if (stream.name !== expected) {
		throw new K2DeployError(
			`refusing to delete K2 stream ${stream.name}: stage ${input.stage} owns only ${expected}`,
		);
	}
	await streams.delete(input.streamId);
	return "deleted";
};
