// What an ExtensionDO knows about its installation: the installation row and
// the package manifest, read from ForgeDO's registry (WP7a) and cached per
// isolate. The cache is revalidated against the registry's `ext_version`
// (bumped by every install, mode change, promote or upgrade) at most every
// `INSTALLATION_REVALIDATE_MS`, and dropped at once by `abort()` (kill switch,
// upgrade), so a version mismatch is noticed on the next call.

import type { ExtScope, InstallationDto, Manifest } from "@tartan/contract";
import type { RegistryFacade } from "@tartan/contract/kernel.ts";
import { withRpc } from "../../../do/dispose.ts";

export type InstallationSnapshot = {
	readonly installation: InstallationDto;
	readonly manifest: Manifest;
	/** The package's sha256 (part of the activation key). */
	readonly sha256: string;
	/** The registry's `ext_version` when this snapshot was read. */
	readonly extVersion: number;
};

export type InstallationSource = {
	/** The registry's current `ext_version`. */
	version(): Promise<number>;
	/**
	 * The installation as this host's scope sees it: for a per-repository
	 * host (`ext:<inst>:repo:<repoId>`) the config carries that repository's
	 * overlay (repository config, WP23); nothing else differs.
	 */
	load(
		installationId: string,
		scope?: ExtScope,
	): Promise<InstallationSnapshot | null>;
};

export const INSTALLATION_REVALIDATE_MS = 2000;

/**
 * The installation source on ForgeDO's registry facade. `registry` opens a
 * facade stub; each read disposes it when done.
 */
export const registryInstallationSource = (
	registry: () =>
		& Pick<RegistryFacade, "installation" | "packages" | "extVersion">
		& Partial<Pick<RegistryFacade, "installationAt">>,
): InstallationSource => ({
	version: () => withRpc(registry, (reg) => reg.extVersion()),
	load: (installationId, scope) =>
		withRpc(registry, async (reg) => {
			// The version first, then the rows: a change that
			// commits between the reads leaves the snapshot stamped with the older
			// version, so the next revalidation sees the bump and reloads. Read
			// together, an old row could carry the new version and be kept for
			// good (a disabled installation would keep receiving events).
			const extVersion = await reg.extVersion();
			const installation = scope?.kind === "repo" &&
					reg.installationAt !== undefined
				? await reg.installationAt(installationId, scope.repoId)
				: await reg.installation(installationId);
			if (installation === null) return null;
			const pkg = (await reg.packages(installation.extId)).find((p) =>
				p.version === installation.version
			);
			if (pkg === undefined) return null;
			return {
				installation,
				manifest: pkg.manifest,
				sha256: pkg.sha256,
				extVersion,
			};
		}),
});
