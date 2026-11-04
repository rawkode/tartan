<script setup lang="ts">
import { computed } from "vue";
import { css } from "../../styled-system/css";
import { line, text } from "../../styled-system/recipes";
import { useSession } from "../app/context.ts";
import { useResource } from "../composables/resource.ts";
import { commitHref } from "../router/params.ts";
import { age, type ForgeNode, useForge } from "./data/index.ts";
import { useSignInHref } from "./nav.ts";

const props = defineProps<{ node: ForgeNode }>();

const store = useForge();
const signIn = useSignInHref();
const session = useSession();

const handle = (id: string): string | null => {
	const me = session.principal();
	return me && me.id === id ? me.handle : null;
};

const signedOut = computed(() => session.state.status === "anonymous");
const events = useResource(
	() => props.node.addr,
	() => store.activity(props.node, handle),
);

const rows = line();
const page = css({
	display: "flex",
	flexDirection: "column",
	paddingInline: "7",
	paddingBlockStart: "3.5",
	paddingBlockEnd: "12",
});
const monoMuted = text({ mono: true, tone: "muted", size: "xs" });
const when = css({ flex: "[0 0 4ch]" });
const by = css({ overflowWrap: "anywhere" });
</script>

<template>
	<div :class="page">
		<div v-for="event in events.data.value ?? []" :key="event.seq"
			:class="rows.root">
			<span :class="[monoMuted, when]">{{ age(event.at) }}</span>
			<a v-if="event.sha" :href="commitHref(node.addr, event.sha)"
				:class="monoMuted">{{ event.sha.slice(0, 7) }}</a>
			<span :class="rows.title">{{ event.text }}{{ event.subject ? `: ${event.subject}` : "" }}</span>
			<span :class="[monoMuted, by]">{{ event.actor }}</span>
		</div>
		<p v-if="events.loading.value && !events.data.value" role="status"
			:class="rows.empty">Loading…</p>
		<p v-else-if="signedOut" :class="rows.empty"><a
				:href="signIn" data-reload>Sign in</a> to see this repo's activity.</p>
		<p v-else-if="events.error.value" role="alert"
			:class="rows.empty">Could not read the activity: {{ events.error.value }}</p>
		<p v-else-if="events.data.value && !events.data.value.length"
			:class="rows.empty">Nothing has happened here yet.</p>
	</div>
</template>
