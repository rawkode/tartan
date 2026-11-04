<script setup lang="ts">
import { SegmentGroup } from "@ark-ui/vue/segment-group";
import { segmented } from "../../styled-system/recipes";

defineProps<{
	// Visible before the choices, or only read out if `hideLabel` is set.
	label: string;
	hideLabel?: boolean;
	items: { label: string; value: string }[];
	modelValue: string;
}>();

const emit = defineEmits<{ "update:modelValue": [value: string] }>();

const styles = segmented();
</script>

<template>
	<SegmentGroup.Root
		:model-value="modelValue"
		:aria-label="hideLabel ? label : undefined"
		:class="styles.root"
		@value-change="$event.value && emit('update:modelValue', $event.value)"
	>
		<SegmentGroup.Label v-if="!hideLabel"
			:class="styles.label">{{ label }}</SegmentGroup.Label>
		<SegmentGroup.Item v-for="item in items" :key="item.value"
			:value="item.value" :class="styles.item">
			<SegmentGroup.ItemText
				:class="styles.text">{{ item.label }}</SegmentGroup.ItemText>
			<SegmentGroup.ItemControl />
			<SegmentGroup.ItemHiddenInput />
		</SegmentGroup.Item>
	</SegmentGroup.Root>
</template>
