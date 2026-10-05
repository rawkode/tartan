<script setup lang="ts">
// `acme / platform / router`: each ancestor links to its node page.
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { nodeHref } from "../router/params.ts";

const props = defineProps<{ path: string }>();
const crumbs = computed(() => {
	const parts = props.path.split("/").filter((p) => p !== "");
	return parts.map((name, i) => ({
		name,
		href: nodeHref(parts.slice(0, i + 1).join("/")),
		last: i === parts.length - 1,
	}));
});
</script>

<template>
	<nav class="crumbs" aria-label="Namespace">
		<ol class="crumbs__list">
			<li v-for="crumb in crumbs" :key="crumb.href" class="crumbs__item">
				<RouterLink
					:to="crumb.href"
					:aria-current="crumb.last ? 'page' : undefined"
					:class="{ 'crumbs__last': crumb.last }"
				>{{ crumb.name }}</RouterLink>
			</li>
		</ol>
	</nav>
</template>

<style scoped>
.crumbs__list {
	display: flex;
	flex-wrap: wrap;
	margin: 0;
	padding: 0;
	list-style: none;
	font-size: var(--tt-text-sm);
}

.crumbs__item + .crumbs__item::before {
	content: "/";
	padding-inline: var(--tt-space-1);
	color: var(--tt-text-muted);
}

.crumbs__item a {
	color: var(--tt-text-muted);
	text-decoration: none;
}

.crumbs__item a:hover {
	text-decoration: underline;
}

.crumbs__last {
	color: var(--tt-text) !important;
	font-weight: 600;
}
</style>
