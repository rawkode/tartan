<script setup lang="ts">
// Post-claim step (optional): a first agent token and invite links for other
// people.
import { RouterLink } from "vue-router";
import InviteForm from "../../../components/InviteForm.vue";

const emit = defineEmits<{ done: [] }>();
</script>

<template>
	<div class="tt-stack">
		<section class="tt-stack" aria-labelledby="agents-title">
			<h3 id="agents-title" class="people-title">Connect an agent</h3>
			<p class="tt-muted">
				Create a token for Claude Code, Codex or another MCP client. You get copy-paste setup snippets.
			</p>
			<div class="tt-row">
				<RouterLink class="tt-button" to="/-/agents">Open Agents</RouterLink>
			</div>
		</section>
		<section class="tt-stack" aria-labelledby="invites-title">
			<h3 id="invites-title" class="people-title">Invite people</h3>
			<InviteForm />
		</section>
		<div class="tt-row">
			<button type="button" class="tt-button tt-button--primary" @click="emit('done')">Continue</button>
		</div>
	</div>
</template>

<style scoped>
.people-title {
	font-size: var(--tt-text-md);
}
</style>
