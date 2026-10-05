<script setup lang="ts">
// `avatar` and `icon`. An avatar image only ever comes from the kernel proxy
// `/-/avatar/<principal>`, never from an extension-supplied URL;
// an icon is a host-owned SVG chosen by name.
import { computed } from "vue";
import TtIcon from "../../components/TtIcon.vue";
import { AVATAR_PRINCIPAL_RE } from "../nodeTypes.ts";

const props = defineProps<{
	kind: "avatar" | "icon";
	principal?: string;
	name?: string;
}>();

const src = computed(() =>
	props.principal !== undefined && AVATAR_PRINCIPAL_RE.test(props.principal)
		? `/-/avatar/${props.principal}`
		: null
);
</script>

<template>
	<span v-if="kind === 'avatar'" class="ui-avatar">
		<img
			v-if="src"
			:src="src"
			alt=""
			width="24"
			height="24"
			loading="lazy"
			decoding="async"
			referrerpolicy="same-origin"
		/>
		<span v-else class="ui-avatar__blank" aria-hidden="true" />
		<span v-if="principal" class="visually-hidden">{{ principal }}</span>
	</span>
	<TtIcon v-else :name="name" :label="name" />
</template>

<style scoped>
.ui-avatar {
	display: inline-flex;
	width: 1.5rem;
	height: 1.5rem;
	border-radius: 50%;
	overflow: hidden;
	background: var(--tt-surface-sunken);
	flex: none;
}

.ui-avatar img,
.ui-avatar__blank {
	width: 100%;
	height: 100%;
	object-fit: cover;
}
</style>
