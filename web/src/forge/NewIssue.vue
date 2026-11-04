<script setup lang="ts">
import { computed, ref } from "vue";
import { css } from "../../styled-system/css";
import { detail, field, form, panel } from "../../styled-system/recipes";
import { errorMessage } from "../api/http.ts";
import { Button, Field, Select } from "../design-system/index.ts";
import { type ForgeNode, useForge } from "./data/index.ts";
import { useForgeNav, useSignInHref } from "./nav.ts";

// Opening an issue is what a contributor can do. A monorepo asks which project it belongs to.
const props = defineProps<{ node: ForgeNode; scope: string }>();

const nav = useForgeNav();
const signIn = useSignInHref();
const store = useForge();

const WHOLE_REPO = "~";
const isMono = computed(() =>
	props.node.kind === "repo" && props.node.children.length > 0
);
const projects = computed(() => [
	{ label: "No project: the whole repo", value: WHOLE_REPO },
	...props.node.children.filter((k) => k.issuesEnabled !== false).map((k) => ({
		label: k.name,
		value: k.name,
	})),
]);
const project = ref(WHOLE_REPO);
const error = ref("");
const sending = ref(false);

const submit = async (event: Event) => {
	const data = new FormData(event.target as HTMLFormElement);
	const title = String(data.get("title") ?? "").trim();
	if (!title || sending.value) return;
	const where = isMono.value && project.value !== WHOLE_REPO
		? `${props.scope}:${project.value}`
		: props.scope;
	sending.value = true;
	error.value = "";
	try {
		void nav.go(
			await store.createIssue(where, title, String(data.get("body") ?? "")),
		);
	} catch (e) {
		error.value = errorMessage(e);
	} finally {
		sending.value = false;
	}
};

const page = detail();
const denied = panel();
const input = field();
const box = css({
	paddingInline: "7",
	paddingBlockStart: "3",
	paddingBlockEnd: "12",
});
const stack = css({ display: "grid", gap: "4" });
</script>

<template>
	<div :class="[box, 'anon-only']">
		<div
			:class="[denied.root, denied.empty]"><a :href="signIn"
				data-reload>Sign in</a> to contribute.</div>
	</div>
	<div :class="[box, stack, 'member-only']">
		<h1 :class="page.title">New issue in {{ node.name }}</h1>
		<form :class="form()" @submit.prevent="submit">
			<Select v-if="isMono" v-model="project" label="Project" name="project"
				:items="projects" />
			<Field label="Title" name="title" required />
			<Field label="Description" name="body" :rows="6" />
			<span v-if="error" role="alert" :class="input.error">{{ error }}</span>
			<Button variant="solid" :disabled="sending">Open issue</Button>
		</form>
	</div>
</template>
