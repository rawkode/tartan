<script setup lang="ts">
// Post-claim step (optional): a first group, then a repository in it — empty,
// the bundled sample monorepo, or an import of a public repo.
import { ref } from "vue";
import type { NodeDto } from "@tartan/contract/api.ts";
import CreateNodeForm from "../../../components/CreateNodeForm.vue";

const emit = defineEmits<{ done: [] }>();
const group = ref<NodeDto | null>(null);
const repo = ref<NodeDto | null>(null);
</script>

<template>
	<div class="tt-stack">
		<template v-if="!group">
			<p class="tt-muted">Create a group for your team or project. You can skip this and do it later.</p>
			<CreateNodeForm kind="group" @created="group = $event" @cancel="emit('done')" />
		</template>
		<template v-else-if="!repo">
			<p class="chip chip--success">Group <code>{{ group.path }}</code> created.</p>
			<CreateNodeForm kind="repo" :parent="group.path" @created="repo = $event" @cancel="emit('done')" />
		</template>
		<template v-else>
			<p class="chip chip--success">Repository <code>{{ repo.path }}</code> created.</p>
			<div class="tt-row">
				<button type="button" class="tt-button tt-button--primary" @click="emit('done')">Continue</button>
			</div>
		</template>
		<div v-if="!repo" class="tt-row">
			<button type="button" class="tt-button tt-button--muted" @click="emit('done')">Skip for now</button>
		</div>
	</div>
</template>
