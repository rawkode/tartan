<script setup lang="ts">
import { status } from "../../styled-system/recipes";

defineProps<
	{ state?: "neutral" | "open" | "pass" | "merged" | "closed" | "fail" }
>();
</script>

<template>
	<span :class="status({ state })"><slot /></span>
</template>
