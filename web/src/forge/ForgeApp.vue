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
import {
	addrOf,
	findIssue,
	type ForgeNode,
	issueUrl,
	named,
	openIssues,
	parseUrl,
	plural,
	projectsUnder,
	store,
	type Tab,
	titleFor,
	trailAt,
	urlFor,
} from "./data/index.ts";
import { useForgeNav } from "./nav.ts";
import Account from "./Account.vue";
import ActivityList from "./ActivityList.vue";
import GroupOverview from "./GroupOverview.vue";
import IssueDetail from "./IssueDetail.vue";
import IssueList from "./IssueList.vue";
import JumpBox from "./JumpBox.vue";
import LeafOverview from "./LeafOverview.vue";
import MonoOverview from "./MonoOverview.vue";
import NewNode from "./NewNode.vue";
import NewIssue from "./NewIssue.vue";
import ProjectList from "./ProjectList.vue";
import TreeNav from "./TreeNav.vue";

const location = useRoute();
const nav = useForgeNav();

const pathname = computed(() => location.path);
const route = computed(() => parseUrl(pathname.value));
const trail = computed(() => trailAt(route.value.addr));
const scope = computed(() => (trail.value ? addrOf(trail.value) : ""));
const last = computed(() =>
	trail.value?.[trail.value.length - 1] as ForgeNode | undefined
);

const issue = computed(() => {
	const detail = route.value.detail;
	return detail?.type === "issue"
		? findIssue(scope.value, detail.n)
		: undefined;
});

const missing = computed(() => {
	const detail = route.value.detail;
	if (!trail.value || route.value.unknown) return true;
	if (route.value.tab === "projects" && last.value?.kind !== "group") {
		return true;
	}
	if (detail?.type === "new-node" && last.value?.kind !== "group") return true;
	if (detail?.type === "issue") return !issue.value;
	return false;
});

// The old address of a moved issue keeps working, and the bar shows where it lives now.
watch([issue, pathname], ([found]) => {
	if (found && issueUrl(found) !== pathname.value) {
		void nav.replace(issueUrl(found));
	}
});

const crumbs = computed(() => {
	const nodes = trail.value ?? (store.tree ? [store.tree as ForgeNode] : []);
	const detail = route.value.detail;
	const out = nodes.map((node, i) => ({
		name: node.name,
		sep: i === 0 ? "" : node.kind === "project" ? ":" : "/",
		href: urlFor(addrOf(nodes.slice(0, i + 1))),
	}));
	if (detail?.type === "issue") {
		if (last.value?.name === "root") out.pop();
		out.push({ name: String(detail.n), sep: "#", href: "" });
	}
	if (detail?.type === "new-node") out.push({ name: "…", sep: "/", href: "" });
	return out;
});

const tabDefs = computed(() => {
	const node = last.value;
	if (!node) return [];
	const defs: {
		key: Tab;
		label: string;
		count?: number;
		ownerOnly?: boolean;
	}[] = [
		{ key: "overview", label: "Overview" },
		...(node.kind === "group"
			? [{
				key: "projects" as const,
				label: "Projects",
				count: projectsUnder(node, trail.value!.slice(0, -1)).length,
			}]
			: []),
		{ key: "issues", label: "Issues", count: openIssues(scope.value).length },
		{ key: "activity", label: "Activity" },
		// Tartan's own settings pages. A project's only setting is in its file.
		...(node.kind === "project"
			? []
			: [{ key: "settings" as const, label: "Settings", ownerOnly: true }]),
	];
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
		kind = `Group · ${parts.join(", ") || "empty"}`;
	} else if (node.kind === "repo") {
		kind = node.children.length
			? `Monorepo · ${plural(named(node), "project")}`
			: "Repo";
	} else if (node.kind === "project") {
		kind = node.name === "root"
			? "Root project · files no other project claims"
			: `Project · ${node.path}`;
	}
	return {
		kind,
		repo: node.kind === "project" ? parent.name : "",
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
	() => (store.banner?.path === pathname.value ? store.banner.text : ""),
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

				<template v-else-if="last">
					<section v-if="!route.detail" :class="headStyles.root">
						<span :class="headStyles.kind">{{ head.kind }}</span>
						<h1
							:class="headStyles.title"><template v-if="head.repo"><span :class="headStyles.dim">{{ head.repo }}</span><span :class="headStyles.mark">:</span></template>{{ head.name }}</h1>
						<p :class="headStyles.lede">{{ head.description }}</p>
					</section>

					<nav aria-label="Views" :class="tabStyles.root">
						<a
							v-for="tab in tabDefs"
							:key="tab.key"
							:href="urlFor(scope, tab.key === 'overview' ? '' : tab.key)"
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

					<IssueDetail v-if="issue" :key="issue.id" :issue="issue"
						:trail="trail!" :scope="scope" />
					<NewNode v-else-if="route.detail?.type === 'new-node'" :key="pathname"
						:kind="route.detail.kind" :trail="trail!" :scope="scope" />
					<div
						v-else-if="route.detail?.type === 'new-issue' && last.kind === 'group'"
						:class="styles.pad">
						<div
							:class="[empty.root, empty.empty]">Issues belong to a repo or a project. Open one from there.</div>
					</div>
					<NewIssue v-else-if="route.detail?.type === 'new-issue'"
						:key="pathname" :node="last" :scope="scope" />
					<ProjectList v-else-if="route.tab === 'projects'" :trail="trail!"
						:scope="scope" />
					<IssueList v-else-if="route.tab === 'issues'" :key="pathname"
						:node="last" :scope="scope" />
					<ActivityList v-else-if="route.tab === 'activity'" :node="last"
						:scope="scope" />
					<GroupOverview v-else-if="last.kind === 'group'" :trail="trail!"
						:scope="scope" />
					<MonoOverview v-else-if="last.kind === 'repo' && last.children.length"
						:key="pathname" :node="last" :scope="scope" />
					<LeafOverview v-else :trail="trail!" :scope="scope" />
				</template>
			</main>
		</SplitPane>
	</div>
</template>
