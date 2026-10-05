<script setup lang="ts">
// `/<repo>/-/tree/<ref>/<path>`: the repo code view at a ref and path.
import { computed } from "vue";
import { useRoute } from "vue-router";
import AsyncState from "../../components/AsyncState.vue";
import { refAndPath } from "../../router/params.ts";
import { repoCtx } from "../../slots/ctx.ts";
import RepoCode from "./parts/RepoCode.vue";
import { useNodeView } from "./useNodeView.ts";

const route = useRoute();
const loc = computed(() => refAndPath(route.params, ""));
const node = useNodeView(
	() => `tree/${loc.value.ref}${loc.value.path ? `/${loc.value.path}` : ""}`,
	(path) => repoCtx(path, { ref: loc.value.ref }),
);
</script>

<template>
	<AsyncState
		:loading="node.loading.value"
		:error="node.error.value"
		:status="node.status.value"
		:ready="node.data.value !== null"
		what="this repository"
		@retry="node.reload"
	>
		<RepoCode
			v-if="node.data.value"
			:view="node.data.value"
			:ctx="node.ctx.value"
			:ref-name="loc.ref"
			:path="loc.path"
		/>
	</AsyncState>
</template>
