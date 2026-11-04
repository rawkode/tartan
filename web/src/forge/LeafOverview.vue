<script setup lang="ts">
// A project, or a repo that is a single project.
import { computed } from "vue";
import { css } from "../../styled-system/css";
import {
	detail,
	facts,
	heading,
	line,
	text,
} from "../../styled-system/recipes";
import { blobHref, treeHref } from "../router/params.ts";
import {
	type ForgeNode,
	type PlacedIssue,
	rel,
	urlFor,
	useForge,
} from "./data/index.ts";
import CloneCommand from "./CloneCommand.vue";
import CommitList from "./CommitList.vue";
import IssueRow from "./IssueRow.vue";
import RepoFile from "./RepoFile.vue";
import RepoReadme from "./RepoReadme.vue";

const props = defineProps<{ node: ForgeNode; repo: ForgeNode; scope: string }>();

const store = useForge();

const isProject = computed(() => props.node.kind === "project");
const branch = computed(() => props.repo.defaultBranch ?? "main");

const issuesOn = computed(() => {
	const known = store.issuesAt(props.repo.addr);
	return props.node.issuesEnabled !== false && known?.status === "ready";
});
const issues = computed((): PlacedIssue[] => {
	const known = store.issuesAt(props.repo.addr);
	if (known?.status !== "ready") return [];
	return known.list.issues
		.filter((i) =>
			i.state === "open" && (!isProject.value || i.project === props.node.root)
		)
		.map((i) => store.placed(props.repo, i))
		.slice(0, 6);
});
const issueWidth = computed(() =>
	issues.value.reduce(
		(max, i) =>
			Math.max(
				max,
				rel(props.scope, i.where).length + String(i.number).length + 1,
			),
		0,
	)
);

const projectUrl = (name: string) => urlFor(`${props.repo.addr}:${name}`);

const page = detail();
const rows = line();
const list = facts();
const label = heading({ size: "rule" });
const muted = text({ tone: "muted", size: "sm" });
const section = css({ display: "flex", flexDirection: "column" });
const refs = css({ display: "flex", flexWrap: "wrap", columnGap: "2" });
</script>

<template>
	<div :class="page.columns">
		<div :class="page.main">
			<section v-if="issuesOn" :class="section">
				<h2 :class="label">Open issues</h2>
				<IssueRow v-for="issue in issues" :key="issue.number" :issue="issue"
					:scope="scope" :width="issueWidth" />
				<p v-if="!issues.length" :class="rows.empty">No open issues here.</p>
			</section>

			<RepoFile v-if="node.manifestPath" :repo="repo"
				:path="node.manifestPath" title="Project file" />
			<RepoReadme :repo="repo" :dir="node.root" />
			<CommitList :repo="repo" :path="node.root" />
		</div>

		<aside aria-label="Details" :class="page.aside">
			<dl :class="list.root">
				<div :class="list.row">
					<dt :class="list.term">Path</dt>
					<dd :class="list.value">
						<a :href="treeHref(repo.addr, branch, node.root ?? '')">{{ node.root ?? "." }}</a>
					</dd>
				</div>
				<template v-if="isProject">
					<div :class="list.row">
						<dt :class="list.term">Defined in</dt>
						<dd :class="list.value">
							<a v-if="node.manifestPath"
								:href="blobHref(repo.addr, branch, node.manifestPath)">{{ node.manifestPath }}</a>
						</dd>
					</div>
					<div :class="list.row">
						<dt :class="list.term">Depends on</dt>
						<dd :class="[list.value, refs]">
							<a v-for="dep in node.deps" :key="dep"
								:href="projectUrl(dep)">{{ dep }}</a>
							<template v-if="!node.deps.length">—</template>
						</dd>
					</div>
					<div :class="list.row">
						<dt :class="list.term">Used by</dt>
						<dd :class="[list.value, refs]">
							<a v-for="user in node.dependents" :key="user"
								:href="projectUrl(user)">{{ user }}</a>
							<template v-if="!node.dependents.length">—</template>
						</dd>
					</div>
				</template>
			</dl>

			<CloneCommand :repo="repo.addr"
				:note="isProject ? `The whole repo. This project is under ${node.root}.` : undefined" />
			<p v-if="!isProject"
				:class="muted">To split this repo into projects, commit a <code>.cue</code> file in <code>package tartan</code> to a directory.</p>
		</aside>
	</div>
</template>
