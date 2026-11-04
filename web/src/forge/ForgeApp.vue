<script setup lang="ts">
// The forge shell: address bar, tree and the page at an address. One instance
// stays mounted across every forge route, so the tree keeps its open sections.
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import {
	pageHead,
	panel,
	shell,
	tabs as tabsRecipe,
} from "../../styled-system/recipes";
import { SplitPane } from "../design-system/index.ts";
import { logHref, treeHref } from "../router/params.ts";
import {
	type ForgeNode,
	parseUrl,
	plural,
	projectsUnder,
	type Tab,
	titleFor,
	trailOf,
	urlFor,
	useForge,
} from "./data/index.ts";
import { useForgeNav } from "./nav.ts";
import Account from "./Account.vue";
import ActivityList from "./ActivityList.vue";
import GroupOverview from "./GroupOverview.vue";
import IssueDetail from "./IssueDetail.vue";
import IssueList from "./IssueList.vue";
import IssuesRefused from "./IssuesRefused.vue";
import JumpBox from "./JumpBox.vue";
import LeafOverview from "./LeafOverview.vue";
import MonoOverview from "./MonoOverview.vue";
import NewNode from "./NewNode.vue";
import NewIssue from "./NewIssue.vue";
import ProjectList from "./ProjectList.vue";
import TreeNav from "./TreeNav.vue";

const location = useRoute();
const nav = useForgeNav();
const store = useForge();

const pathname = computed(() => location.path);
const route = computed(() => parseUrl(pathname.value));

// What came of asking the kernel for this address.
const reached = ref<"loading" | "found" | "missing" | "error">("loading");
const failure = ref("");
let asked = 0;

const ask = async (addr: string) => {
	const mine = ++asked;
	const known = trailOf(store.state.tree as ForgeNode, addr);
	reached.value = known ? "found" : "loading";
	const answer = await store.reach(addr);
	if (mine !== asked) return;
	reached.value = answer.status;
	failure.value = answer.status === "error" ? answer.message : "";
};

watch(() => route.value.addr, ask, { immediate: true });

const trail = computed(() =>
	reached.value === "found"
		? trailOf(store.state.tree as ForgeNode, route.value.addr)
		: null
);
const scope = computed(() => route.value.addr);
const last = computed(() => trail.value?.[trail.value.length - 1]);
const repo = computed(() =>
	last.value?.kind === "project"
		? trail.value![trail.value!.length - 2]
		: last.value?.kind === "repo"
		? last.value
		: undefined
);

// Counts and which tabs exist come from these, whichever page is open.
watch(
	[last, pathname],
	() => {
		const node = last.value;
		if (!node) return;
		void store.ensureSubtree(node.kind === "project" ? repo.value! : node);
	},
	{ immediate: true },
);

const repoIssues = computed(() =>
	repo.value ? store.issuesAt(repo.value.addr) : undefined
);
const issuesOff = computed(() => {
	if (!repo.value) return false;
	const installed = !(repoIssues.value?.status === "refused" &&
		repoIssues.value.reason === "not_installed");
	return !installed || last.value?.issuesEnabled === false;
});

const missing = computed(() => {
	const detail = route.value.detail;
	const node = last.value;
	if (route.value.unknown) return true;
	if (reached.value === "missing") return true;
	if (reached.value !== "found") return false;
	if (!node) return true;
	if (route.value.tab === "projects" && node.kind !== "group") return true;
	if (route.value.tab === "activity" && node.kind !== "repo") return true;
	if (detail?.type === "new-node") {
		if (node.kind !== "group") return true;
		// The kernel keeps repos under a group or user: a repo needs a parent.
		if (detail.kind === "repo" && node.addr === "") return true;
	}
	return false;
});

const crumbs = computed(() => {
	const nodes = trail.value ?? [store.state.tree as ForgeNode];
	const detail = route.value.detail;
	const out = nodes.map((node, i) => ({
		name: node.name,
		sep: i === 0 ? "" : node.kind === "project" ? ":" : "/",
		href: urlFor(node.addr),
	}));
	if (detail?.type === "issue") {
		out.push({ name: String(detail.n), sep: "#", href: "" });
	}
	if (detail?.type === "new-node") out.push({ name: "…", sep: "/", href: "" });
	return out;
});

