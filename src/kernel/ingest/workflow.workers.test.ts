/// <reference types="@cloudflare/vitest-pool-workers/types" />
// IngestWorkflow in workerd (WP5a): one instance
// per trigger event reaches the real RepoDO's `observePush` through the
// pool's Workflows engine. Until WP6 merges, the real RepoDO's event log is
// a stub, so the end-to-end case uses an observation that appends no event
// (a change of the protected default branch is parked for K1).

import {
	introspectWorkflowInstance,
	runInDurableObject,
} from "cloudflare:test";
import { createUlid, repoArtifactsName, repoDoName } from "@tartan/contract";
import { describe, expect, it } from "vitest";
import { testEnv as env } from "../../../test/env.ts";

const sha = (n: number) => (n + 1).toString(16).padStart(40, "d");
const ulid = createUlid();

const pushed = (repoName: string, id = crypto.randomUUID()) => ({
	id,
	type: "cf.artifacts.repo.pushed",
	source: { namespace: "tartan-test", repoName },
	payload: {
		ref: "refs/heads/main",
		before: sha(1),
		after: sha(2),
		commits: [],
		commitsTruncated: false,
		totalCommitsCount: 1,
	},
});

const run = async (params: unknown) => {
	const id = `ingest-${crypto.randomUUID()}`;
	const instance = await introspectWorkflowInstance(env.INGEST, id);
	await env.INGEST.create({ id, params: params as never });
	return { id, instance };
};

describe("IngestWorkflow", () => {
	it("drops an event that names no Tartan repo, without calling any RepoDO", async () => {
		const { instance } = await run(pushed("tartan-smoke-git-a1"));
		try {
			await instance.waitForStatus("complete");
			expect(await instance.getOutput()).toEqual({
				dropped: "unparseable repo name",
			});
		} finally {
			await instance.dispose();
		}
	});

	it("observes one ref of an uppercase-named repo in its RepoDO (parked for K1), idempotently", async () => {
		const repoId = ulid();
		const stub = env.REPO.getByName(repoDoName(repoId));
		await runInDurableObject(stub, (_instance, state) => {
			const sql = state.storage.sql;
			for (
				const [k, v] of [
					["repo_id", repoId],
					["node_id", repoId],
					["path", "acme/ingest"],
					["artifacts_name", repoArtifactsName(repoId)],
					["default_branch", "main"],
					["import_state", "none"],
					["landing_paused", "0"],
				]
			) {
				sql.exec("INSERT INTO meta (k, v) VALUES (?, ?)", k, v);
			}
			sql.exec(
				"INSERT INTO refs (ref, sha, updated_at) VALUES ('refs/heads/main', ?, 0)",
				sha(1),
			);
		});
		const event = pushed(repoArtifactsName(repoId).toUpperCase());
		for (let i = 0; i < 2; i++) {
			const { instance } = await run(event);
			try {
				await instance.waitForStatus("complete");
				expect(await instance.getOutput()).toEqual({ observed: event.id });
			} finally {
				await instance.dispose();
			}
		}
		await runInDurableObject(stub, (_instance, state) => {
			const parked = state.storage.sql.exec<
				{ ref: string; source: string; after: string }
			>(
				"SELECT ref, source, after FROM pending_observations",
			).toArray();
			expect(parked).toEqual([
				{ ref: "refs/heads/main", source: "trigger", after: sha(2) },
			]);
			const seen = state.storage.sql.exec<{ event_id: string }>(
				"SELECT event_id FROM trigger_seen",
			).toArray();
			expect(seen).toEqual([{ event_id: event.id }]);
		});
	});

	it("does not retry an event for a repo that was never initialized", async () => {
		const { instance } = await run(pushed(repoArtifactsName(ulid())));
		try {
			await instance.waitForStatus("errored");
			const error = await instance.getError();
			// Not retried: the step threw a NonRetryableError (not_found).
			expect(error.message).toContain("NonRetryableError");
		} finally {
			await instance.dispose();
		}
	});
});
