<script setup lang="ts">
// A read-only value (clone URL, token, snippet) with a copy button.
import { useId } from "vue";
import { useToasts } from "../shell/toasts.ts";

const props = defineProps<{
	label: string;
	value: string;
	multiline?: boolean;
	/** Mask the value on screen (it is still copied in full). */
	secret?: boolean;
}>();

const id = useId();
const toasts = useToasts();

const copy = async (): Promise<void> => {
	try {
		await globalThis.navigator.clipboard.writeText(props.value);
		toasts.push({ tone: "success", text: `${props.label} copied.` }, 3000);
	} catch {
		toasts.push({ tone: "warning", text: "Copy failed: select the text and copy it by hand." });
	}
};
</script>

<template>
	<div class="copy-field">
		<label :for="id" class="tt-field__label">{{ label }}</label>
		<div class="copy-field__row">
			<textarea
				v-if="multiline"
				:id="id"
				class="tt-input copy-field__value"
				:value="value"
				readonly
				rows="3"
				spellcheck="false"
			/>
			<input
				v-else
				:id="id"
				class="tt-input copy-field__value"
				:type="secret ? 'password' : 'text'"
				:value="value"
				readonly
				spellcheck="false"
				autocomplete="off"
			/>
			<button type="button" class="tt-button tt-button--sm" @click="copy">Copy</button>
		</div>
	</div>
</template>

<style scoped>
.copy-field {
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-1);
	min-width: 0;
}

.copy-field__row {
	display: flex;
	gap: var(--tt-space-2);
	align-items: flex-start;
}

.copy-field__value {
	font-family: var(--tt-font-mono);
	font-size: var(--tt-text-sm);
	min-width: 0;
}
</style>
