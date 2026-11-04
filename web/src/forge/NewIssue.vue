<script setup lang="ts">
import { computed, ref } from "vue";
import { css } from "../../styled-system/css";
import { detail, form, panel } from "../../styled-system/recipes";
import { Button, Field, Select } from "../design-system/index.ts";
import { createIssue, type ForgeNode } from "./data/index.ts";
import { useForgeNav } from "./nav.ts";

// Opening an issue is what a contributor can do. A monorepo asks which project it belongs to.
const props = defineProps<{ node: ForgeNode; scope: string }>();

const nav = useForgeNav();

const isMono = computed(() =>
	props.node.kind === "repo" && props.node.children.length > 0
);
const projects = computed(() =>
	props.node.children.map((k) => ({ label: k.name, value: k.name }))
);
const project = ref(props.node.children[0]?.name ?? "");

const submit = (event: Event) => {
	const data = new FormData(event.target as HTMLFormElement);
	const title = String(data.get("title") ?? "").trim();
	if (!title) return;
	const where = isMono.value ? `${props.scope}:${project.value}` : props.scope;
	void nav.go(createIssue(where, title, String(data.get("body") ?? "")));
};

const page = detail();
const denied = panel();
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
			:class="[denied.root, denied.empty]"><a href="/-/login">Sign in</a> to contribute.</div>
	</div>
	<div :class="[box, stack, 'member-only']">
		<h1 :class="page.title">New issue in {{ node.name }}</h1>
		<form :class="form()" @submit.prevent="submit">
			<Select v-if="isMono" v-model="project" label="Project" name="project"
				:items="projects" />
			<Field label="Title" name="title" required />
			<Field label="Description" name="body" :rows="6" />
			<Button variant="solid">Open issue</Button>
		</form>
	</div>
</template>
