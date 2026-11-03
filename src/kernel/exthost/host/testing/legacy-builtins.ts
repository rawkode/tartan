// Test-only: a builtin registry of the first-party packages the spike removed
// (work, changes, board, epics, hud, radar, ci, review, weave, fifo and the
// Swarm and Classic packs), from their manifests, protocol cards, migration
// names and settings schemas (`legacy-packages.json`). Their modules are empty:
// the tests that use this registry exercise the kernel's generic package
// machinery (installation, tool listing and routing, protocol cards, repository
// config), answering extension calls with scripted handlers.
// Runtime code never imports this file.

import {
	type BuiltinSource,
	createBuiltinRegistry,
} from "../../../../builtins.ts";
import legacy from "./legacy-packages.json" with { type: "json" };

type LegacyPackage = {
	readonly dir: string;
	readonly manifest: unknown;
	readonly protocol: string | null;
	readonly migrations: readonly { n: number; name: string; sql: string }[];
	readonly settingsCue?: string;
};

export const LEGACY_SOURCES: readonly BuiltinSource[] = (
	legacy as readonly LegacyPackage[]
).map((p) => ({
	dir: p.dir,
	manifest: p.manifest,
	extension: {},
	migrations: p.migrations,
	protocol: p.protocol ?? undefined,
	...(p.settingsCue === undefined ? {} : { settingsCue: p.settingsCue }),
}));

export const legacyBuiltins = createBuiltinRegistry(LEGACY_SOURCES);
