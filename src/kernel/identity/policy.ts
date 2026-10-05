// Identity lifetimes, rate limits and defaults. One place, so the tests and the
// code read the same numbers.

import type { TokenScope } from "@tartan/contract";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const IDENTITY_TTL = {
	sessionIdleMs: 12 * HOUR,
	sessionAbsoluteMs: 7 * DAY,
	/** Sliding idle expiry is written at most this often per session. */
	sessionTouchMs: MINUTE,
	loginTxnMs: 10 * MINUTE,
	setupSessionMs: 30 * MINUTE,
	bootstrapCodeMs: DAY,
	recoverCodeMs: HOUR,
	inviteMs: 7 * DAY,
	recoveryBannerMs: 7 * DAY,
	patMaxMs: 365 * DAY,
	agentTokenDefaultDays: 7,
	agentTokenMaxDays: 30,
	/** `tokens.last_used_at` is written at most this often per token. */
	tokenTouchMs: MINUTE,
	/** The IdP metadata is re-discovered by the cron once it is this old. */
	idpRefreshMs: DAY,
} as const;

/** Fixed windows. */
export const RATE_LIMITS = {
	setupPerIp: { limit: 5, windowMs: 10 * MINUTE },
	setupGlobal: { limit: 50, windowMs: 10 * MINUTE },
	/** Claim-code requests: each logs a line, so they are capped separately. */
	setupCodePerIp: { limit: 5, windowMs: 10 * MINUTE },
	loginPerIp: { limit: 20, windowMs: MINUTE },
	tokenCreatePerUser: { limit: 10, windowMs: MINUTE },
} as const;

/** What an agent token may do unless the creator narrows it. */
export const DEFAULT_AGENT_SCOPES: readonly TokenScope[] = [
	"repo:read",
	"repo:write",
	"lanes",
	"mcp",
];

/** Requested at registration and used for login; no `offline_access`. */
export const DEFAULT_IDP_SCOPES = "openid profile email groups";

/** The rate-limit keys (`rate_limits.key`). */
export const rateKey = {
	setupIp: (ipHash: string) => `setup:ip:${ipHash}`,
	setupGlobal: "setup:global",
	setupCode: (ipHash: string) => `setup:code:${ipHash}`,
	loginIp: (ipHash: string) => `login:ip:${ipHash}`,
	tokenCreate: (principal: string) => `tokens:${principal}`,
} as const;
