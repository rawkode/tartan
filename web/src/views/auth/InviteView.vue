<script setup lang="ts">
// Invite link landing: signing in from here binds the
// identity to the invite's role and node. The code rides to the kernel in the
// login request (`invite=`), which hashes it into the login transaction.
import { computed } from "vue";
import { useRoute } from "vue-router";
import { loginHref } from "../../api/client.ts";
import PageHeader from "../../components/PageHeader.vue";
import { stringParam } from "../../router/params.ts";

const route = useRoute();
const code = computed(() => stringParam(route.params, "code"));
const valid = computed(() => /^[A-Za-z0-9_-]{8,128}$/.test(code.value));
const href = computed(() => loginHref("/", { invite: code.value }));
</script>

<template>
	<div class="invite tt-stack">
		<PageHeader title="You're invited" subtitle="Sign in with your identity provider to accept." />
		<section class="tt-panel tt-stack">
			<template v-if="valid">
				<p>This invite works once and expires seven days after it was created.</p>
				<a class="tt-button tt-button--primary" :href="href">Accept and sign in</a>
			</template>
			<p v-else class="chip chip--warning">This invite link is not valid. Ask for a new one.</p>
		</section>
	</div>
</template>

<style scoped>
.invite {
	max-width: 32rem;
}
</style>
