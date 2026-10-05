// The K2 data-plane client (WP26): subscriptions, consume, ack, nack and
// extend over HTTPS on `https://<streamId>.k2.cloudflarestorage.com` with a
// K2 Consume token. The binding cannot consume, so the BusDO is the only
// caller. The token never leaves the request: every error carries only the
// operation, the HTTP status, the K2 code and the request path; no
// response text, header or token is ever copied into an error or a log line.
// Dependencies are injected (`fetch`, `endpoint`, `token`) for FakeK2.

export type K2ClientDeps = {
	readonly endpoint: string;
	/** Read per request (a Secrets Store `get()`); never stored by the client. */
	readonly token: () => Promise<string>;
	readonly fetch?: (req: Request) => Promise<Response>;
};

export type K2Op =
	| "subscriptions.list"
	| "subscriptions.create"
	| "subscriptions.delete"
	| "consume"
	| "ack"
	| "nack"
	| "extend";

/** A failed data-plane call: op, status and code only (never the token). */
export class K2Error extends Error {
	override name = "K2Error";
	constructor(
		readonly op: K2Op,
		/** 0 when the request never got an answer. */
		readonly status: number,
		readonly code: number | null,
		readonly path: string,
	) {
		super(
			`K2 ${op} failed: ${status === 0 ? "no response" : `HTTP ${status}`}${
				code === null ? "" : ` code ${code}`
			} (${path})`,
		);
	}
}

export type K2Subscription = {
	readonly id: string;
	readonly name: string;
	readonly startAt: string | null;
};

export type ConsumedRecord = {
	readonly timestampMs: number;
	readonly content: Uint8Array;
	readonly headers: Readonly<Record<string, string>>;
};

export type ConsumedBatch = {
	readonly batchId: string | null;
	readonly leasedUntilMs: number | null;
	readonly records: readonly ConsumedRecord[];
};

export type K2Client = {
	listSubscriptions(name?: string): Promise<K2Subscription[]>;
	createSubscription(
		name: string,
		startAt: "earliest" | "latest",
	): Promise<string>;
	deleteSubscription(id: string): Promise<void>;
	consume(
		subscription: string,
		workerId: string,
		maxRecords: number,
	): Promise<ConsumedBatch>;
	ack(subscription: string, batchId: string, workerId: string): Promise<void>;
	nack(subscription: string, batchId: string, workerId: string): Promise<void>;
	extend(
		subscription: string,
		batchId: string,
		workerId: string,
	): Promise<number | null>;
};

const fromBase64 = (text: string): Uint8Array => {
	const binary = atob(text);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

const firstCode = (body: unknown): number | null => {
	if (!isObject(body) || !Array.isArray(body.errors)) return null;
	const code = (body.errors[0] as { code?: unknown } | undefined)?.code;
	return typeof code === "number" && Number.isInteger(code) ? code : null;
};

const segment = (value: string): string => encodeURIComponent(value);

export const createK2Client = (deps: K2ClientDeps): K2Client => {
	const doFetch = deps.fetch ?? ((req: Request) => fetch(req));
	const base = deps.endpoint.replace(/\/+$/, "");

	const call = async (
		op: K2Op,
		method: "GET" | "POST" | "DELETE",
		path: string,
		body?: unknown,
	): Promise<unknown> => {
		const token = await deps.token();
		let res: Response;
		try {
			res = await doFetch(
				new Request(`${base}${path}`, {
					method,
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/json",
					},
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
				}),
			);
		} catch {
			throw new K2Error(op, 0, null, path.split("?")[0]);
		}
		let parsed: unknown = null;
		try {
			parsed = await res.json();
		} catch {
			parsed = null;
		}
		if (!res.ok || (isObject(parsed) && parsed.success === false)) {
			throw new K2Error(op, res.status, firstCode(parsed), path.split("?")[0]);
		}
		return isObject(parsed) ? parsed.result : null;
	};

	const subscriptionsOf = (result: unknown): K2Subscription[] => {
		const list = Array.isArray(result)
			? result
			: isObject(result) && Array.isArray(result.subscriptions)
			? result.subscriptions
			: [];
		return list.flatMap((item): K2Subscription[] => {
			if (!isObject(item)) return [];
			const { id, name } = item;
			if (typeof id !== "string" || typeof name !== "string") return [];
			const startAt = isObject(item.start_at) &&
					typeof item.start_at.type === "string"
				? item.start_at.type
				: null;
			return [{ id, name, startAt }];
		});
	};

	const batchOp = (op: "ack" | "nack" | "extend") =>
	(
		subscription: string,
		batchId: string,
		workerId: string,
	): Promise<unknown> =>
		call(
			op,
			"POST",
			`/subscriptions/${segment(subscription)}/batches/${
				segment(batchId)
			}/${op}`,
			{ worker_id: workerId },
		);

	return {
		listSubscriptions: async (name) =>
			subscriptionsOf(
				await call(
					"subscriptions.list",
					"GET",
					name === undefined
						? "/subscriptions"
						: `/subscriptions?name=${segment(name)}`,
				),
			),
		createSubscription: async (name, startAt) => {
			const result = await call(
				"subscriptions.create",
				"POST",
				"/subscriptions",
				{ name, start_at: { type: startAt } },
			);
			const id = isObject(result) ? result.id : undefined;
			if (typeof id !== "string") {
				throw new K2Error("subscriptions.create", 200, null, "/subscriptions");
			}
			return id;
		},
		deleteSubscription: async (id) => {
			await call(
				"subscriptions.delete",
				"DELETE",
				`/subscriptions/${segment(id)}`,
			);
		},
		consume: async (subscription, workerId, maxRecords) => {
			const path = `/subscriptions/${segment(subscription)}/consume`;
			const result = await call("consume", "POST", path, {
				worker_id: workerId,
				max_records: maxRecords,
			});
			if (!isObject(result)) throw new K2Error("consume", 200, null, path);
			const records = Array.isArray(result.records) ? result.records : [];
			return {
				batchId: typeof result.batch_id === "string" ? result.batch_id : null,
				leasedUntilMs: typeof result.leased_until_ms === "number"
					? result.leased_until_ms
					: null,
				records: records.flatMap((r): ConsumedRecord[] => {
					if (!isObject(r) || typeof r.content !== "string") return [];
					let content: Uint8Array;
					try {
						content = fromBase64(r.content);
					} catch {
						content = new Uint8Array();
					}
					const headers: Record<string, string> = {};
					if (isObject(r.headers)) {
						for (const [k, v] of Object.entries(r.headers)) {
							if (typeof v === "string") headers[k] = v;
						}
					}
					return [{
						timestampMs: typeof r.timestamp_ms === "number"
							? r.timestamp_ms
							: 0,
						content,
						headers,
					}];
				}),
			};
		},
		ack: async (subscription, batchId, workerId) => {
			await batchOp("ack")(subscription, batchId, workerId);
		},
		nack: async (subscription, batchId, workerId) => {
			await batchOp("nack")(subscription, batchId, workerId);
		},
		extend: async (subscription, batchId, workerId) => {
			const result = await batchOp("extend")(subscription, batchId, workerId);
			return isObject(result) && typeof result.leased_until_ms === "number"
				? result.leased_until_ms
				: null;
		},
	};
};