type TabDef = {
	key: Tab | "files" | "commits";
	label: string;
	href: string;
	count?: number;
	ownerOnly?: boolean;
};

const tabDefs = computed((): TabDef[] => {
	const node = last.value;
	if (!node) return [];
	const open = store.openCount(node);
	const count = open === undefined ? {} : { count: open };
	const defs: TabDef[] = [
		{ key: "overview", label: "Overview", href: urlFor(scope.value) },
	];
	if (node.kind === "group") {
		defs.push({
			key: "projects",
			label: "Projects",
			href: urlFor(scope.value, "projects"),
			count: projectsUnder(node).length,
		});
	}
	if (!issuesOff.value) {
		defs.push({
			key: "issues",
			label: "Issues",
			href: urlFor(scope.value, "issues"),
			...count,
		});
	}
	if (node.kind === "repo") {
		defs.push({
			key: "activity",
			label: "Activity",
			href: urlFor(scope.value, "activity"),
		});
	}
	if (repo.value) {
		const branch = repo.value.defaultBranch ?? "main";
		defs.push({
			key: "files",
			label: "Files",
			href: treeHref(repo.value.addr, branch, node.root ?? ""),
		}, {
			key: "commits",
			label: "Commits",
			href: logHref(repo.value.addr, branch, node.root ?? ""),
		});
	}
	// Tartan's own settings pages. A project's only setting is in its file.
	if (node.kind !== "project") {
		defs.push({
			key: "settings",
			label: "Settings",
			href: urlFor(scope.value, "settings"),
			ownerOnly: true,
		});
	}
	return defs;
});

const head = computed(() => {
	const node = last.value!;
	const parent = trail.value![trail.value!.length - 2];
	let kind = "Root";
	if (node.kind === "group" && parent) {
		const groups = node.children.filter((k) => k.kind === "group").length;
		const repos = node.children.filter((k) => k.kind === "repo").length;
		const parts = [
			groups && plural(groups, "group"),
			repos && plural(repos, "repo"),
		].filter(Boolean);
		kind = `${node.user ? "User" : "Group"} · ${parts.join(", ") || "empty"}`;
	} else if (node.kind === "repo") {
		kind = !node.loaded
			? "Repo"
			: node.children.length
			? `Monorepo · ${plural(node.children.length, "project")}`
			: "Repo · a single project";
	} else if (node.kind === "project") {
		kind = `Project · ${node.root}`;
	}
	return {
		kind,
		repo: node.kind === "project" ? parent!.name : "",
		name: node.name,
		description: node.description,
	};
});

const back = computed(() => {
	const detail = route.value.detail;
	if (!detail || !last.value) return null;
	const name = last.value.name;
	if (detail.type === "issue" || detail.type === "new-issue") {
		return {
			label: `All issues in ${name}`,
			href: urlFor(scope.value, "issues"),
		};
	}
	return { label: `Back to ${name}`, href: urlFor(scope.value) };
});

const main = ref<HTMLElement>();

const syncTitle = () => {
	document.title = `${titleFor(route.value)} · Tartan`;
};

onMounted(syncTitle);
watch(pathname, () => {
	syncTitle();
	nextTick(() => main.value?.focus({ preventScroll: true }));
}, { flush: "post" });

const banner = computed(
	() => (store.state.banner?.path === pathname.value
		? store.state.banner.text
		: ""),
);

const styles = shell();
const headStyles = pageHead();
const tabStyles = tabsRecipe();
const empty = panel();
</script>

