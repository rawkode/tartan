<script setup lang="ts">
import { RouterLink } from "vue-router";
import PageHeader from "../../components/PageHeader.vue";
</script>

<template>
	<div class="tt-stack">
		<PageHeader title="Not found" subtitle="Nothing lives at this address, or you cannot see it." />
		<div class="tt-row">
			<RouterLink class="tt-button" to="/">Home</RouterLink>
			<RouterLink class="tt-button" to="/-/explore">Explore</RouterLink>
		</div>
	</div>
</template>
