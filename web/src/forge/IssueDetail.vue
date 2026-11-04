<script setup lang="ts">
import { computed, ref } from "vue";
import { css } from "../../styled-system/css";
import {
	detail,
	facts,
	field,
	heading,
	panel,
	text,
} from "../../styled-system/recipes";
import { useSession } from "../app/context.ts";
import { errorMessage, isApiError } from "../api/http.ts";
import { Button, Status } from "../design-system/index.ts";
import {
	age,
	type ForgeNode,
	type IssuesRefusal,
	type PlacedIssue,
	urlFor,
	useForge,
} from "./data/index.ts";
import IssuesRefused from "./IssuesRefused.vue";

const props = defineProps<{ number: number; node: ForgeNode; scope: string }>();

const store = useForge();
const session = useSession();

const issue = ref<PlacedIssue | null>(null);
const refusal = ref<{ reason: IssuesRefusal; message: string } | null>(null);
const failure = ref("");
const busy = ref(false);

const read = async () => {
	try {
		issue.value = await store.getIssue(props.scope, props.number);
	} catch (e) {
		const code = isApiError(e) ? e.code : "";
		const reason: IssuesRefusal =
			code === "not_installed" || code === "extension_disabled" ||
				code === "not_found"
				? code
				: isApiError(e) && e.status === 401
				? "unauthenticated"
				: isApiError(e) && e.status === 403
				? "denied"
				: "error";
		refusal.value = { reason, message: errorMessage(e) };
	}
};
void read();

const isOpen = computed(() => issue.value?.state === "open");

const change = async () => {
	if (!issue.value || busy.value) return;
	busy.value = true;
	failure.value = "";
	try {
		const number = issue.value.number;
		const changed = await store.setIssueState(
			props.scope,
			number,
			isOpen.value ? "close" : "reopen",
		);
		issue.value = { ...changed, body: issue.value.body ?? "" };
	} catch (e) {
		failure.value = errorMessage(e);
	} finally {
		busy.value = false;
	}
};

const author = computed(() => {
	const by = issue.value?.author;
	if (!by) return "";
	const me = session.principal();
	return me && me.id === by.id ? me.handle : by.kind;
});

const page = detail();
const list = facts();
const input = field();
const box = panel();
const ruleLabel = heading({ size: "rule" });
const muted = text({ tone: "muted", size: "sm" });
const gapped = css({ display: "flex", flexDirection: "column", gap: "2.5" });
const statusLine = css({
	display: "flex",
	flexWrap: "wrap",
	alignItems: "center",
	columnGap: "4",
	rowGap: "1.5",
});
const ownerName = css({
	fontFamily: "academy-mono",
	fontSize: "sm",
	fontWeight: "extrabold",
	overflowWrap: "anywhere",
});
const actions = css({ display: "flex", flexWrap: "wrap", gap: "2" });
const columns = css({ borderBlockStart: "rule" });
const body = css({ whiteSpace: "pre-wrap", overflowWrap: "anywhere" });
const pad = css({ paddingInline: "7", paddingBlockStart: "3.5" });
</script>

<template>
	<IssuesRefused v-if="refusal" :reason="refusal.reason"
		:message="refusal.message" />
	<div v-else-if="!issue" :class="pad">
		<div role="status" :class="[box.root, box.empty]">Loading…</div>
	</div>
	<template v-else>
		<section :class="page.head">
			<div :class="statusLine">
				<span
					:class="page.id"><span :class="page.dim">{{ node.name }}</span><span :class="page.mark">#</span>{{ issue.number }}</span>
				<Status
					:state="isOpen ? 'open' : 'closed'">{{ isOpen ? "Open" : "Closed" }}</Status>
			</div>
			<h1 :class="page.title">{{ issue.title }}</h1>
		</section>

		<div :class="[page.columns, columns]">
			<div :class="page.main">
				<p v-if="issue.body" :class="[page.note, body]">{{ issue.body }}</p>
				<p v-else :class="muted">No description.</p>

				<div class="member-only" :class="actions">
					<Button type="button" :disabled="busy"
						@click="change">{{ isOpen ? "Close issue" : "Reopen issue" }}</Button>
				</div>
				<span v-if="failure" role="alert"
					:class="input.error">{{ failure }}</span>
			</div>

			<aside aria-label="Issue details" :class="page.aside">
				<section :class="gapped">
					<h2 :class="ruleLabel">{{ issue.where === issue.repo ? "Repo" : "Project" }}</h2>
					<a :href="urlFor(issue.where)"
						:class="ownerName">{{ issue.where }}</a>
				</section>
				<dl :class="list.root">
					<div :class="list.row">
						<dt :class="list.term">Opened by</dt>
						<dd :class="list.value">{{ author }}</dd>
					</div>
					<div :class="list.row">
						<dt :class="list.term">Opened</dt>
						<dd :class="list.value">{{ age(issue.createdAt) }}</dd>
					</div>
					<div :class="list.row">
						<dt :class="list.term">Updated</dt>
						<dd :class="list.value">{{ age(issue.updatedAt) }}</dd>
					</div>
					<div v-if="issue.closedAt" :class="list.row">
						<dt :class="list.term">Closed</dt>
						<dd :class="list.value">{{ age(issue.closedAt) }}</dd>
					</div>
				</dl>
			</aside>
		</div>
	</template>
</template>
