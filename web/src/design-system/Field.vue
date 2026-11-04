<script setup lang="ts">
import { Field } from "@ark-ui/vue/field";
import { computed } from "vue";
import { field } from "../../styled-system/recipes";

const props = defineProps<{
	label: string;
	name: string;
	type?: string;
	required?: boolean;
	placeholder?: string;
	autocomplete?: string;
	helper?: string;
	mono?: boolean;
	// Renders a textarea with this many rows.
	rows?: number;
}>();

const styles = computed(() => field({ mono: props.mono }));
</script>

<template>
	<Field.Root :required="required" :class="styles.root">
		<Field.Label :class="styles.label">{{ label }}</Field.Label>
		<Field.Textarea
			v-if="rows"
			:name="name"
			:rows="rows"
			:placeholder="placeholder"
			:class="styles.input"
		/>
		<Field.Input
			v-else
			:name="name"
			:type="type ?? 'text'"
			:placeholder="placeholder"
			:autocomplete="autocomplete"
			:class="styles.input"
		/>
		<Field.HelperText v-if="helper"
			:class="styles.helper">{{ helper }}</Field.HelperText>
	</Field.Root>
</template>
