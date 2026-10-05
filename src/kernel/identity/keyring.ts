// The keyring (WP2): every key Tartan uses is
// derived from one root secret (`TARTAN_SECRET`, or the root key ForgeDO
// generated at first boot when that secret is absent) with HKDF-SHA256 and a
// distinct `info` label, and imported as a NON-extractable `CryptoKey`:
//
// - `seal` (AES-256-GCM): sealed values `v1.<kid>.<iv>.<ct>` with AAD
//   `tartan:<kind>:<id>` (IdP client secret, DCR registration token, private
//   JWKs, the PKCE verifier of a login transaction);
// - `web` (HMAC-SHA256): reserved for cookie MACs;
// - `lane-cap` (`LANE_CAP_KEY`, HMAC-SHA256, label `tartan:lane-cap:v1`): the
//   capability-URL MAC, used for nothing else.
//
// Rotation: with `TARTAN_SECRET_PREVIOUS` set, `open` also accepts values
// sealed under the previous root (matched by `kid`); new values are always
// sealed under the current root.
//
// Pure (WebCrypto only). The per-isolate cache that decides where the root
// comes from is `src/kernel/http/isolate.ts`.

import { invalid } from "@tartan/contract";
import {
	type Bytes,
	fromBase64Url,
	randomBytes,
	toBase64Url,
	toHex,
	utf8,
} from "./crypto.ts";

export const KEY_LABELS = {
	seal: "tartan:seal:v1",
	sealKid: "tartan:seal-kid:v1",
	web: "tartan:web:v1",
	signWrap: "tartan:sign-wrap:v1",
	laneCap: "tartan:lane-cap:v1",
} as const;

const HKDF_SALT = utf8("tartan:root:v1");
const SEALED_RE = /^v1\.([0-9a-f]{8})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]+)$/;

/** Derives 256 bits for `label` from a root secret (its UTF-8 bytes are the IKM). */
export const deriveBits = async (
	root: string,
	label: string,
): Promise<Bytes> => {
	const ikm = await crypto.subtle.importKey(
		"raw",
		utf8(root),
		"HKDF",
		false,
		["deriveBits"],
	);
	return new Uint8Array(
		await crypto.subtle.deriveBits(
			{ name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info: utf8(label) },
			ikm,
			256,
		),
	);
};

type SealKey = { readonly kid: string; readonly key: CryptoKey };

const sealKeyOf = async (root: string): Promise<SealKey> => {
	const [bits, kidBits] = await Promise.all([
		deriveBits(root, KEY_LABELS.seal),
		deriveBits(root, KEY_LABELS.sealKid),
	]);
	const key = await crypto.subtle.importKey(
		"raw",
		bits,
		{ name: "AES-GCM" },
		false,
		["encrypt", "decrypt"],
	);
	return { kid: toHex(kidBits).slice(0, 8), key };
};

const hmacKeyOf = async (root: string, label: string): Promise<CryptoKey> =>
	await crypto.subtle.importKey(
		"raw",
		await deriveBits(root, label),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);

export type Keyring = {
	/** Key id of the current seal key (a fingerprint, not secret). */
	readonly kid: string;
	/** Seals `plaintext` for `(kind, id)`; the AAD binds the value to that slot. */
	seal(kind: string, id: string, plaintext: string): Promise<string>;
	/** Opens a sealed value of `(kind, id)`; throws `invalid` on any mismatch. */
	open(kind: string, id: string, sealed: string): Promise<string>;
	/** `LANE_CAP_KEY`: non-extractable HMAC-SHA256 (sign, verify). */
	readonly laneCap: CryptoKey;
	/** The `web` key: non-extractable HMAC-SHA256. */
	readonly web: CryptoKey;
};

const aad = (kind: string, id: string): Bytes => utf8(`tartan:${kind}:${id}`);

/** Builds the keyring of a root secret (and the previous one while rotating). */
export const createKeyring = async (
	root: string,
	previous?: string,
): Promise<Keyring> => {
	if (root.length < 16) throw invalid("the root secret is too short");
	const [current, prior, laneCap, web] = await Promise.all([
		sealKeyOf(root),
		previous ? sealKeyOf(previous) : Promise.resolve(null),
		hmacKeyOf(root, KEY_LABELS.laneCap),
		hmacKeyOf(root, KEY_LABELS.web),
	]);
	const byKid = new Map<string, CryptoKey>(
		[current, ...(prior ? [prior] : [])].map((k) => [k.kid, k.key]),
	);
	return {
		kid: current.kid,
		laneCap,
		web,
		seal: async (kind, id, plaintext) => {
			const iv = randomBytes(12);
			const ct = new Uint8Array(
				await crypto.subtle.encrypt(
					{ name: "AES-GCM", iv, additionalData: aad(kind, id) },
					current.key,
					utf8(plaintext),
				),
			);
			return `v1.${current.kid}.${toBase64Url(iv)}.${toBase64Url(ct)}`;
		},
		open: async (kind, id, sealed) => {
			const m = SEALED_RE.exec(sealed);
			if (m === null) throw invalid(`malformed sealed ${kind}`);
			const key = byKid.get(m[1]);
			if (key === undefined) throw invalid(`sealed ${kind} has an unknown key`);
			try {
				const plain = await crypto.subtle.decrypt(
					{
						name: "AES-GCM",
						iv: fromBase64Url(m[2]),
						additionalData: aad(kind, id),
					},
					key,
					fromBase64Url(m[3]),
				);
				return new TextDecoder().decode(plain);
			} catch {
				throw invalid(`sealed ${kind} does not open`);
			}
		},
	};
};

/** A fresh root secret (32 random bytes, base64url): the first-boot fallback. */
export const generateRootSecret = (): string => toBase64Url(randomBytes(32));
