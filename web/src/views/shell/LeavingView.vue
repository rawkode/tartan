<script setup lang="ts">
// "Leaving Tartan" interstitial. External
// links from extension UI and markdown land here with `?to=<url>`; only
// `https:` URLs without credentials are offered, the full URL is shown as
// text with its host highlighted, and the link carries `rel="noopener
// noreferrer"`.
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import PageHeader from "../../components/PageHeader.vue";
import { httpsUrl } from "../../ui/links.ts";

const route = useRoute();
const router = useRouter();

const target = computed((): string | null => httpsUrl(route.query["to"]));
const host = computed(() => (target.value ? new URL(target.value).host : ""));

const back = (): void => {
	if (globalThis.history.length > 1) router.back();
	else void router.push("/");
};
</script>

<template>
	<div class="leaving tt-stack">
		<PageHeader title="Leaving Tartan" subtitle="This link goes to another site. Check the address before you continue." />
		<section class="tt-panel tt-stack">
			<template v-if="target">
				<p>You are about to open a page on <strong>{{ host }}</strong>:</p>
				<p class="leaving__url"><code>{{ target }}</code></p>
				<div class="tt-row">
					<a class="tt-button tt-button--primary" :href="target" rel="noopener noreferrer" referrerpolicy="no-referrer">Continue to {{ host }}</a>
					<button type="button" class="tt-button" @click="back">Go back</button>
				</div>
			</template>
			<template v-else>
				<p class="chip chip--warning">This link is not a valid https address, so Tartan will not open it.</p>
				<div class="tt-row">
					<button type="button" class="tt-button" @click="back">Go back</button>
				</div>
			</template>
		</section>
	</div>
</template>

<style scoped>
.leaving {
	max-width: 40rem;
}

.leaving__url {
	margin: 0;
	padding: var(--tt-space-3);
	background: var(--tt-surface-sunken);
	border-radius: var(--tt-radius);
	overflow-wrap: anywhere;
}
</style>
