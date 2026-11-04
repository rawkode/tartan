<script setup lang="ts">
import { createListCollection, Select } from "@ark-ui/vue/select";
import { computed, ref, watch } from "vue";
import { select } from "../../styled-system/recipes";

const props = defineProps<{
	label: string;
	items: { label: string; value: string }[];
	modelValue?: string;
	name?: string;
	size?: "sm" | "md";
}>();

const emit = defineEmits<{ "update:modelValue": [value: string] }>();

const value = ref(props.modelValue);
watch(() => props.modelValue, (next) => (value.value = next));

const onChange = (next: string) => {
	value.value = next;
	emit("update:modelValue", next);
};

const collection = computed(() => createListCollection({ items: props.items }));
const styles = computed(() => select({ size: props.size }));
</script>

<template>
	<Select.Root
		:collection="collection"
		:name="name"
		:model-value="value ? [value] : []"
		:positioning="{ sameWidth: true }"
		:class="styles.root"
		@value-change="onChange($event.value[0])"
	>
		<Select.Label :class="styles.label">{{ label }}</Select.Label>
		<Select.Control :class="styles.control">
			<Select.Trigger :class="styles.trigger">
				<Select.ValueText />
				<Select.Indicator :class="styles.indicator"
					aria-hidden="true">▾</Select.Indicator>
			</Select.Trigger>
		</Select.Control>
		<Select.Positioner>
			<Select.Content :class="styles.content">
				<Select.Item v-for="item in items" :key="item.value" :item="item"
					:class="styles.item">
					<Select.ItemText>{{ item.label }}</Select.ItemText>
					<Select.ItemIndicator aria-hidden="true">✓</Select.ItemIndicator>
				</Select.Item>
			</Select.Content>
		</Select.Positioner>
		<Select.HiddenSelect />
	</Select.Root>
</template>
