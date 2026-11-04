<script setup lang="ts">
import { computed, ref } from "vue";
import { css } from "../../styled-system/css";
import {
	button,
	detail,
	field,
	panel,
	text,
} from "../../styled-system/recipes";
import { errorMessage } from "../api/http.ts";
import { Segmented } from "../design-system/index.ts";
import { type ForgeNode, useForge } from "./data/index.ts";
import { useForgeNav } from "./nav.ts";

// Only groups and repos are created here. Projects are discovered from their files.
const props = defineProps<{ kind: "group" | "repo"; node: ForgeNode }>();

const store = useForge();
const nav = useForgeNav();

const isGroup = computed(() => props.kind === "group");
const name = ref("");
const description = ref("");
const visibility = ref<string>("public");
const refused = ref("");
const sending = ref(false);

const error = computed(() => {
	if (name.value && !/^[a-z0-9][a-z0-9-]*$/.test(name.value)) {
		return "Use lowercase letters, numbers and hyphens.";
	}
	if (props.node.children.some((k) => k.name === name.value)) {
		return `${props.node.name} already has something called ${name.value}.`;
	}
	return "";
});
const blocked = computed(() => !name.value || !!error.value || sending.value);

const create = async () => {
	if (blocked.value) return;
	sending.value = true;
	refused.value = "";
	try {
		void nav.go(
			await store.createNode(
				props.node,
				props.kind,
				name.value,
				description.value,
				visibility.value === "private" ? "private" : "public",
			),
		);
	} catch (e) {
		refused.value = errorMessage(e);
	} finally {
		sending.value = false;
	}
};

const page = detail();
const input = field({ mono: true });
const plain = field();
const denied = panel();
const headBox = css({
	display: "flex",
	flexDirection: "column",
	gap: "2",
	paddingInline: "7",
	paddingBlockStart: "3",
	paddingBlockEnd: "5",
});
const formBox = css({
	flex: "[999 1 420px]",
	minWidth: "0",
	maxWidth: "[620px]",
	display: "flex",
	flexDirection: "column",
	gap: "4.5",
});
const address = css({
	fontFamily: "academy-mono",
	fontSize: "2xl",
	fontWeight: "extrabold",
	letterSpacing: "academy-tight",
	lineHeight: "academy-title",
	overflowWrap: "anywhere",
});
const submit = css({ alignSelf: "flex-start" });
const deniedBox = css({ paddingInline: "7", paddingBlockEnd: "12" });
</script>

<template>
	<div :class="[deniedBox, 'not-owner']">
		<div
			:class="[denied.root, denied.empty]">Only the owner can create groups and repos.</div>
	</div>
	<div class="owner-only">
		<section :class="headBox">
			<h1 :class="page.title">New {{ kind }} in {{ node.name }}</h1>
			<p :class="text({ tone: 'soft' })">{{ isGroup
        ? 'Groups hold other groups and repos.'
        : 'A new repo starts as a single project. To split it into projects, commit a .cue file in package tartan to a directory.' }}</p>
		</section>
		<div :class="page.columns">
			<form :class="formBox" @submit.prevent="create">
				<div :class="input.root">
					<label for="new-name" :class="input.label">Name</label>
					<input id="new-name" v-model="name" type="text" autocomplete="off"
						:aria-invalid="error ? true : undefined" :class="input.input" />
					<span v-if="error" role="alert"
						:class="input.error">{{ error }}</span>
				</div>
				<div :class="plain.root">
					<label for="new-description" :class="plain.label">Description</label>
					<input id="new-description" v-model="description" type="text"
						autocomplete="off" :class="plain.input" />
				</div>
				<Segmented v-model="visibility" label="Visibility"
					:items="[{ label: 'Public', value: 'public' }, { label: 'Private', value: 'private' }]" />
				<div
					:class="address"><span :class="page.dim">{{ node.addr ? `~/${node.addr}` : "~" }}</span><span :class="page.mark">/</span>{{ name || "…" }}</div>
				<span v-if="refused" role="alert"
					:class="input.error">{{ refused }}</span>
				<button type="submit" :disabled="blocked"
					:class="[button({ variant: 'solid' }), submit]">Create {{ kind }}</button>
			</form>
		</div>
	</div>
</template>
