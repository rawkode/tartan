// The capability URL MAC (WP2): HMAC-SHA256
// over `capMacInput(fields)` (every path
// segment: `v1|<exp>|<laneId>|<nonce>|<repoId>`) with `LANE_CAP_KEY`, which
// the isolate keyring derives from the root secret (HKDF-SHA256, label
// `tartan:lane-cap:v1`) and holds as a non-extractable `CryptoKey`; the key
// bytes are never exposed. WP5b's seeder signs; WP4's capability route
// verifies in the isolate before any DO call. `crypto.subtle.verify` with
// HMAC compares in constant time.

import { type CapFields, capMacInput } from "@tartan/contract";
import type { CapMac, CreateCapMac } from "@tartan/contract/kernel.ts";
import type { Env } from "../../env.ts";
import { fromHex, toHex, utf8 } from "../identity/crypto.ts";
import { isolateKeyring } from "./isolate.ts";

const MAC_RE = /^[0-9a-f]{64}$/;

/** A `CapMac` over an HMAC-SHA256 key source (the isolate keyring in production). */
export const capMacOf = (key: () => Promise<CryptoKey>): CapMac => ({
	sign: async (fields: CapFields) => {
		const input = capMacInput(fields);
		const mac = await crypto.subtle.sign("HMAC", await key(), utf8(input));
		return toHex(new Uint8Array(mac));
	},
	verify: async (fields: CapFields, mac: string) => {
		if (typeof mac !== "string" || !MAC_RE.test(mac)) return false;
		let input: string;
		try {
			input = capMacInput(fields);
		} catch {
			return false;
		}
		return await crypto.subtle.verify(
			"HMAC",
			await key(),
			fromHex(mac),
			utf8(input),
		);
	},
});

export const createCapMac: CreateCapMac<Env> = (env) =>
	capMacOf(async () => (await isolateKeyring(env)).laneCap);