<template>
	<div data-forge :class="styles.root" @click="nav.followLink">
		<header :class="styles.bar">
			<a :class="styles.logo" href="/">Tartan</a>
			<nav aria-label="Current address" :class="styles.crumbs">
				<template v-for="(crumb, i) in crumbs" :key="i">
					<span v-if="crumb.sep" aria-hidden="true"
						:class="styles.sep">{{ crumb.sep }}</span>
					<a v-if="crumb.href" :href="crumb.href" :class="styles.crumb"
						:aria-current="i === crumbs.length - 1 ? 'page' : undefined">{{ crumb.name }}</a>
					<span v-else :class="styles.crumb"
						aria-current="page">{{ crumb.name }}</span>
				</template>
			</nav>
			<JumpBox />
			<div :class="styles.account">
				<Account />
			</div>
		</header>

		<SplitPane label="tree" storage-key="tree-width" :default-width="272"
			:min-width="200" :max-width="560">
			<template #side>
				<TreeNav :scope="trail ? scope : '~missing'" :route="route" />
			</template>

			<main id="main" ref="main" tabindex="-1" :class="styles.main">
				<div v-if="missing" :class="styles.pad">
					<div :class="[empty.root, empty.empty]">Nothing at that address.</div>
				</div>
				<div v-else-if="reached === 'loading'" :class="styles.pad">
					<div role="status" :class="[empty.root, empty.empty]">Loading…</div>
				</div>
				<div v-else-if="reached === 'error'" :class="styles.pad">
					<div role="alert"
						:class="[empty.root, empty.empty]">Could not read this address: {{ failure }}</div>
				</div>

				<template v-else-if="last">
					<section v-if="!route.detail" :class="headStyles.root">
						<span :class="headStyles.kind">{{ head.kind }}</span>
						<h1
							:class="headStyles.title"><template v-if="head.repo"><span :class="headStyles.dim">{{ head.repo }}</span><span :class="headStyles.mark">:</span></template>{{ head.name }}</h1>
						<p v-if="head.description"
							:class="headStyles.lede">{{ head.description }}</p>
					</section>

					<nav aria-label="Views" :class="tabStyles.root">
						<a
							v-for="tab in tabDefs"
							:key="tab.key"
							:href="tab.href"
							:aria-current="route.tab === tab.key ? 'page' : undefined"
							:class="[tabStyles.tab, tab.ownerOnly && 'owner-only']"
						>
              {{ tab.label }}
              <span v-if="tab.count !== undefined" :class="tabStyles.count">{{ tab.count }}</span>
            </a>
					</nav>

					<div v-if="banner" role="status"
						:class="styles.banner">{{ banner }}</div>
					<div v-if="back"
						:class="styles.back"><a :href="back.href">← {{ back.label }}</a></div>

					<IssueDetail v-if="route.detail?.type === 'issue'" :key="pathname"
						:number="route.detail.n" :node="last" :scope="scope" />
					<NewNode v-else-if="route.detail?.type === 'new-node'" :key="pathname"
						:kind="route.detail.kind" :node="last" />
					<div
						v-else-if="route.detail?.type === 'new-issue' && last.kind === 'group'"
						:class="styles.pad">
						<div
							:class="[empty.root, empty.empty]">Issues belong to a repo or a project. Open one from there.</div>
					</div>
					<IssuesRefused
						v-else-if="route.detail?.type === 'new-issue' && issuesOff"
						:reason="last.issuesEnabled === false ? 'extension_disabled' : 'not_installed'"
						message="" />
					<NewIssue v-else-if="route.detail?.type === 'new-issue'"
						:key="pathname" :node="last" :scope="scope" />
					<ProjectList v-else-if="route.tab === 'projects'" :node="last"
						:scope="scope" />
					<IssueList v-else-if="route.tab === 'issues'" :key="pathname"
						:node="last" :scope="scope" />
					<ActivityList v-else-if="route.tab === 'activity'" :node="last" />
					<GroupOverview v-else-if="last.kind === 'group'" :node="last"
						:scope="scope" />
					<MonoOverview v-else-if="last.kind === 'repo' && last.children.length"
						:key="pathname" :node="last" :scope="scope" />
					<LeafOverview v-else :key="pathname" :node="last" :repo="repo!"
						:scope="scope" />
				</template>
			</main>
		</SplitPane>
	</div>
</template>
