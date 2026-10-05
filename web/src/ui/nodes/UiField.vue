<script setup lang="ts">
// `input`, `textarea`, `select`, `checkbox`. Inside a `form` the value lives in
// the form's state (by field name); outside one it is local. Labels, option
// labels and values are always text.
import { computed, inject, shallowRef, useId, watch } from "vue";
import type { UiJson } from "../nodeTypes.ts";
import { UI_FORM } from "../context.ts";
import { initialFieldValue } from "../forms.ts";

type FieldValue = string | number | boolean | null | readonly (string | number)[];
type Option = string | number | {
	readonly value: string | number | boolean;
	readonly label: string;
};

const props = defineProps<{
	kind: "input" | "textarea" | "select" | "checkbox";
	name: string;
	label?: string;
	value?: FieldValue;
	options?: readonly Option[];
	required?: boolean;
}>();

const id = useId();
const form = inject(UI_FORM, null);

const options = computed(() =>
	(props.options ?? []).map((option) =>
		typeof option === "object"
			? { value: option.value, label: option.label }
			: { value: option, label: String(option) }
	)
);

const initial = (): UiJson =>
	initialFieldValue(props.kind, props.value, props.options);

const local = shallowRef<UiJson>(initial());
if (form) form.register(props.name, local.value);

const current = computed<UiJson>({
	get: () => (form ? (form.values[props.name] ?? null) : local.value),
	set: (next) => {
		if (form) form.values[props.name] = next;
		else local.value = next;
	},
});

watch(
	() => props.value,
	() => {
		current.value = initial();
	},
);

const isNumeric = computed(() => typeof props.value === "number");

const onInput = (event: Event): void => {
	const raw = (event.target as HTMLInputElement | HTMLTextAreaElement).value;
	current.value = isNumeric.value && raw !== "" && Number.isFinite(Number(raw))
		? Number(raw)
		: raw;
};

const onCheck = (event: Event): void => {
	current.value = (event.target as HTMLInputElement).checked;
};

const selectedIndex = computed(() =>
	options.value.findIndex((option) => option.value === current.value)
);

const onSelect = (event: Event): void => {
	const index = Number((event.target as HTMLSelectElement).value);
	current.value = options.value[index]?.value ?? null;
};

const text = computed(() =>
	typeof current.value === "string" || typeof current.value === "number"
		? String(current.value)
		: ""
);
</script>

<template>
	<div class="ui-field" :class="`ui-field--${kind}`">
		<template v-if="kind === 'checkbox'">
			<input
				:id="id"
				type="checkbox"
				:name="name"
				:checked="current === true"
				:required="required"
				@change="onCheck"
			/>
			<label :for="id">{{ label ?? name }}</label>
		</template>
		<template v-else>
			<label :for="id" class="ui-field__label">
				{{ label ?? name }}<span v-if="required" aria-hidden="true"> *</span>
			</label>
			<textarea
				v-if="kind === 'textarea'"
				:id="id"
				class="tt-input"
				:name="name"
				:required="required"
				:value="text"
				rows="4"
				@input="onInput"
			/>
			<select
				v-else-if="kind === 'select'"
				:id="id"
				class="tt-input"
				:name="name"
				:required="required"
				:value="String(selectedIndex)"
				@change="onSelect"
			>
				<option
					v-for="(option, index) in options"
					:key="index"
					:value="String(index)"
				>{{ option.label }}</option>
			</select>
			<input
				v-else
				:id="id"
				class="tt-input"
				:type="isNumeric ? 'number' : 'text'"
				:name="name"
				:required="required"
				:value="text"
				@input="onInput"
			/>
		</template>
	</div>
</template>

<style scoped>
.ui-field {
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-1);
	min-width: 0;
}

.ui-field--checkbox {
	flex-direction: row;
	align-items: center;
	gap: var(--tt-space-2);
	min-height: 2.75rem;
}

.ui-field__label {
	font-size: var(--tt-text-sm);
	font-weight: 600;
}
</style>
