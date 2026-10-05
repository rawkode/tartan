<script setup lang="ts">
// `form`: fields register their values here; submit runs the form's action
// with `formPayload(action.payload, values)`.
import { computed, inject, provide, reactive } from "vue";
import type { UiAction, UiJson } from "../nodeTypes.ts";
import { formPayload, UI_ACTIONS, UI_FORM, type UiFormState } from "../context.ts";
import UiNode from "../UiNode.vue";

const props = defineProps<{
	fields: readonly unknown[];
	submit: { readonly text: string; readonly action: UiAction };
	depth: number;
}>();

const runner = inject(UI_ACTIONS, null);
const busy = computed(() => runner?.busy.value ?? false);
const values = reactive<Record<string, UiJson>>({});

const state: UiFormState = {
	values,
	register: (name, initial) => {
		if (!Object.hasOwn(values, name)) values[name] = initial;
	},
};
provide(UI_FORM, state);

const onSubmit = (): void => {
	if (!runner) return;
	void runner.run(
		props.submit.action,
		formPayload(props.submit.action.payload, values),
	);
};
</script>

<template>
	<form class="ui-form" novalidate @submit.prevent="onSubmit">
		<UiNode
			v-for="(field, index) in fields"
			:key="index"
			:node="field"
			:depth="depth + 1"
		/>
		<div class="ui-form__actions">
			<button type="submit" class="tt-button tt-button--primary" :disabled="!runner || busy">
				{{ submit.text }}
			</button>
		</div>
	</form>
</template>

<style scoped>
.ui-form {
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-3);
}
</style>
