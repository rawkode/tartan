// The mock forge's extension catalog: the packages in its registry, what is
// installed where, what each installation contributes to `/-/api/view`, and
// the slot documents it renders. The mock forge ships with none (no
// first-party extensions); tests pass a sample catalog (`MockOptions.catalog`)
// to exercise the slot hosts and the extensions admin.

import type {
	ActionResponse,
	InstallationDto,
	NodeDto,
	PackageDto,
	SlotInstanceDto,
	StaticContributionDto,
} from "@tartan/contract/api.ts";
import type { Manifest } from "@tartan/contract/manifest.ts";
import type { SlotCtxHint } from "@tartan/contract/slot-ctx.ts";
import type { UiDoc } from "@tartan/contract/ui.ts";

/** What `/-/api/view` lists for a node and view, from the installed extensions. */
export type MockContributions = {
	readonly tabs?: readonly StaticContributionDto[];
	readonly nav?: readonly StaticContributionDto[];
	readonly actions?: readonly StaticContributionDto[];
	readonly slots?: readonly SlotInstanceDto[];
};

export type MockCatalog = {
	readonly packages: readonly PackageDto[];
	readonly installations: readonly InstallationDto[];
	/** Contributions for `view` of `target`, kernel-ordered. */
	readonly contribute: (target: NodeDto, view: string) => MockContributions;
	/** Slot documents by `<extId>/<slot>/<contribution id>`. */
	readonly docs: Readonly<Record<string, UiDoc>>;
	/** An extension's own answer to an action (else the server's generic toast). */
	readonly act?: (
		extId: string,
		action: unknown,
		ctx: SlotCtxHint,
	) => ActionResponse | null;
};

export const EMPTY_CATALOG: MockCatalog = {
	packages: [],
	installations: [],
	contribute: () => ({}),
	docs: {},
};

/** A bundled package's manifest with the defaults a sample needs. */
export const sampleManifest = (
	id: string,
	name: string,
	description: string,
	extra: Partial<Manifest> = {},
): Manifest => ({
	schema: 1,
	kind: "extension",
	id,
	name,
	description,
	version: "0.1.0",
	api: "tartan:ext@0.1.0",
	runtime: "builtin",
	entry: { builtin: id },
	storage: { scope: "repo", mode: "sql", quotaMB: 256 },
	permissions: { repo: "read" },
	backfill: "none",
	onError: "skip",
	...extra,
});

export const samplePackage = (
	m: Manifest,
	publishedAt: number,
): PackageDto => ({
	extId: m.id,
	version: m.version,
	runtime: m.runtime,
	manifest: m,
	sha256: Array.from(
		{ length: 64 },
		(_, i) => "0123456789abcdef"[(m.id.charCodeAt(i % m.id.length) + i) % 16],
	).join(""),
	publishedBy: "sys_kernel",
	publishedAt,
	bundled: true,
});

export const staticContribution = (
	installationId: string,
	extId: string,
	slot: StaticContributionDto["slot"],
	id: string,
	label: string,
	order: number,
	route?: string,
): StaticContributionDto => ({
	installationId,
	ext: extId,
	slot,
	id,
	label,
	order,
	...(route ? { route } : {}),
});

export const slotInstance = (
	installationId: string,
	extId: string,
	slot: SlotInstanceDto["slot"],
	id: string,
	order: number,
	refreshOn: readonly string[] = [],
	extra: Partial<SlotInstanceDto> = {},
): SlotInstanceDto => ({
	installationId,
	ext: extId,
	slot,
	id,
	order,
	refreshOn,
	cache: "viewer",
	...extra,
});
