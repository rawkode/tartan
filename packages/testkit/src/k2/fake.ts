// FakeK2 (WP26): one K2 stream in memory, with the producer binding's
// `send()` and the HTTPS data plane (`https://<id>.k2.cloudflarestorage.com`)
// as a `fetch` function, plus fault injection. It encodes our reading of the
// K2 docs (public beta):
//
// - `send()` never throws for a rejected batch; it answers
//   `{success:false, error:{code, message, retryable}}`. `10212`/`10213` may
//   or may not have stored the batch. K2 never deduplicates.
// - Consuming is pull with batch leases (5 min) per `worker_id`: a worker that
//   asks again while it holds a lease gets the same batch back (lease
//   refreshed); an expired or nacked batch is redelivered under a new
//   `batch_id`; ack is idempotent (an unknown batch also succeeds); `extend`
//   by anyone but the holder, or after expiry, is `409`/`10218`. At most 128
//   active leases per subscription (`429`/`10216`), 100 subscriptions per
//   stream (`10219`). Records carry `timestamp_ms`, base64 `content` and
//   `headers`, never an offset.
// - Subscriptions start at `earliest` or `latest` and are immutable: the same
//   name with other settings is `422`/`10201`; an unknown id is `404`/`10215`.
// - Every data-plane call needs `Authorization: Bearer <token>`
//   (`10208` missing, `10209` wrong) and JSON (`415`/`10205`).
//
// Portable (Deno and workerd): no Deno or Node APIs.

export const FAKE_K2_STREAM_ID = "0123456789abcdef0123456789abcdef";
export const FAKE_K2_TOKEN = "fake-k2-consume-token";
export const K2_LEASE_MS = 5 * 60 * 1000;
export const K2_MAX_LEASES = 128;
export const K2_MAX_SUBSCRIPTIONS = 100;
export const K2_MAX_RECORD_BYTES = 1_000_000;
export const K2_MAX_SEND_BYTES = 5_000_000;
export const K2_MAX_HEADERS = 32;
export const K2_MAX_HEADER_VALUE_BYTES = 8 * 1024;

export type FakeK2Record = {
	readonly offset: number;
	readonly timestampMs: number;
	readonly content: Uint8Array;
	readonly headers: Readonly<Record<string, string>>;
};

export type FakeK2SendRecord = {
	readonly content: Uint8Array | ArrayBuffer;
	readonly headers?: Readonly<Record<string, string>>;
};

export type FakeK2SendResult =
	| { readonly success: true }
	| {
		readonly success: false;
		readonly error: {
			readonly code: number;
			readonly message: string;
			readonly retryable: boolean;
		};
	};

/** A scripted `send()` outcome, used once per call until exhausted. */
export type SendFault =
	/** Answer this error; `stored: true` stores the batch anyway (10212/10213). */
	| {
		readonly kind: "error";
		readonly code: number;
		readonly retryable?: boolean;
		readonly stored?: boolean;
		readonly message?: string;
	}
	/** The binding itself throws (a network failure). */
	| { readonly kind: "throw"; readonly message?: string }
	/** Stores the batch twice (an at-least-once duplicate). */
	| { readonly kind: "duplicate" }
	/** Waits this long before answering normally. */
	| { readonly kind: "delay"; readonly ms: number };

export type FakeK2DataOp =
	| "subscriptions.create"
	| "subscriptions.list"
	| "subscriptions.get"
	| "subscriptions.delete"
	| "consume"
	| "ack"
	| "nack"
	| "extend";

export type DataFault =
	| {
		readonly kind: "error";
		readonly status: number;
		readonly code: number;
		readonly message?: string;
	}
	/** The call never answers within this many ms (then answers normally). */
	| { readonly kind: "delay"; readonly ms: number };

export type FakeK2Subscription = {
	readonly id: string;
	readonly name: string;
	readonly startAt: "earliest" | "latest";
	readonly createdAt: number;
	/** The first offset not yet acked (the committed position). */
	readonly committed: number;
	readonly activeLeases: number;
	readonly acked: number;
};

