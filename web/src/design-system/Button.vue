<script setup lang="ts">
import { button } from "../../styled-system/recipes";

defineProps<{
	href?: string;
	variant?: "solid" | "outline" | "ink";
	size?: "sm" | "md";
	type?: "button" | "submit";
	pressed?: boolean;
	disabled?: boolean;
}>();
</script>

<template>
	<a v-if="href" :href="href" :class="button({ variant, size })"><slot /></a>
	<button
		v-else
		:type="type ?? 'submit'"
		:disabled="disabled"
		:aria-pressed="pressed === undefined ? undefined : pressed"
		:class="button({ variant, size })"
	>
		<slot />
	</button>
</template>
