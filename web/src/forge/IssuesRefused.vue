<script setup lang="ts">
// Why there is no issue list here, in the words of the refusal.
import { computed } from "vue";
import { css } from "../../styled-system/css";
import { panel } from "../../styled-system/recipes";
import type { IssuesRefusal } from "./data/index.ts";
import { useSignInHref } from "./nav.ts";

const props = defineProps<{ reason: IssuesRefusal; message: string }>();
const signIn = useSignInHref();

const text = computed(() => {
	switch (props.reason) {
		case "not_installed":
			return "Issues is not installed on this repo.";
		case "extension_disabled":
			return "Issues is turned off for this project, in its .cue file.";
		case "not_found":
			return "Nothing at that address.";
		case "denied":
			return "You do not have access to the issues here.";
		case "unauthenticated":
			return "";
		case "error":
			return `Could not read the issues: ${props.message}`;
	}
	return "";
});

const box = panel();
const pad = css({
	paddingInline: "7",
	paddingBlockStart: "3.5",
	paddingBlockEnd: "12",
});
</script>

<template>
	<div :class="pad">
		<div v-if="reason === 'unauthenticated'"
			:class="[box.root, box.empty]"><a :href="signIn"
				data-reload>Sign in</a> to see the issues here.</div>
		<div v-else :role="reason === 'error' ? 'alert' : undefined"
			:class="[box.root, box.empty]">{{ text }}</div>
	</div>
</template>
