// The installation snapshot an ExtensionDO caches: a mode
// change that commits between its reads must not leave a snapshot that pairs
// the old row with the new `ext_version`, or revalidation keeps it for good.

import { equal, ok } from "node:assert/strict";
import type { InstallationDto } from "@tartan/contract";
import { registryInstallationSource } from "./installation.ts";

Deno.test("a mode change between the snapshot's reads is noticed by the next revalidation", async () => {
	let version = 7;
	let mode: InstallationDto["mode"] = "enforce";
	const row = () =>
		({
			id: "i_01k60000000000000000000201",
			extId: "acme.hello",
			version: "0.1.0",
			mode,
		}) as unknown as InstallationDto;
	const source = registryInstallationSource(() => ({
		installation: () => {
			const read = row();
			// The Owner's setMode(disabled) commits right after this read.
			mode = "disabled";
			version += 1;
			return Promise.resolve(read);
		},
		extVersion: () => Promise.resolve(version),
		packages: () =>
			Promise.resolve([
				{ version: "0.1.0", manifest: {}, sha256: "f".repeat(64) },
			] as never),
	}));
	const snap = await source.load("i_01k60000000000000000000201");
	equal(snap?.installation.mode, "enforce", "the row read before the change");
	ok(
		(snap?.extVersion ?? Infinity) < await source.version(),
		"stamped with the version read before the row, so revalidation reloads",
	);
});

Deno.test("repository config (WP23): a per-repository host loads its repo's overlay; other scopes do not", async () => {
	const base = {
		id: "i_01k60000000000000000000201",
		extId: "tartan.weave",
		version: "0.1.0",
		mode: "enforce",
		config: { batch: 4 },
	} as unknown as InstallationDto;
	const asked: string[] = [];
	const source = registryInstallationSource(() => ({
		installation: () => {
			asked.push("installation");
			return Promise.resolve(base);
		},
		installationAt: (_id: string, repoId: string) => {
			asked.push(`installationAt:${repoId}`);
			return Promise.resolve({ ...base, config: { batch: 2 } });
		},
		extVersion: () => Promise.resolve(1),
		packages: () =>
			Promise.resolve([
				{ version: "0.1.0", manifest: {}, sha256: "f".repeat(64) },
			] as never),
	}));
	const batch = (s: Awaited<ReturnType<typeof source.load>>) =>
		(s?.installation.config as { batch: number }).batch;
	equal(
		batch(
			await source.load(base.id, {
				kind: "repo",
				repoId: "01k60000000000000000000202",
			}),
		),
		2,
	);
	equal(batch(await source.load(base.id, { kind: "node" })), 4);
	equal(batch(await source.load(base.id)), 4);
	equal(
		asked.join(","),
		"installationAt:01k60000000000000000000202,installation,installation",
	);
});
