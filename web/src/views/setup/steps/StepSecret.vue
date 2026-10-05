<script setup lang="ts">
// Post-claim step, button path only: the forge generated its root key
// into Durable Object storage because `TARTAN_SECRET` was absent. Offer the
// command to move it into a secret; the value is fetched on request, shown
// once (masked, copyable) and pasted at wrangler's prompt, never in a command
// line or shell history.
import { ref } from "vue";
import { useApi } from "../../../app/context.ts";
import { errorMessage } from "../../../api/http.ts";
import CopyField from "../../../components/CopyField.vue";

const emit = defineEmits<{ done: [] }>();
const api = useApi();
const value = ref<string | null>(null);
const busy = ref(false);
const error = ref<string | null>(null);

const reveal = async (): Promise<void> => {
	busy.value = true;
	error.value = null;
	try {
		value.value = (await api.admin.exportRootKey()).value;
	} catch (e) {
		error.value = errorMessage(e);
	} finally {
		busy.value = false;
	}
};
</script>

<template>
	<div class="tt-stack">
		<p class="chip chip--warning">The root key is held in Durable Object storage.</p>
		<p>
			Move it into a Worker secret so it lives with your other secrets. Run the command below and paste the
			key when wrangler asks for it.
		</p>
		<CopyField label="Command" value="npx wrangler secret put TARTAN_SECRET" />
		<template v-if="value">
			<CopyField label="Root key (shown once)" :value="value" secret />
			<p class="tt-hint">Keep it out of chat and tickets. Anyone with it can decrypt this forge's sealed data.</p>
		</template>
		<p v-if="error" class="chip chip--danger" role="alert">{{ error }}</p>
		<div class="tt-row">
			<button v-if="!value" type="button" class="tt-button" :disabled="busy" @click="reveal">
				{{ busy ? "Fetching…" : "Show the root key" }}
			</button>
			<button type="button" class="tt-button tt-button--primary" @click="emit('done')">
				{{ value ? "Done" : "Later" }}
			</button>
		</div>
	</div>
</template>