export type FakeK2Options = {
	readonly streamId?: string;
	readonly token?: string;
	readonly now?: () => number;
	readonly leaseMs?: number;
};

type Lease = {
	readonly batchId: string;
	readonly workerId: string;
	readonly offsets: number[];
	leasedUntil: number;
	reversed: boolean;
};

type Sub = {
	readonly id: string;
	readonly name: string;
	readonly startAt: "earliest" | "latest";
	readonly createdAt: number;
	next: number;
	released: number[];
	readonly acked: Set<number>;
	readonly leases: Map<string, Lease>;
};

const SUBSCRIPTION_NAME_RE = /^[A-Za-z0-9_-]{1,128}$/;

const encoder = new TextEncoder();
const byteLength = (text: string): number => encoder.encode(text).length;

const toBase64 = (bytes: Uint8Array): string => {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
};

const hex = (n: number, width: number): string =>
	n.toString(16).padStart(width, "0");

const envelope = (result: unknown, status = 200): Response =>
	new Response(
		JSON.stringify({ success: true, errors: [], messages: [], result }),
		{ status, headers: { "content-type": "application/json" } },
	);

const failure = (status: number, code: number, message: string): Response =>
	new Response(
		JSON.stringify({
			success: false,
			errors: [{ code, message }],
			messages: [],
			result: null,
		}),
		{ status, headers: { "content-type": "application/json" } },
	);

export type FakeK2 = ReturnType<typeof createFakeK2>;

