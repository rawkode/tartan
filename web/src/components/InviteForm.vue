<script setup lang="ts">
// Invite links: single-use, 7 days, bound to a node and a
// role (up to Maintainer). The URL is shown once.
import { ref, shallowRef, useId } from "vue";
import type { InviteCreated } from "@tartan/contract/api.ts";
import { useApi } from "../app/context.ts";
import { errorMessage } from "../api/http.ts";
import { formatTime } from "../ui/format.ts";
import CopyField from "./CopyField.vue";

const props = defineProps<{ defaultNode?: string }>();

const api = useApi();
const id = useId();
const node = ref(props.defaultNode ?? "");
const role = ref<10 | 20 | 30 | 40>(30);
const note = ref("");
const busy = ref(false);
const error = ref<string | null>(null);
const created = shallowRef<InviteCreated | null>(null);

const NODE_RE = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/;

const submit = async (): Promise<void> => {
	if (!NODE_RE.test(node.value.trim())) {
		error.value = "Enter a group or repository path, for example acme/platform.";
		return;
	}
	busy.value = true;
	error.value = null;
	try {
		created.value = await api.invites.create({
			node: node.value.trim(),
			role: role.value,
			...(note.value.trim() ? { note: note.value.trim() } : {}),
		});
		note.value = "";
	} catch (e) {
		error.value = errorMessage(e);
	} finally {
		busy.value = false;
	}
};
</script>

<template>
	<form class="tt-stack" novalidate @submit.prevent="submit">
		<div class="invite-grid">
			<div class="tt-field">
				<label :for="`${id}-node`" class="tt-field__label">Where</label>
				<input :id="`${id}-node`" v-model="node" class="tt-input" name="node" placeholder="acme/platform" spellcheck="false" />
			</div>
			<div class="tt-field">
				<label :for="`${id}-role`" class="tt-field__label">Role</label>
				<select :id="`${id}-role`" v-model.number="role" class="tt-input" name="role">
					<option :value="10">Guest</option>
					<option :value="20">Reporter</option>
					<option :value="30">Developer</option>
					<option :value="40">Maintainer</option>
				</select>
			</div>
		</div>
		<div class="tt-field">
			<label :for="`${id}-note`" class="tt-field__label">Note (optional)</label>
			<input :id="`${id}-note`" v-model="note" class="tt-input" name="note" maxlength="200" />
		</div>
		<p v-if="error" class="chip chip--danger" role="alert">{{ error }}</p>
		<div class="tt-row">
			<button type="submit" class="tt-button" :disabled="busy">{{ busy ? "Creating…" : "Create invite link" }}</button>
		</div>
		<div v-if="created" class="tt-stack">
			<CopyField label="Invite link (shown once)" :value="created.url" />
			<p class="tt-hint">Single use; expires {{ formatTime(created.expiresAt) }}.</p>
		</div>
	</form>
</template>

<style scoped>
.invite-grid {
	display: grid;
	grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
	gap: var(--tt-space-3);
}

@media (max-width: 30rem) {
	.invite-grid {
		grid-template-columns: minmax(0, 1fr);
	}
}
</style>
