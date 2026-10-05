<script setup lang="ts">
// Namespace browser (`/-/explore`): the whole hierarchy as an expandable
// tree, loaded level by level. Forge admins can add a top-level group.
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import type { NodeDto } from "@tartan/contract/api.ts";
import { useSession } from "../../app/context.ts";
import CreateNodeForm from "../../components/CreateNodeForm.vue";
import NamespaceBranch from "../../components/NamespaceBranch.vue";
import PageHeader from "../../components/PageHeader.vue";
import { nodeHref } from "../../router/params.ts";

const session = useSession();
const router = useRouter();
const creating = ref(false);
const treeKey = ref(0);
const isAdmin = computed(() => session.isAdmin());

const onCreated = (node: NodeDto): void => {
	creating.value = false;
	treeKey.value += 1;
	void router.push(nodeHref(node.path));
};
</script>

<template>
	<div class="tt-stack">
		<PageHeader title="Explore" subtitle="Every user, group and repository you can see.">
			<template v-if="isAdmin" #actions>
				<button type="button" class="tt-button tt-button--primary" @click="creating = true">New group</button>
			</template>
		</PageHeader>
		<CreateNodeForm v-if="creating" kind="group" @created="onCreated" @cancel="creating = false" />
		<nav class="tt-panel" aria-label="Namespaces">
			<NamespaceBranch :key="treeKey" :parent="null" :depth="0" />
		</nav>
	</div>
</template>