export const createFakeK2 = (options: FakeK2Options = {}) => {
	const streamId = options.streamId ?? FAKE_K2_STREAM_ID;
	const token = options.token ?? FAKE_K2_TOKEN;
	const now = options.now ?? (() => Date.now());
	const leaseMs = options.leaseMs ?? K2_LEASE_MS;
	const endpoint = `https://${streamId}.k2.cloudflarestorage.com`;

	const log: FakeK2Record[] = [];
	const subs = new Map<string, Sub>();
	const sendFaults: SendFault[] = [];
	const dataFaults: { op: FakeK2DataOp; fault: DataFault }[] = [];
	let ids = 0;
	const calls = {
		send: 0,
		sendRecords: 0,
		consume: 0,
		ack: 0,
		nack: 0,
		extend: 0,
		subscriptions: 0,
	};
	/** Every request's method, path and Authorization header (leak checks). */
	const requests: { method: string; path: string; authorization: string }[] =
		[];

	const append = (records: readonly FakeK2SendRecord[]): void => {
		const at = now();
		for (const record of records) {
			const content = record.content instanceof Uint8Array
				? record.content.slice()
				: new Uint8Array(record.content.slice(0));
			log.push({
				offset: log.length,
				timestampMs: at,
				content,
				headers: { ...(record.headers ?? {}) },
			});
		}
	};

	const validate = (
		records: readonly FakeK2SendRecord[],
	): { code: number; message: string } | null => {
		if (!Array.isArray(records) || records.length === 0) {
			return { code: 10204, message: "records must be a non-empty array" };
		}
		const kinds = new Set(
			records.map((r) => r.content instanceof Uint8Array ? "u8" : "ab"),
		);
		if (
			kinds.size > 1 ||
			records.some((r) =>
				!(r.content instanceof Uint8Array) &&
				!(r.content instanceof ArrayBuffer)
			)
		) {
			return {
				code: 10204,
				message: "content must be all Uint8Array or all ArrayBuffer",
			};
		}
		let total = 0;
		for (const record of records) {
			const headers = Object.entries(record.headers ?? {});
			if (headers.length > K2_MAX_HEADERS) {
				return { code: 10204, message: "too many headers" };
			}
			let size = record.content.byteLength;
			for (const [name, value] of headers) {
				if (typeof value !== "string") {
					return { code: 10204, message: `header ${name} is not a string` };
				}
				if (byteLength(name) > 256) {
					return { code: 10204, message: "header name too long" };
				}
				if (byteLength(value) > K2_MAX_HEADER_VALUE_BYTES) {
					return { code: 10204, message: `header ${name} too long` };
				}
				size += byteLength(name) + byteLength(value);
			}
			if (size > K2_MAX_RECORD_BYTES) {
				return { code: 10207, message: "record too large" };
			}
			total += size;
		}
		if (total > K2_MAX_SEND_BYTES) {
			return { code: 10207, message: "request too large" };
		}
		return null;
	};

	const producer = {
		send: async (
			records: FakeK2SendRecord[],
		): Promise<FakeK2SendResult> => {
			calls.send += 1;
			const fault = sendFaults.shift();
			if (fault?.kind === "delay") {
				await new Promise((r) => setTimeout(r, fault.ms));
			}
			if (fault?.kind === "throw") {
				throw new Error(fault.message ?? "K2 binding unavailable");
			}
			const invalid = validate(records);
			if (invalid !== null) {
				return {
					success: false,
					error: { ...invalid, retryable: false },
				};
			}
			if (fault?.kind === "error") {
				if (fault.stored) append(records);
				return {
					success: false,
					error: {
						code: fault.code,
						message: fault.message ?? `fault ${fault.code}`,
						retryable: fault.retryable ?? false,
					},
				};
			}
			append(records);
			if (fault?.kind === "duplicate") append(records);
			calls.sendRecords += records.length;
			return { success: true };
		},
	};

	// -------------------------------------------------------------------------
	// Data plane
	// -------------------------------------------------------------------------

	let reorderPending = 0;
	const takeReorder = (): boolean => {
		if (reorderPending === 0) return false;
		reorderPending -= 1;
		return true;
	};

	const takeFault = (op: FakeK2DataOp): DataFault | undefined => {
		const i = dataFaults.findIndex((f) => f.op === op);
		return i === -1 ? undefined : dataFaults.splice(i, 1)[0].fault;
	};

	const release = (sub: Sub, lease: Lease): void => {
		sub.leases.delete(lease.workerId);
		const pending = lease.offsets.filter((o) => !sub.acked.has(o));
		sub.released = [...new Set([...sub.released, ...pending])].sort((a, b) =>
			a - b
		);
	};

	const expire = (sub: Sub): void => {
		const t = now();
		for (const lease of [...sub.leases.values()]) {
			if (lease.leasedUntil <= t) release(sub, lease);
		}
	};

	const committed = (sub: Sub): number => {
		let c = sub.startAt === "latest" ? Math.min(sub.next, log.length) : 0;
		while (sub.acked.has(c)) c += 1;
		return c;
	};

	const subscriptionDto = (sub: Sub) => ({
		id: sub.id,
		name: sub.name,
		start_at: { type: sub.startAt },
		created_at: new Date(sub.createdAt).toISOString(),
		modified_at: new Date(sub.createdAt).toISOString(),
	});

	const batchDto = (lease: Lease) => {
		const offsets = lease.reversed
			? [...lease.offsets].reverse()
			: lease.offsets;
		return {
			batch_id: lease.batchId,
			leased_until_ms: lease.leasedUntil,
			records: offsets.map((o) => {
				const r = log[o];
				return {
					timestamp_ms: r.timestampMs,
					content: toBase64(r.content),
					...(Object.keys(r.headers).length > 0
						? { headers: { ...r.headers } }
						: {}),
				};
			}),
		};
	};

	const findLease = (sub: Sub, batchId: string): Lease | undefined =>
		[...sub.leases.values()].find((l) => l.batchId === batchId);

	type Body = Record<string, unknown>;
	const readBody = async (req: Request): Promise<Body | Response> => {
		if (
			!(req.headers.get("content-type") ?? "").startsWith("application/json")
		) {
			return failure(415, 10205, "Content-Type must be application/json");
		}
		try {
			const value = await req.json();
			return value !== null && typeof value === "object"
				? value as Body
				: failure(400, 10204, "body must be an object");
		} catch {
			return failure(400, 10204, "invalid JSON");
		}
	};

	const workerOf = (body: Body): string | Response => {
		const worker = body.worker_id;
		return typeof worker === "string" && worker.length >= 1 &&
				worker.length <= 256
			? worker
			: failure(400, 10204, "worker_id must be 1-256 characters");
	};

	const handle = async (req: Request): Promise<Response> => {
		const url = new URL(req.url);
		const authorization = req.headers.get("authorization") ?? "";
		requests.push({ method: req.method, path: url.pathname, authorization });
		if (url.host !== `${streamId}.k2.cloudflarestorage.com`) {
			return failure(404, 10200, "unknown stream");
		}
		if (authorization === "") return failure(401, 10208, "missing token");
		if (authorization !== `Bearer ${token}`) {
			return failure(401, 10209, "invalid token");
		}
		const parts = url.pathname.split("/").filter(Boolean);
		if (parts[0] !== "subscriptions") {
			return failure(404, 10204, "not found");
		}
		const op: FakeK2DataOp = parts.length === 1
			? (req.method === "POST" ? "subscriptions.create" : "subscriptions.list")
			: parts.length === 2
			? (req.method === "DELETE" ? "subscriptions.delete" : "subscriptions.get")
			: parts.length === 3 && parts[2] === "consume"
			? "consume"
			: (parts[4] as FakeK2DataOp);
		const fault = takeFault(op);
		if (fault?.kind === "delay") {
			await new Promise((r) => setTimeout(r, fault.ms));
		}
		if (fault?.kind === "error") {
			return failure(
				fault.status,
				fault.code,
				fault.message ?? `fault ${fault.code}`,
			);
		}

		if (op === "subscriptions.list") {
			calls.subscriptions += 1;
			const name = url.searchParams.get("name");
			const list = [...subs.values()]
				.filter((s) => name === null || s.name === name)
				.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
				.map(subscriptionDto);
			return envelope(list);
		}
		if (op === "subscriptions.create") {
			calls.subscriptions += 1;
			const body = await readBody(req);
			if (body instanceof Response) return body;
			const name = body.name;
			const startAt = (body.start_at as { type?: unknown } | undefined)?.type;
			if (typeof name !== "string" || !SUBSCRIPTION_NAME_RE.test(name)) {
				return failure(400, 10204, "invalid subscription name");
			}
			if (startAt !== "earliest" && startAt !== "latest") {
				return failure(400, 10204, "start_at.type must be earliest or latest");
			}
			const existing = [...subs.values()].find((s) => s.name === name);
			if (existing) {
				return existing.startAt === startAt
					? envelope({ id: existing.id })
					: failure(422, 10201, "subscription exists with other settings");
			}
			if (subs.size >= K2_MAX_SUBSCRIPTIONS) {
				return failure(409, 10219, "too many subscriptions");
			}
			ids += 1;
			const sub: Sub = {
				id: `sub${hex(ids, 29)}`,
				name,
				startAt,
				createdAt: now(),
				next: startAt === "latest" ? log.length : 0,
				released: [],
				acked: new Set(),
				leases: new Map(),
			};
			subs.set(sub.id, sub);
			return envelope({ id: sub.id });
		}

		const sub = subs.get(parts[1]);
		if (sub === undefined) {
			return failure(404, 10215, "subscription not found");
		}
		if (op === "subscriptions.get") return envelope(subscriptionDto(sub));
		if (op === "subscriptions.delete") {
			calls.subscriptions += 1;
			subs.delete(sub.id);
			return envelope({ id: sub.id });
		}

		const body = await readBody(req);
		if (body instanceof Response) return body;
		const worker = workerOf(body);
		if (worker instanceof Response) return worker;
		expire(sub);

		if (op === "consume") {
			calls.consume += 1;
			const held = sub.leases.get(worker);
			if (held) {
				held.leasedUntil = now() + leaseMs;
				return envelope(batchDto(held));
			}
			const max = body.max_records;
			if (
				typeof max !== "number" || !Number.isInteger(max) || max < 1 ||
				max > 10_000
			) {
				return failure(400, 10204, "max_records must be 1-10000");
			}
			if (sub.leases.size >= K2_MAX_LEASES) {
				return failure(429, 10216, "too many active leases");
			}
			const leased = new Set(
				[...sub.leases.values()].flatMap((l) => l.offsets),
			);
			const offsets: number[] = [];
			for (const o of sub.released) {
				if (offsets.length >= max) break;
				if (!sub.acked.has(o) && !leased.has(o)) offsets.push(o);
			}
			sub.released = sub.released.filter((o) => !offsets.includes(o));
			while (offsets.length < max && sub.next < log.length) {
				offsets.push(sub.next);
				sub.next += 1;
			}
			if (offsets.length === 0) {
				return envelope({ batch_id: null, leased_until_ms: null, records: [] });
			}
			ids += 1;
			const lease: Lease = {
				batchId: `b${hex(ids, 31)}`,
				workerId: worker,
				offsets,
				leasedUntil: now() + leaseMs,
				reversed: takeReorder(),
			};
			sub.leases.set(worker, lease);
			return envelope(batchDto(lease));
		}

		const batchId = parts[3];
		const lease = findLease(sub, batchId);
		if (op === "ack") {
			calls.ack += 1;
			if (lease) {
				for (const o of lease.offsets) sub.acked.add(o);
				sub.leases.delete(lease.workerId);
			}
			return envelope({});
		}
		if (op === "nack") {
			calls.nack += 1;
			if (lease) release(sub, lease);
			return envelope({});
		}
		if (op === "extend") {
			calls.extend += 1;
			if (lease === undefined || lease.workerId !== worker) {
				return failure(409, 10218, "lease lost");
			}
			lease.leasedUntil = now() + leaseMs;
			return envelope({ leased_until_ms: lease.leasedUntil });
		}
		return failure(404, 10204, "not found");
	};

	return {
		streamId,
		endpoint,
		token,
		/** The producer binding (`env.EVENT_LOG`). */
		producer,
		/** The data plane: answers requests to `endpoint` like K2. */
		fetch: (input: Request | string, init?: RequestInit): Promise<Response> =>
			handle(input instanceof Request ? input : new Request(input, init)),
		calls,
		requests,
		/** Every stored record, in log order. */
		records: (): readonly FakeK2Record[] => log,
		subscriptions: (): FakeK2Subscription[] =>
			[...subs.values()].map((sub) => {
				expire(sub);
				return {
					id: sub.id,
					name: sub.name,
					startAt: sub.startAt,
					createdAt: sub.createdAt,
					committed: committed(sub),
					activeLeases: sub.leases.size,
					acked: sub.acked.size,
				};
			}),
		/** Scripts the next `send()` calls, in order. */
		sendFault: (...faults: SendFault[]): void => {
			sendFaults.push(...faults);
		},
		/** Scripts the next data-plane call of `op`. */
		dataFault: (op: FakeK2DataOp, fault: DataFault, times = 1): void => {
			for (let i = 0; i < times; i++) dataFaults.push({ op, fault });
		},
		/** The next `n` delivered batches list their records in reverse. */
		reorderBatches: (n = 1): void => {
			reorderPending += n;
		},
		/** Expires every active lease now (the records become redeliverable). */
		expireLeases: (): void => {
			for (const sub of subs.values()) {
				for (const lease of [...sub.leases.values()]) release(sub, lease);
			}
		},
		/** Stores records produced elsewhere (another producer). */
		produce: (records: readonly FakeK2SendRecord[]): void => append(records),
	};
};
