// Child processes of the e2e launcher. Every child inherits the hardened
// environment (env.ts) and prints through the masker (mask.ts). Binaries are
// called directly from the shared `node_modules` (never `npx`), so nothing
// unpinned is downloaded.

import * as path from "node:path";
import type { Run } from "../preflight.ts";
import { type Masker, pipeMasked } from "./mask.ts";

/** The repository root: two levels above this file. */
export const ROOT = path.resolve(
	path.dirname(new URL(import.meta.url).pathname),
	"..",
	"..",
);

export const bins = (root: string) => ({
	wrangler: path.join(root, "node_modules", ".bin", "wrangler"),
	playwright: path.join(root, "node_modules", ".bin", "playwright"),
	e2e: path.join(root, "node_modules", "e2e", "dist", "cli", "bin.js"),
	e2eConfig: path.join(root, "e2e", "e2e.config.ts"),
});

export type MaskedRun = (
	cmd: string,
	args: readonly string[],
	options?: {
		readonly env?: Readonly<Record<string, string>>;
		readonly cwd?: string;
	},
) => Promise<number>;

/** Runs a child with its stdout and stderr masked line by line; returns the exit code. */
export const createMaskedRun =
	(mask: () => Masker): MaskedRun => async (cmd, args, options = {}) => {
		const child = new Deno.Command(cmd, {
			args: [...args],
			cwd: options.cwd,
			env: options.env ? { ...options.env } : undefined,
			stdin: "null",
			stdout: "piped",
			stderr: "piped",
		}).spawn();
		const out = { write: (p: Uint8Array) => Deno.stdout.write(p) };
		const err = { write: (p: Uint8Array) => Deno.stderr.write(p) };
		const [, , status] = await Promise.all([
			pipeMasked(child.stdout, out, mask()),
			pipeMasked(child.stderr, err, mask()),
			child.status,
		]);
		return status.code;
	};

/** `wrangler` for the IdP: the pinned binary, the IdP's own config, the pinned account. */
export const idpWrangler = (
	run: Run,
	root: string,
	accountId: string,
	args: readonly string[],
	options: { readonly stdin?: string } = {},
) =>
	run(bins(root).wrangler, [
		...args,
		"-c",
		path.join(root, "tools", "mock-idp", "wrangler.jsonc"),
	], {
		cwd: root,
		env: { CLOUDFLARE_ACCOUNT_ID: accountId },
		...(options.stdin === undefined ? {} : { stdin: options.stdin }),
	});
