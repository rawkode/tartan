// The binding's error shape: `name: "ArtifactsError"`, a string `code` and a
// `numericCode` in the REST API's numbering. Tests assert on the codes the
// conformance suite checks (C1, C2); the other numbers are the fake's own.

export type FakeArtifactsErrorCode = ArtifactsErrorCode;

export const ARTIFACTS_NUMERIC_CODES: Readonly<
	Record<FakeArtifactsErrorCode, number>
> = {
	INVALID_REPO_NAME: 10101,
	INVALID_TTL: 10103,
	NOT_FOUND: 10200,
	ALREADY_EXISTS: 10201,
	INTERNAL_ERROR: 10400,
	MEMORY_LIMIT: 10402,
	INVALID_INPUT: 10100,
	INVALID_URL: 10104,
	CREATE_IN_PROGRESS: 10202,
	IMPORT_IN_PROGRESS: 10203,
	FORK_IN_PROGRESS: 10204,
	REMOTE_AUTH_REQUIRED: 10300,
	UPSTREAM_UNAVAILABLE: 10401,
};

/** Default messages for the codes that have one. */
const MESSAGE: Partial<Record<FakeArtifactsErrorCode, string>> = {
	INVALID_REPO_NAME: "Invalid repo name.",
	INTERNAL_ERROR: "An internal error occurred.",
};

export class FakeArtifactsError extends Error implements ArtifactsError {
	override readonly name = "ArtifactsError" as const;
	readonly code: FakeArtifactsErrorCode;
	readonly numericCode: number;

	constructor(code: FakeArtifactsErrorCode, message?: string) {
		super(message ?? MESSAGE[code] ?? code);
		this.code = code;
		this.numericCode = ARTIFACTS_NUMERIC_CODES[code];
	}
}

export const artifactsError = (
	code: FakeArtifactsErrorCode,
	message?: string,
): FakeArtifactsError => new FakeArtifactsError(code, message);

/**
 * The fake's rate-limit answer: an `Error` carrying `status: 429` and "429"
 * in its message; over smart HTTP the fake answers HTTP 429.
 */
export class FakeRateLimitError extends Error {
	override readonly name = "RateLimitError";
	readonly status = 429;
	constructor(op: string) {
		super(`429 Too Many Requests: ${op}`);
	}
}

/** A call the fault plan made time out (the caller sees it; the work may still finish). */
export class FakeTimeoutError extends Error {
	override readonly name = "TimeoutError";
	/** True when the operation still completes after the caller gave up. */
	readonly outlives: boolean;
	constructor(op: string, ms: number, outlives = false) {
		super(`${op} timed out after ${ms} ms`);
		this.outlives = outlives;
	}
}
