// Error taxonomy.
//
// One typed error class (classes are allowed for typed errors) plus factory
// functions. Errors cross three boundaries, each with its own wire form:
//   - Workers RPC: custom properties may not survive, so the code and reason
//     are also encoded in `message` as `<code>(<reason>): <text>` and recovered
//     by `fromRpcError`.
//   - HTTP / MCP JSON: `{ error: <code>, reason?, message, details? }`
//     (snake_case codes, e.g. `{"error":"setup_required"}`).
//   - WIT: `variant error { denied, not-found, invalid, conflict, unavailable, internal }`.

export const ERROR_CODES = [
	"invalid",
	"unauthenticated",
	"denied",
	"not_found",
	"conflict",
	"stale",
	"rate_limited",
	"payload_too_large",
	"unsupported_media_type",
	"setup_required",
	"protocol_mismatch",
	"unavailable",
	"not_implemented",
	"timeout",
	"internal",
] as const;
export type ErrorCode = typeof ERROR_CODES[number];

/**
 * Reasons carried by `denied` (K12). `denied("scope")`
 * in the design text is `denied("scope")` here.
 */
export const DENIED_REASONS = [
	"scope", // K12 confinement: a target outside the installation subtree
	"read-only", // an effect inside render/context
	"shadow", // a shadow installation attempted land/lanes/runs/notify
	"grant", // the installation's approved permissions do not cover the call
	"role", // the actor's role at the node is too low
	"actor", // a mutating interface tool called by an installation actor (K12)
	"quota", // storage quota exceeded
	"rate", // effects_per_second token bucket empty
	"depth", // event depth > 8 (K10)
	"disabled", // installation disabled / kill switch
	"landing-paused", // K1 landing_paused=1
	"namespace", // K10: event type outside the producer's namespaces
	"csrf", // same-origin check failed
	"host", // git on a non-canonical host
	"scopes", // token scopes do not include the operation
	"lane-op", // K16: the actor may not perform this lane operation
	"lane-cap", // a lane cap or the lanes_open rate limit is reached
	"setup", // a setup step without a valid setup session or out of order
	"destroy-token", // TARTAN_DESTROY_TOKEN missing, wrong or already used
	"policy-signoff", // K13.3: a policy-touching change without a matching kernel sign-off
	"policy-batch", // K13.2: more than one policy-touching change in a batch
	"policy-unknown", // K13.3: a change's diff is not known yet, so whether it touches policy is unknown (retry)
	"session", // a human act that needs a browser session (sign-off, approvals, applies)
	"policy-not-trunk", // K13: repo policy is read at a trunk commit, never at a lane head, revision or candidate
] as const;
export type DeniedReason = typeof DENIED_REASONS[number];

export type ErrorDetails = Readonly<Record<string, unknown>>;

export type TartanErrorOptions = {
	readonly reason?: string;
	readonly details?: ErrorDetails;
	readonly cause?: unknown;
};

const isErrorCode = (value: unknown): value is ErrorCode =>
	typeof value === "string" &&
	(ERROR_CODES as readonly string[]).includes(value);

const formatMessage = (
	code: ErrorCode,
	reason: string | undefined,
	text: string,
): string => `${code}${reason ? `(${reason})` : ""}: ${text}`;

export class TartanError extends Error {
	override readonly name = "TartanError";
	readonly code: ErrorCode;
	readonly reason?: string;
	readonly details?: ErrorDetails;
	/** The message without the `<code>(<reason>): ` prefix. */
	readonly text: string;

	constructor(code: ErrorCode, text: string, options: TartanErrorOptions = {}) {
		super(formatMessage(code, options.reason, text), {
			cause: options.cause,
		});
		this.code = code;
		this.reason = options.reason;
		this.details = options.details;
		this.text = text;
	}
}

export const tartanError = (
	code: ErrorCode,
	text: string,
	options?: TartanErrorOptions,
): TartanError => new TartanError(code, text, options);

export const denied = (
	reason: DeniedReason,
	text: string = reason,
	details?: ErrorDetails,
): TartanError => new TartanError("denied", text, { reason, details });
export const invalid = (text: string, details?: ErrorDetails): TartanError =>
	new TartanError("invalid", text, { details });
export const notFound = (text: string, details?: ErrorDetails): TartanError =>
	new TartanError("not_found", text, { details });
export const conflict = (text: string, details?: ErrorDetails): TartanError =>
	new TartanError("conflict", text, { details });
export const stale = (text: string, details?: ErrorDetails): TartanError =>
	new TartanError("stale", text, { details });
export const unavailable = (
	text: string,
	details?: ErrorDetails,
): TartanError => new TartanError("unavailable", text, { details });
export const unauthenticated = (
	text = "authentication required",
): TartanError => new TartanError("unauthenticated", text);
export const rateLimited = (
	text: string,
	retryAfterMs?: number,
): TartanError =>
	new TartanError("rate_limited", text, {
		details: retryAfterMs === undefined ? undefined : { retryAfterMs },
	});
