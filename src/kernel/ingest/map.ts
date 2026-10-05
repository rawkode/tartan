// Mapping one `cf.artifacts.repo.pushed` event to a RepoDO
// observation: the payload is `{id, type, source:{namespace, repoName},
// payload:{ref, before, after, commits[], commitsTruncated,
// totalCommitsCount}}`, one ref per event, no pusher and no timestamp. The repo
// name is lowercased and parsed: it names its family (`r-<repoUlid>` or
// `l-<repoUlid>-<laneUlid>[-<n>]`), so the RepoDO is found without a lookup.
// The commit lists are ignored (ranges come from git, K17). Pure, so Deno tests
// cover it.

import {
	isSha,
	isValidRefName,
	parseArtifactsName,
	repoDoName,
} from "@tartan/contract";
import type { TriggerObservation } from "@tartan/contract/kernel.ts";

/** The trigger's event type. */
export const REPO_PUSHED_EVENT = "cf.artifacts.repo.pushed" as const;

/** The event as the Workflow receives it (`event.payload`); unchecked. */
export type IngestWorkflowParams = Readonly<Record<string, unknown>>;

export type MappedTrigger =
	| {
		readonly ok: true;
		/** `repo:<repoUlid>`. */
		readonly doName: string;
		readonly observation: TriggerObservation;
	}
	| { readonly ok: false; readonly drop: string };

const record = (value: unknown): Record<string, unknown> | null =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;

export const mapTriggerEvent = (
	params: unknown,
	meta: {
		/** The Workflow instance id (= the event id). */
		readonly instanceId: string;
		/** When the instance was created (the event carries no timestamp). */
		readonly at: number;
		/** The namespace this deployment's trigger filters on (`tartan-<stage>`). */
		readonly namespace: string;
	},
): MappedTrigger => {
	const event = record(params);
	if (event === null) return { ok: false, drop: "not an object" };
	if (event.type !== undefined && event.type !== REPO_PUSHED_EVENT) {
		return { ok: false, drop: `unexpected event type ${String(event.type)}` };
	}
	const source = record(event.source);
	const payload = record(event.payload);
	if (source === null || payload === null) {
		return { ok: false, drop: "missing source or payload" };
	}
	if (
		typeof source.namespace === "string" &&
		source.namespace.toLowerCase() !== meta.namespace
	) {
		return { ok: false, drop: "another namespace" };
	}
	if (typeof source.repoName !== "string") {
		return { ok: false, drop: "missing repo name" };
	}
	const repoName = source.repoName.toLowerCase();
	const parsed = parseArtifactsName(repoName);
	if (parsed === null) return { ok: false, drop: "unparseable repo name" };
	const { ref, before, after } = payload;
	if (typeof ref !== "string" || !isValidRefName(ref)) {
		return { ok: false, drop: "invalid ref" };
	}
	if (!isSha(before) || !isSha(after)) {
		return { ok: false, drop: "invalid before/after" };
	}
	const eventId = typeof event.id === "string" && event.id.length > 0
		? event.id
		: meta.instanceId;
	return {
		ok: true,
		doName: repoDoName(parsed.repoUlid),
		observation: { eventId, repoName, ref, before, after, at: meta.at },
	};
};
