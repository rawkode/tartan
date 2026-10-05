// The SPA mock of the projects API (`web/src/api/mock/projects.ts`) answers
// what the real handler answers over the same demo-shaped fixture (WP25
// slice A′; a mock that drifts from the kernel ships a page
// that breaks live). The workerd test compares the shapes with the Worker.

import { deepStrictEqual, equal } from "node:assert/strict";
import { createMockProjects } from "../../../web/src/api/mock/projects.ts";
import type {
	ProjectDetailResponse,
	ProjectIssuesResponse,
	ProjectsResponse,
} from "@tartan/contract";
import { DS, fakes, get } from "./testing/fakes.ts";

const mock = createMockProjects();

Deno.test("mock: the list equals the handler's (projects, layers, skipped, warnings, globals)", async () => {
	const { status, body: live } = await get<ProjectsResponse>(fakes(), "");
	equal(status, 200);
	const fake = mock.list(mock.repoId)!;
	deepStrictEqual({ ...fake, repo: live.repo, sha: live.sha }, live);
	equal(mock.list("01k6zzzzzzzzzzzzzzzzzzzzzz"), null);
});

Deno.test("mock: every project's page equals the handler's", async () => {
	const list = mock.list(mock.repoId)!;
	for (const p of list.projects) {
		const { body: live } = await get<ProjectDetailResponse>(
			fakes(),
			`/${p.slug}`,
		);
		const fake = mock.detail(mock.repoId, p.slug)!;
		deepStrictEqual(
			{ ...fake, repo: live.repo, sha: live.sha },
			live,
			p.slug,
		);
	}
	equal(mock.detail(mock.repoId, "nope"), null);
});

Deno.test("mock: lists carry the handler's fields", async () => {
	const { body: live } = await get<ProjectIssuesResponse>(
		fakes(),
		`/${DS}/issues`,
	);
	const fake = mock.issues(mock.repoId, DS)!;
	deepStrictEqual(Object.keys(fake).sort(), Object.keys(live).sort());
	deepStrictEqual(
		Object.keys(fake.items[0]).sort(),
		Object.keys(live.items[0]).sort(),
	);
	deepStrictEqual(fake.project, live.project);
});
