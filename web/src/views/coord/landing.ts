// Pure helpers for the runs, advances and why pages (WP19): links,
// state tones and durations. No DOM, no API.

import type { AdvanceDto, LandBatchDto, RunDto } from "@tartan/contract/api.ts";
import type { JobStatus } from "@tartan/contract/pipeline.ts";
import { nodeHref } from "../../router/params.ts";
import type { Tone } from "../../ui/nodeTypes.ts";

const enc = encodeURIComponent;

export const runsHref = (repo: string): string => `${nodeHref(repo)}/-/runs`;

export const runHref = (repo: string, runId: string): string =>
	`${runsHref(repo)}/${enc(runId)}`;

export const jobHref = (repo: string, runId: string, jobId: string): string =>
	`${runHref(repo, runId)}/jobs/${enc(jobId)}`;

export const advancesHref = (repo: string): string =>
	`${nodeHref(repo)}/-/advances`;

/** One land batch (the kernel serves batches by id: `/-/api/advances/<batchId>`). */
export const batchHref = (repo: string, batchId: string): string =>
	`${advancesHref(repo)}/${enc(batchId)}`;

export const laneHref = (repo: string, laneId: string): string =>
	`${nodeHref(repo)}/-/lanes/${enc(laneId)}`;

export const runTone = (state: RunDto["state"] | JobStatus["state"]): Tone => {
	switch (state) {
		case "success":
		case "cached":
			return "success";
		case "failure":
		case "error":
			return "danger";
		case "running":
		case "queued":
		case "pending":
			return "info";
		default:
			return "muted";
	}
};

export const batchTone = (state: LandBatchDto["state"]): Tone => {
	switch (state) {
		case "landed":
			return "success";
		case "conflicted":
		case "vetoed":
		case "failed":
			return "danger";
		case "stale":
		case "cancelled":
			return "muted";
		default:
			return "info";
	}
};

export const advanceTone = (state: AdvanceDto["state"]): Tone => {
	switch (state) {
		case "done":
			return "success";
		case "failed":
			return "danger";
		case "stale":
		case "released":
			return "muted";
		default:
			return "info";
	}
};

export const gateTone = (decision: "allow" | "advise" | "veto"): Tone =>
	decision === "allow" ? "success" : decision === "veto" ? "danger" : "warning";

/** `1m 05s`, `42s`, `1h 03m`; `—` without a start. */
export const duration = (
	startedAt: number | undefined,
	finishedAt: number | undefined,
	now: number,
): string => {
	if (startedAt === undefined) return "—";
	const seconds = Math.max(
		0,
		Math.round(((finishedAt ?? now) - startedAt) / 1000),
	);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
	}
	return `${Math.floor(minutes / 60)}h ${
		String(minutes % 60).padStart(2, "0")
	}m`;
};
