// Leak scan of an e2e run's output directory (`e2e/.e2e/`), run by the
// launcher after every run and before `evidence` copies anything.
//
// Two profiles:
// - Report files (report.json, junit.xml, summary.md, failures/, screen.txt
//   and every other text file): the smoke rules (scripts/smoke/lib/
//   leakscan.ts) plus Tartan tokens, forge session and setup cookies, Bearer
//   values, setup-URL fragments, IdP codes and every exact secret value the
//   launcher knows. Any hit is a leak.
// - Playwright traces (`*.zip`, unzipped here: e2e only rewrites registered
//   secrets in them): the same rules, except that a forge session cookie is
//   allowed only when the launcher revoked it (`POST /-/auth/logout`) in
//   this run, and spent IdP codes and consumed login-transaction cookies
//   are counted, not failed. A trace that cannot be read is reported as
//   unreadable; the launcher deletes it.
//
// Findings name the file, line and rule, never the value.

import { FORBIDDEN_FILES, scanTextForLeaks } from "../smoke/lib/leakscan.ts";
import { readZip } from "./zip.ts";

export type Finding = {
	readonly file: string;
	readonly line: number;
	readonly rule: string;
};

export type ScanResult = {
	readonly leaks: readonly Finding[];
	/** Session cookies found in traces that were revoked in this run. */
	readonly revokedSessions: number;
	/** Spent codes and consumed login-transaction cookies in traces. */
	readonly spent: number;
	/** Files (traces) the scanner could not read; the launcher deletes them. */
	readonly unreadable: readonly string[];
};

const RULES: readonly { readonly rule: string; readonly re: RegExp }[] = [
	{ rule: "tartan-token", re: /t(?:pat|agt)_[A-Za-z0-9_-]{43}/ },
	{
		rule: "setup-cookie",
		re: /__Host-tartan-setup=(?!<)[^;\s"'\\]{16,}/,
	},
	{
		rule: "bearer",
		re: /\bbearer\s+(?!<|\$)[A-Za-z0-9._~+/=-]{20,}/i,
	},
	{ rule: "setup-url-token", re: /\/-\/setup#t=(?!<)[^\s"'&]{16,}/ },
	{
		rule: "registration-token",
		re: /registration_access_token"?\s*[:=]\s*"?(?!<)[A-Za-z0-9_-]{16,}/,
	},
];

/** Allowed in traces only once revoked. */
export const SESSION_RE = /__Host-tartan-session=([A-Za-z0-9._~-]{16,512})/g;
/** Spent in traces (single use, minutes); leaks in report files. */
const SPENT_RES: readonly { readonly rule: string; readonly re: RegExp }[] = [
	{ rule: "idp-code", re: /[?&]code=[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g },
	{
		rule: "login-cookie",
		re: /__Host-tartan-login-[0-9a-f]+=(?!<)[^;\s"'\\]{16,}/g,
	},
];

const escapeRegExp = (text: string): string =>
	text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export type ScanContext = {
	/** Exact secret values (passwords, tokens, the setup token). */
	readonly secrets: readonly string[];
	/** Session cookie values revoked in this run. */
	readonly revoked: ReadonlySet<string>;
};

type TextVerdict = {
	readonly leaks: Finding[];
	readonly revoked: number;
	readonly spent: number;
};

export const scanText = (
	file: string,
	text: string,
	profile: "report" | "trace",
	ctx: ScanContext,
): TextVerdict => {
	const exact = ctx.secrets.filter((s) => s.length >= 6).map((s) =>
		new RegExp(escapeRegExp(s))
	);
	const leaks: Finding[] = scanTextForLeaks(file, text).map((l) => ({ ...l }));
	let revoked = 0;
	let spent = 0;
	text.split("\n").forEach((line, i) => {
		const at = { file, line: i + 1 };
		for (const { rule, re } of RULES) {
			if (re.test(line)) leaks.push({ ...at, rule });
		}
		if (exact.some((re) => re.test(line))) {
			leaks.push({ ...at, rule: "known-secret" });
		}
		for (const m of line.matchAll(SESSION_RE)) {
			if (profile === "trace" && ctx.revoked.has(m[1])) revoked++;
			else leaks.push({ ...at, rule: "session-cookie" });
		}
		for (const { rule, re } of SPENT_RES) {
			for (const _ of line.matchAll(re)) {
				if (profile === "trace") spent++;
				else leaks.push({ ...at, rule });
			}
		}
	});
	return { leaks, revoked, spent };
};

const isZip = (name: string, bytes: Uint8Array): boolean =>
	name.endsWith(".zip") ||
	(bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 &&
		bytes[3] === 0x04);

const isBinary = (bytes: Uint8Array): boolean =>
	bytes.subarray(0, 8192).includes(0);

export type ScanFs = {
	walk(dir: string): Promise<string[]>;
	read(file: string): Promise<Uint8Array>;
};

export const denoScanFs: ScanFs = {
	walk: async (dir) => {
		const out: string[] = [];
		const visit = async (d: string): Promise<void> => {
			try {
				for await (const e of Deno.readDir(d)) {
					const p = `${d}/${e.name}`;
					if (e.isDirectory) await visit(p);
					else if (e.isFile) out.push(p);
				}
			} catch (error) {
				if (!(error instanceof Deno.errors.NotFound)) throw error;
			}
		};
		await visit(dir);
		return out.sort();
	},
	read: (file) => Deno.readFile(file),
};

/** Session cookie values in a trace's text entries (for revocation). */
export const sessionCookiesInZip = async (
	bytes: Uint8Array,
): Promise<Set<string>> => {
	const found = new Set<string>();
	const decoder = new TextDecoder();
	for (const entry of await readZip(bytes)) {
		if (isBinary(entry.data)) continue;
		for (const m of decoder.decode(entry.data).matchAll(SESSION_RE)) {
			found.add(m[1]);
		}
	}
	return found;
};

export const scanOutput = async (
	dir: string,
	ctx: ScanContext,
	fs: ScanFs = denoScanFs,
): Promise<ScanResult> => {
	const leaks: Finding[] = [];
	const unreadable: string[] = [];
	let revokedSessions = 0;
	let spent = 0;
	const decoder = new TextDecoder();
	for (const file of await fs.walk(dir)) {
		if (FORBIDDEN_FILES.some((re) => re.test(file))) {
			leaks.push({ file, line: 0, rule: "forbidden-file" });
			continue;
		}
		const bytes = await fs.read(file);
		if (isZip(file, bytes)) {
			let entries;
			try {
				entries = await readZip(bytes);
			} catch {
				unreadable.push(file);
				continue;
			}
			for (const entry of entries) {
				if (isBinary(entry.data)) continue;
				const verdict = scanText(
					`${file}!/${entry.name}`,
					decoder.decode(entry.data),
					"trace",
					ctx,
				);
				leaks.push(...verdict.leaks);
				revokedSessions += verdict.revoked;
				spent += verdict.spent;
			}
			continue;
		}
		if (isBinary(bytes)) continue;
		leaks.push(...scanText(file, decoder.decode(bytes), "report", ctx).leaks);
	}
	return { leaks, revokedSessions, spent, unreadable };
};
