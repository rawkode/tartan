<script setup lang="ts">
// `tartan-ui@1` renderer.
//
// Normative rules this component and its host components follow:
// - every node's named props are bound explicitly, one attribute at a time:
//   no `v-bind` object spreading, so an injected `innerHTML`, `style`,
//   `onClick` or `href` can never reach an element;
// - no `v-html` anywhere (markdown renders to VNodes, `UiMarkdown.ts`);
// - avatars come only from `/-/avatar/<principal>`; external links go through
//   the "leaving Tartan" interstitial; strings always render as text;
// - a node that fails the shape check (`guards.ts`), a node deeper than the
//   host limit, and the host-only error chip render as chips: the page never
//   breaks.
import { computed } from "vue";
import { checkNode, errorChipText } from "./guards.ts";
import { MAX_DEPTH } from "./nodeTypes.ts";
import UiAlert from "./nodes/UiAlert.vue";
import UiAvatar from "./nodes/UiAvatar.vue";
import UiBoard from "./nodes/UiBoard.vue";
import UiButton from "./nodes/UiButton.vue";
import UiCode from "./nodes/UiCode.vue";
import UiContainer from "./nodes/UiContainer.vue";
import UiDiff from "./nodes/UiDiff.vue";
import UiFallback from "./nodes/UiFallback.vue";
import UiField from "./nodes/UiField.vue";
import UiForm from "./nodes/UiForm.vue";
import UiKv from "./nodes/UiKv.vue";
import UiLink from "./nodes/UiLink.vue";
import UiList from "./nodes/UiList.vue";
import UiMarkdown from "./nodes/UiMarkdown.ts";
import UiMatrix from "./nodes/UiMatrix.vue";
import UiSparkline from "./nodes/UiSparkline.vue";
import UiTable from "./nodes/UiTable.vue";
import UiTabs from "./nodes/UiTabs.vue";
import UiText from "./nodes/UiText.vue";
import UiTimeline from "./nodes/UiTimeline.vue";
import UiValue from "./nodes/UiValue.vue";

const props = withDefaults(
	defineProps<{ node: unknown; depth?: number }>(),
	{ depth: 1 },
);

const chip = computed(() => errorChipText(props.node));
const check = computed(() =>
	props.depth > MAX_DEPTH
		? { ok: false as const, reason: "nested too deep" }
		: checkNode(props.node)
);
const n = computed(() => (check.value.ok ? check.value.node : null));
const reason = computed(() => (check.value.ok ? undefined : check.value.reason));
</script>

<template>
	<UiFallback v-if="chip !== null" kind="error" :text="chip" />
	<UiFallback
		v-else-if="n === null"
		kind="unsupported"
		text="unsupported node"
		:reason="reason"
	/>
	<UiContainer
		v-else-if="n.t === 'stack' || n.t === 'row' || n.t === 'grid' || n.t === 'section' || n.t === 'card'"
		:kind="n.t"
		:items="n.children ?? []"
		:gap="n.gap"
		:cols="n.cols"
		:title="n.title"
		:depth="depth"
	/>
	<UiTabs v-else-if="n.t === 'tabs'" :tabs="n.tabs" :depth="depth" />
	<hr v-else-if="n.t === 'divider'" class="ui-divider" />
	<UiText
		v-else-if="n.t === 'heading' || n.t === 'text' || n.t === 'label' || n.t === 'badge' || n.t === 'empty'"
		:kind="n.t"
		:text="n.text"
		:tone="n.tone"
		:level="n.level"
		:mono="n.mono"
		:body="n.body"
	/>
	<UiMarkdown v-else-if="n.t === 'markdown'" :md="n.md" />
	<UiCode v-else-if="n.t === 'code'" :text="n.text" :lang="n.lang" />
	<UiLink v-else-if="n.t === 'link'" :text="n.text" :href="n.href" />
	<UiAvatar
		v-else-if="n.t === 'avatar' || n.t === 'icon'"
		:kind="n.t"
		:principal="n.principal"
		:name="n.name"
	/>
	<UiValue
		v-else-if="n.t === 'progress' || n.t === 'stat'"
		:kind="n.t"
		:value="n.value"
		:max="n.max"
		:label="n.label"
		:delta="n.delta"
		:unit="n.unit"
	/>
	<UiKv v-else-if="n.t === 'kv'" :items="n.items" :depth="depth" />
	<UiAlert
		v-else-if="n.t === 'alert'"
		:tone="n.tone"
		:title="n.title"
		:body="n.body"
		:depth="depth"
	/>
	<UiButton
		v-else-if="n.t === 'button' || n.t === 'menu'"
		:kind="n.t"
		:text="n.text"
		:action="n.action"
		:tone="n.tone"
		:items="n.items"
	/>
	<UiForm
		v-else-if="n.t === 'form'"
		:fields="n.fields"
		:submit="n.submit"
		:depth="depth"
	/>
	<UiField
		v-else-if="n.t === 'input' || n.t === 'textarea' || n.t === 'select' || n.t === 'checkbox'"
		:kind="n.t"
		:name="n.name"
		:label="n.label"
		:value="n.value"
		:options="n.options"
		:required="n.required"
	/>
	<UiTable v-else-if="n.t === 'table'" :columns="n.columns" :rows="n.rows" :depth="depth" />
	<UiList v-else-if="n.t === 'list'" :items="n.items" :depth="depth" />
	<UiTimeline v-else-if="n.t === 'timeline'" :items="n.items" />
	<UiDiff
		v-else-if="n.t === 'diff'"
		:repo="n.repo"
		:base="n.base"
		:head="n.head"
		:source="n.source"
		:lane="n.lane"
		:paths="n.paths"
		:patch="n.patch"
	/>
	<UiBoard
		v-else-if="n.t === 'board'"
		:columns="n.columns"
		:cards="n.cards"
		:move-action="n.moveAction"
	/>
	<UiMatrix v-else-if="n.t === 'matrix'" :rows="n.rows" :cols="n.cols" :cells="n.cells" />
	<UiSparkline v-else-if="n.t === 'sparkline'" :values="n.values" />
	<UiFallback v-else kind="unsupported" text="unsupported node" />
</template>

<style scoped>
.ui-divider {
	width: 100%;
	border: 0;
	border-top: 1px solid var(--tt-border);
	margin: var(--tt-space-1) 0;
}
</style>
