// Capability allowlists (data) and the helpers that read and filter capability
// lists.

/**
 * Receive-pack advertisement (v0/v1; receive-pack has no v2): everything else,
 * including `push-cert`, `push-options` and unknown names, is stripped.
 * `agent=…` and `object-format=sha1` are matched by name.
 */
export const RECEIVE_PACK_CAPABILITIES = [
	"report-status",
	"report-status-v2",
	"side-band-64k",
	"side-band",
	"quiet",
	"delete-refs",
	"ofs-delta",
	"atomic",
	"agent",
	"object-format",
] as const;

/** Upload-pack v0/v1 advertisement allowlist (every caller). */
export const UPLOAD_PACK_V0_CAPABILITIES = [
	"multi_ack",
	"multi_ack_detailed",
	"side-band",
	"side-band-64k",
	"thin-pack",
	"ofs-delta",
	"shallow",
	"deepen-since",
	"deepen-relative",
	"no-progress",
	"include-tag",
	"no-done",
	"agent",
	"object-format",
] as const;

/**
 * Upload-pack v2 advertisement allowlist (every caller): `ls-refs` keeps only
 * `unborn`, `fetch` only `shallow` and `filter`.
 */
export const UPLOAD_PACK_V2_CAPABILITIES = {
	"ls-refs": ["unborn"],
	fetch: ["shallow", "filter"],
	agent: [],
	"object-format": ["sha1"],
} as const;

/** One capability allowlist, as the rewriters take it. */
export type CapabilityAllowlist =
	| { readonly protocol: "v0"; readonly names: readonly string[] }
	| {
		readonly protocol: "v2";
		readonly commands: Readonly<Record<string, readonly string[]>>;
	};

/** The only object format Tartan serves (Artifacts repositories are SHA-1). */
export const OBJECT_FORMAT = "sha1";

/** Capabilities whose value is free text (kept verbatim when the name is allowed). */
const FREE_VALUE = new Set(["agent"]);
/** Capabilities whose value must itself be on the allowlist (`object-format=sha1`). */
const LISTED_VALUE: Readonly<Record<string, readonly string[]>> = {
	"object-format": [OBJECT_FORMAT],
};

/** `name` or `name=value` → its name. */
export const capabilityName = (capability: string): string => {
	const eq = capability.indexOf("=");
	return eq < 0 ? capability : capability.slice(0, eq);
};

/** `name=value` → its value, or null without `=`. */
export const capabilityValue = (capability: string): string | null => {
	const eq = capability.indexOf("=");
	return eq < 0 ? null : capability.slice(eq + 1);
};

/** Splits a space-separated capability list (empty entries dropped). */
export const splitCapabilities = (list: string): string[] =>
	list.split(" ").filter((entry) => entry.length > 0);

/**
 * Whether one capability a client selected (or a server advertised) is
 * allowed by `names`: the name must be listed; `agent` takes any value;
 * `object-format` only `sha1`; every other allowed capability takes no value.
 */
export const isAllowedCapability = (
	capability: string,
	names: readonly string[],
): boolean => {
	const name = capabilityName(capability);
	if (!names.includes(name)) return false;
	const value = capabilityValue(capability);
	if (FREE_VALUE.has(name)) return value !== null && value.length > 0;
	const listed = LISTED_VALUE[name];
	if (listed) return value !== null && listed.includes(value);
	return value === null;
};

/**
 * Filters an advertised v0/v1 capability list to `names`. `symref=A:B` is kept
 * only when `keepSymref(A, B)` says so (see `AdvertisementOptions.symrefs`).
 */
export const filterCapabilities = (
	capabilities: readonly string[],
	names: readonly string[],
	keepSymref?: (from: string, to: string) => boolean,
): string[] =>
	capabilities.filter((capability) => {
		if (capabilityName(capability) === "symref" && keepSymref) {
			const value = capabilityValue(capability) ?? "";
			const colon = value.indexOf(":");
			return colon > 0 &&
				keepSymref(value.slice(0, colon), value.slice(colon + 1));
		}
		return isAllowedCapability(capability, names);
	});
