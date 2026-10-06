// Product identity and versions.
//
// COMPAT_DATE is the single compatibility date for the deployed Worker and the
// vitest pool (vitest.config.ts mirrors it). The pool's workerd ceiling is
// 2026-08-22, so this must not move past that without a plan for the pool.

export const PRODUCT_NAME = "Tartan" as const;
export const COMPAT_DATE = "2026-08-15" as const;

/**
 * Version of this contract package, equal to `package.json` `version` (a
 * test keeps them equal). Additive changes bump the minor or the patch.
 */
export const CONTRACT_VERSION = "0.4.5" as const;

/** Extension API id carried by every manifest (`api`) and the WIT package. */
export const EXT_API = "tartan:ext@0.1.0" as const;

export const MANIFEST_SCHEMA_VERSION = 1 as const;
export const UI_SCHEMA_VERSION = 1 as const;
export const ENVELOPE_SCHEMA_VERSION = 1 as const;

/** MCP `initialize` server name. */
export const MCP_SERVER_NAME = "tartan" as const;

/** Non-removable pseudo-extension that owns the kernel views. */
export const KERNEL_EXT_ID = "tartan.kernel" as const;

export const LICENSE = "MIT" as const;
