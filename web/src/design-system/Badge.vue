<script setup lang="ts">
import { badge } from "../../styled-system/recipes";
</script>

<template>
	<span :class="badge()"><slot /></span>
</template>
