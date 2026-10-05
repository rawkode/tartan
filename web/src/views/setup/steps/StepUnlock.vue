<script setup lang="ts">
// Step 1: prove control of the account. A token from the URL
// fragment (already removed from the address bar by main.ts) is submitted
// once, automatically. Otherwise the owner pastes the deploy's setup token,
// or asks the forge for a single-use claim code (`POST /-/setup/code`, WP2),
// which it writes to Workers Logs only, and pastes that. The value is never
// displayed; the setup session itself rides in WP2's `__Host-` cookie.
import { inject, onMounted, ref, useId } from "vue";
import { useApi } from "../../../app/context.ts";
import { errorMessage } from "../../../api/http.ts";
import { SETUP_TOKEN } from "../../../setup/fragment.ts";

const emit = defineEmits<{ unlocked: [] }>();

const api = useApi();
const id = useId();
const fragmentToken = inject(SETUP_TOKEN, null);
const code = ref("");
const busy = ref(false);
const error = ref<string | null>(null);
const triedFragment = ref(false);

/** The claim-code request: `null` until asked, then whether a new code was logged. */
const codeLogged = ref<boolean | null>(null);
const codeBusy = ref(false);
const codeError = ref<string | null>(null);

const unlock = async (value: string): Promise<void> => {
	busy.value = true;
	error.value = null;
	try {
		await api.setup.unlock(value);
		emit("unlocked");
	} catch (e) {
		error.value = errorMessage(e);
	} finally {
		busy.value = false;
	}
};

const requestCode = async (): Promise<void> => {
	codeBusy.value = true;
	codeError.value = null;
	try {
		codeLogged.value = (await api.setup.code()).created;
	} catch (e) {
		codeError.value = errorMessage(e);
	} finally {
		codeBusy.value = false;
	}
};

onMounted(() => {
	if (fragmentToken && !triedFragment.value) {
		triedFragment.value = true;
		void unlock(fragmentToken);
	}
});

const submit = (): void => {
	const value = code.value.trim();
	if (value.length >= 16) void unlock(value);
	else error.value = "That is too short to be a setup token or claim code.";
};
</script>

<template>
	<div class="tt-stack">
		<p v-if="fragmentToken && busy" aria-live="polite">Checking the setup token from your deploy link…</p>
		<p v-else-if="fragmentToken && !error" class="chip chip--success">Setup token received from the deploy link.</p>
		<form class="tt-stack" novalidate @submit.prevent="submit">
			<p class="tt-muted">
				Paste the setup token your deploy printed, or a one-time claim code from this forge's Workers Logs.
			</p>
			<div class="tt-field">
				<label :for="`${id}-code`" class="tt-field__label">Setup token or claim code</label>
				<input
					:id="`${id}-code`"
					v-model="code"
					class="tt-input"
					type="password"
					name="setup-code"
					autocomplete="off"
					spellcheck="false"
					:aria-invalid="error !== null"
					:aria-describedby="error ? `${id}-error` : undefined"
				/>
			</div>
			<p v-if="error" :id="`${id}-error`" class="chip chip--danger" role="alert">{{ error }}</p>
			<div class="tt-row">
				<button type="submit" class="tt-button tt-button--primary" :disabled="busy">
					{{ busy ? "Checking…" : "Unlock setup" }}
				</button>
			</div>
		</form>
		<section class="tt-stack claim-code" :aria-labelledby="`${id}-claim`">
			<h3 :id="`${id}-claim`" class="claim-code__title">No setup token?</h3>
			<p class="tt-muted">
				Deployed with the button? Ask the forge for a claim code. It writes a single-use code (valid 24 hours)
				to Workers Logs only: open the dashboard's Logs tab, or run <code>npx wrangler tail</code>, and look for
				<code>[tartan] setup code</code>.
			</p>
			<div class="tt-row">
				<button type="button" class="tt-button" :disabled="codeBusy" @click="requestCode">
					{{ codeBusy ? "Asking…" : "Write a claim code to the logs" }}
				</button>
			</div>
			<p v-if="codeLogged === true" class="chip chip--success" role="status">
				A claim code is in Workers Logs now. Paste it above.
			</p>
			<p v-else-if="codeLogged === false" class="chip chip--muted" role="status">
				No new code was written: a valid claim code is already in the logs, or this forge was deployed with a
				setup token (use the link your deploy printed).
			</p>
			<p v-if="codeError" class="chip chip--danger" role="alert">{{ codeError }}</p>
			<p class="tt-hint">
				Anyone who can read this account's Workers Logs can claim the forge until you finish setup.
			</p>
		</section>
	</div>
</template>

<style scoped>
.claim-code {
	padding-top: var(--tt-space-4);
	border-top: 1px solid var(--tt-border);
}

.claim-code__title {
	font-size: var(--tt-text-md);
}
</style>
