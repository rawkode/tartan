<script setup lang="ts">
// `link`: same-origin paths are router links; `https://` targets go through
// the "leaving Tartan" interstitial; anything else renders as text, no href.
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { classifyHref, linkLocation } from "../links.ts";

const props = defineProps<{ text: string; href: string }>();

const target = computed(() => classifyHref(props.href));
const to = computed(() => linkLocation(target.value));
</script>

<template>
	<RouterLink
		v-if="to !== null"
		:to="to"
		class="ui-link"
		:class="{ 'ui-link--external': target.kind === 'external' }"
	>{{ text }}<span v-if="target.kind === 'external'" class="visually-hidden"> (leaves Tartan)</span></RouterLink>
	<span v-else class="ui-link ui-link--refused" title="link refused">{{ text }}</span>
</template>
