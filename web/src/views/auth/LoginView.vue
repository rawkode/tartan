<script setup lang="ts">
// Sign in: a link to the kernel's `/-/auth/login`, which redirects to
// the identity provider. `return_to` is forced to a same-origin path.
import { computed } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { useSession } from "../../app/context.ts";
import PageHeader from "../../components/PageHeader.vue";
import { sameOriginPath } from "../../ui/links.ts";

const route = useRoute();
const session = useSession();
const returnTo = computed(() => sameOriginPath(route.query["return_to"]) ?? "/");
const href = computed(() => session.loginUrl(returnTo.value));
</script>

<template>
	<div class="login tt-stack">
		<PageHeader title="Sign in" subtitle="Tartan uses your organisation's identity provider. It never sees your password." />
		<section class="tt-panel tt-stack">
			<p v-if="session.state.status === 'signed-in'">
				You are signed in as <strong>{{ session.principal()?.handle }}</strong>.
				<RouterLink :to="returnTo">Continue</RouterLink>
			</p>
			<template v-else>
				<a class="tt-button tt-button--primary" :href="href">Continue to sign in</a>
				<p class="tt-hint">No account yet? Ask an owner for an invite link.</p>
			</template>
		</section>
	</div>
</template>

<style scoped>
.login {
	max-width: 32rem;
}
</style>
