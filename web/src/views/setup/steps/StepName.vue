<script setup lang="ts">
// Step 3: forge name and canonical origin. The origin defaults
// to this page's origin; the OIDC redirect URI and lane capability URLs use
// it, so a `*.workers.dev` origin gets a warning.
import { computed, ref, useId } from "vue";
import type { SetupStateDto } from "@tartan/contract/api.ts";
import { useApi } from "../../../app/context.ts";
import { errorMessage } from "../../../api/http.ts";
import { httpsUrl } from "../../../ui/links.ts";

const props = defineProps<{ state: SetupStateDto }>();
const emit = defineEmits<{ saved: [state: SetupStateDto] }>();

const api = useApi();
const id = useId();
const here = typeof globalThis.location === "undefined" ? "" : globalThis.location.origin;
const forgeName = ref(props.state.forgeName ?? "");
const origin = ref(props.state.canonicalOrigin ?? here);
const busy = ref(false);
const error = ref<string | null>(null);

const originUrl = computed(() => {
	const url = httpsUrl(origin.value.trim());
	return url === null ? null : new URL(url).origin;
});
const workersDev = computed(() => originUrl.value?.endsWith(".workers.dev") ?? false);
const valid = computed(() => forgeName.value.trim() !== "" && forgeName.value.length <= 80 && originUrl.value !== null);

const submit = async (): Promise<void> => {
	if (!valid.value || originUrl.value === null) return;
	busy.value = true;
	error.value = null;
	try {
		emit("saved", await api.setup.name(forgeName.value.trim(), originUrl.value));
	} catch (e) {
		error.value = errorMessage(e);
	} finally {
		busy.value = false;
	}
};
</script>

<template>
	<form class="tt-stack" novalidate @submit.prevent="submit">
		<div class="tt-field">
			<label :for="`${id}-name`" class="tt-field__label">Forge name</label>
			<input :id="`${id}-name`" v-model="forgeName" class="tt-input" name="forgeName" maxlength="80" autocomplete="organization" />
		</div>
		<div class="tt-field">
			<label :for="`${id}-origin`" class="tt-field__label">Address (canonical origin)</label>
			<input
				:id="`${id}-origin`"
				v-model="origin"
				class="tt-input"
				type="url"
				name="canonicalOrigin"
				spellcheck="false"
				:aria-invalid="origin !== '' && originUrl === null"
			/>
			<p class="tt-hint">An https:// origin. Sign-in redirects and lane capability URLs use it.</p>
		</div>
		<p v-if="workersDev" class="chip chip--warning">
			This is a *.workers.dev address. Attach your custom domain first if you have one.
		</p>
		<p v-if="error" class="chip chip--danger" role="alert">{{ error }}</p>
		<div class="tt-row">
			<button type="submit" class="tt-button tt-button--primary" :disabled="!valid || busy">
				{{ busy ? "Saving…" : "Save and continue" }}
			</button>
		</div>
	</form>
</template>
