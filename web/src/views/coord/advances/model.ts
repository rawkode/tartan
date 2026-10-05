// The Advances list's model (WP19): a summary of
// the advances on screen (landed, stale, failed; vetoes that blocked; what
// gates on trial in shadow mode would have done) and the gate filters.
// Pure: no DOM, no API.

import type { AdvanceDto } from "@tartan/contract/api.ts";

export const GATE_FILTERS = ["all", "gated", "veto", "shadow"] as const;
export type GateFilter = typeof GATE_FILTERS[number];

export const GATE_FILTER_LABELS: Readonly<Record<GateFilter, string>> = {
	all: "All",
	gated: "Gated",
	veto: "Vetoed",
	shadow: "Shadow decisions",
};

const gates = (a: AdvanceDto) => a.gateResults ?? [];

export const matchesFilter = (a: AdvanceDto, filter: GateFilter): boolean => {
	switch (filter) {
		case "all":
			return true;
		case "gated":
			return gates(a).length > 0;
		case "veto":
			return gates(a).some((g) =>
				g.mode === "enforce" && g.decision === "veto"
			);
		case "shadow":
			return gates(a).some((g) => g.mode === "shadow");
	}
};

export type AdvancesSummary = {
	readonly total: number;
	readonly landed: number;
	readonly stale: number;
	readonly failed: number;
	readonly inFlight: number;
	/** Advances an enforced gate vetoed. */
	readonly vetoed: number;
	/** Advances a gate in shadow mode would have vetoed (it never blocks). */
	readonly shadowVetoes: number;
	readonly evidenceReused: number;
	/** Advances written by the dev-only history seeding (labelled). */
	readonly seeded: number;
	/** Shadow vetoes by extension, for "would have vetoed N of the last M". */
	readonly shadowByExt: readonly { ext: string; vetoes: number }[];
};

export const summarize = (advances: readonly AdvanceDto[]): AdvancesSummary => {
	const shadow = new Map<string, number>();
	let vetoed = 0;
	let shadowVetoes = 0;
	for (const a of advances) {
		if (gates(a).some((g) => g.mode === "enforce" && g.decision === "veto")) {
			vetoed++;
		}
		const shadowed = gates(a).filter((g) =>
			g.mode === "shadow" && g.decision === "veto"
		);
		if (shadowed.length > 0) shadowVetoes++;
		for (const g of shadowed) shadow.set(g.ext, (shadow.get(g.ext) ?? 0) + 1);
	}
	const by = (state: AdvanceDto["state"]) =>
		advances.filter((a) => a.state === state).length;
	return {
		total: advances.length,
		landed: by("done"),
		stale: by("stale"),
		failed: by("failed") + by("released"),
		inFlight: by("locked") + by("pushing"),
		vetoed,
		shadowVetoes,
		evidenceReused: advances.filter((a) => a.evidenceReused).length,
		seeded: advances.filter((a) => a.seeded === true).length,
		shadowByExt: [...shadow.entries()]
			.map(([ext, vetoes]) => ({ ext, vetoes }))
			.sort((a, b) => b.vetoes - a.vetoes || a.ext.localeCompare(b.ext)),
	};
};