export const setupRequired = (): TartanError =>
	new TartanError("setup_required", "setup is not complete");
export const protocolMismatch = (mcpUrl: string): TartanError =>
	new TartanError(
		"protocol_mismatch",
		"this repo runs a different protocol; use its MCP URL",
		{ details: { mcpUrl } },
	);
export const notImplemented = (what: string): TartanError =>
	new TartanError("not_implemented", `${what} is not implemented`);
export const timeout = (what: string, ms: number): TartanError =>
	new TartanError("timeout", `${what} exceeded ${ms} ms`, {
		details: { ms },
	});
export const internal = (text: string, cause?: unknown): TartanError =>
	new TartanError("internal", text, { cause });

export const isTartanError = (value: unknown): value is TartanError =>
	value instanceof TartanError ||
	(value instanceof Error && value.name === "TartanError" &&
		isErrorCode((value as { code?: unknown }).code));

const MESSAGE_PREFIX = /^([a-z_]+)(?:\(([^)]*)\))?: ([\s\S]*)$/;

/**
 * Recovers a TartanError from anything thrown across Workers RPC (where the
 * class and custom properties may be lost but the message survives). Unknown
 * errors become `internal`.
 */
export const fromRpcError = (value: unknown): TartanError => {
	if (value instanceof TartanError) return value;
	if (isTartanError(value)) {
		const v = value as TartanError;
		return new TartanError(v.code, v.text ?? v.message, {
			reason: v.reason,
			details: v.details,
		});
	}
	const message = value instanceof Error
		? value.message
		: typeof value === "string"
		? value
		: "unknown error";
	const match = MESSAGE_PREFIX.exec(message);
	if (match && isErrorCode(match[1])) {
		return new TartanError(match[1], match[3], {
			reason: match[2] || undefined,
			cause: value,
		});
	}
	return new TartanError("internal", message, { cause: value });
};

/** HTTP / MCP JSON error body. */
export type WireError = {
	readonly error: ErrorCode;
	readonly message: string;
	readonly reason?: string;
	readonly details?: ErrorDetails;
};

export const toWire = (value: unknown): WireError => {
	const e = fromRpcError(value);
	return {
		error: e.code,
		message: e.code === "internal" ? "internal error" : e.text,
		...(e.reason ? { reason: e.reason } : {}),
		...(e.details && e.code !== "internal" ? { details: e.details } : {}),
	};
};

export const fromWire = (wire: WireError): TartanError =>
	new TartanError(
		isErrorCode(wire.error) ? wire.error : "internal",
		wire.message,
		{
			reason: wire.reason,
			details: wire.details,
		},
	);

export const HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
	invalid: 400,
	unauthenticated: 401,
	denied: 403,
	not_found: 404,
	conflict: 409,
	stale: 409,
	protocol_mismatch: 409,
	payload_too_large: 413,
	unsupported_media_type: 415,
	rate_limited: 429,
	internal: 500,
	not_implemented: 501,
	setup_required: 503,
	unavailable: 503,
	timeout: 504,
};

export const httpStatus = (code: ErrorCode): number => HTTP_STATUS[code];

/** WIT `types.error` cases. */
export const WIT_ERROR_TAGS = [
	"denied",
	"not-found",
	"invalid",
	"conflict",
	"unavailable",
	"internal",
] as const;
export type WitErrorTag = typeof WIT_ERROR_TAGS[number];
/** jco's representation of a WIT variant value. */
export type WitError = { readonly tag: WitErrorTag; readonly val: string };

const WIT_TAG: Readonly<Record<ErrorCode, WitErrorTag>> = {
	invalid: "invalid",
	unauthenticated: "denied",
	denied: "denied",
	not_found: "not-found",
	conflict: "conflict",
	stale: "conflict",
	protocol_mismatch: "invalid",
	payload_too_large: "invalid",
	unsupported_media_type: "invalid",
	rate_limited: "unavailable",
	setup_required: "unavailable",
	unavailable: "unavailable",
	not_implemented: "unavailable",
	timeout: "unavailable",
	internal: "internal",
};

/** `denied` carries its reason (`denied("scope")`); every other case carries the text. */
export const toWitError = (value: unknown): WitError => {
	const e = fromRpcError(value);
	const tag = WIT_TAG[e.code];
	return {
		tag,
		val: tag === "denied" ? e.reason ?? e.text : e.text,
	};
};

const FROM_WIT: Readonly<Record<WitErrorTag, ErrorCode>> = {
	"denied": "denied",
	"not-found": "not_found",
	"invalid": "invalid",
	"conflict": "conflict",
	"unavailable": "unavailable",
	"internal": "internal",
};

export const fromWitError = (wit: WitError): TartanError =>
	wit.tag === "denied"
		? new TartanError("denied", wit.val, { reason: wit.val })
		: new TartanError(FROM_WIT[wit.tag] ?? "internal", wit.val);
