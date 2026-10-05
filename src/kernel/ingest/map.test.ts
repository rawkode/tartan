// IngestWorkflow's event mapping (WP5a; [E A5]): one ref per event,
// the lowercased repo name parsed to its family, commit lists ignored, anything
// else dropped.

import { deepStrictEqual, equal } from "node:assert/strict";
import {
	laneArtifactsName,
	repoArtifactsName,
	repoDoName,
} from "@tartan/contract";
import { mapTriggerEvent } from "./map.ts";

const REPO = "01k6c0ffee0000000000000000";
const LANE = "01k6c0ffee0000000000000001";
const A = "a".repeat(40);
const B = "b".repeat(40);
const META = { instanceId: "inst-1", at: 1_000, namespace: "tartan-test" };

const event = (repoName: string, extra: Record<string, unknown> = {}) => ({
	id: "4e1f6c9a-0000-4000-8000-000000000001",
	type: "cf.artifacts.repo.pushed",
	source: { namespace: "tartan-test", repoName },
	payload: {
		ref: "refs/heads/main",
		before: A,
		after: B,
		commits: [{ id: B, message: "ignored" }],
		commitsTruncated: false,
		totalCommitsCount: 1,
	},
	...extra,
});

Deno.test("a canonical repo event maps to its RepoDO; an uppercase name is lowercased", () => {
	const mapped = mapTriggerEvent(
		event(repoArtifactsName(REPO).toUpperCase()),
		META,
	);
	deepStrictEqual(mapped, {
		ok: true,
		doName: repoDoName(REPO),
		observation: {
			eventId: "4e1f6c9a-0000-4000-8000-000000000001",
			repoName: repoArtifactsName(REPO),
			ref: "refs/heads/main",
			before: A,
			after: B,
			at: 1_000,
		},
	});
});

Deno.test("a lane repo event (any attempt) maps to the family's RepoDO with its exact name", () => {
	for (const attempt of [1, 2, 9]) {
		const name = laneArtifactsName(REPO, LANE, attempt);
		const mapped = mapTriggerEvent(event(name.toUpperCase()), META);
		equal(mapped.ok, true);
		if (mapped.ok) {
			equal(mapped.doName, repoDoName(REPO));
			equal(mapped.observation.repoName, name);
		}
	}
});

Deno.test("the instance id stands in for a missing event id", () => {
	const { id: _id, ...rest } = event(repoArtifactsName(REPO));
	const mapped = mapTriggerEvent(rest, META);
	equal(mapped.ok && mapped.observation.eventId, "inst-1");
});

Deno.test("events Tartan does not own, or that are malformed, are dropped", () => {
	const drops = [
		null,
		"x",
		event("tartan-smoke-git-a1"),
		event("l-" + REPO),
		event(repoArtifactsName(REPO), { type: "cf.artifacts.repo.created" }),
		{
			...event(repoArtifactsName(REPO)),
			source: { namespace: "tartan-prod", repoName: repoArtifactsName(REPO) },
		},
		{
			...event(repoArtifactsName(REPO)),
			payload: { ref: "main", before: A, after: B },
		},
		{
			...event(repoArtifactsName(REPO)),
			payload: { ref: "refs/heads/main", before: "x", after: B },
		},
		{ ...event(repoArtifactsName(REPO)), payload: undefined },
	];
	for (const input of drops) {
		equal(mapTriggerEvent(input, META).ok, false, JSON.stringify(input));
	}
});
