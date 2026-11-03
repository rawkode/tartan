// `tt repo clone`: stock `git clone` over HTTPS. A forge path resolves
// against the active forge (or `--hostname`) to `<origin>/<path>.git`. When
// git does not already ask `tt` for that origin (`tt auth setup-git`), the
// clone is given the helper with `git clone --config`, so it applies to the
// clone itself and stays in the new repository's config.

import {
	type Args,
	flag,
	type Io,
	loadConfig,
	requireCredential,
	UsageError,
} from "./commands.ts";
import { originOf } from "./config.ts";
import { helperConfigured, helperKey, helperValue } from "./credential.ts";

const SEGMENT = /^[A-Za-z0-9._-]+$/;

/** The clone URL and its forge origin for a forge path or an http(s) URL. */
export const cloneTarget = (
	target: string,
	origin: () => string,
): { readonly url: string; readonly origin: string } => {
	if (/^https?:\/\//i.test(target)) {
		return { url: target, origin: originOf(target) };
	}
	const path = target.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
	const segments = path.split("/");
	if (
		segments.length < 2 ||
		segments.some((s) => !SEGMENT.test(s) || s === "." || s === "..")
	) {
		throw new UsageError(
			`not a forge repository path: ${
				JSON.stringify(target)
			} (want owner/…/repo)`,
		);
	}
	const forge = origin();
	return { url: `${forge}/${path}.git`, origin: forge };
};

export const repoClone = async (io: Io, args: Args): Promise<number> => {
	const [target, dir, ...extra] = args.positional;
	if (target === undefined || extra.length > 0) {
		throw new UsageError(
			"usage: tt repo clone <owner/…/repo | URL> [<dir>] [-- <git clone flags>]",
		);
	}
	const config = await loadConfig(io);
	const hostname = flag(args, "hostname");
	const { url, origin } = cloneTarget(
		target,
		() =>
			hostname !== undefined
				? originOf(hostname)
				: requireCredential(config, io, args).origin,
	);
	const helper = await helperConfigured(io.git, origin) ? [] : [
		"--config",
		`${helperKey(origin)}=`,
		"--config",
		`${helperKey(origin)}=${helperValue()}`,
	];
	const result = await io.git(
		[
			"clone",
			...args.passthrough,
			...helper,
			"--",
			url,
			...(dir === undefined ? [] : [dir]),
		],
		{ inherit: true },
	);
	return result.code === 0 ? 0 : 1;
};
