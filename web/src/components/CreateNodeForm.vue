<script setup lang="ts">
// Create a group or a repo under a parent (or a top-level group). A repo can
// start empty, from the bundled sample monorepo, or as an import of a public
// `https://` git URL. Slugs follow the node grammar.
import { computed, ref, useId } from "vue";
import type { NodeDto } from "@tartan/contract/api.ts";
import type { Visibility } from "@tartan/contract/common.ts";
import { useApi } from "../app/context.ts";
import { errorMessage } from "../api/http.ts";
import { httpsUrl } from "../ui/links.ts";

const props = defineProps<{
	kind: "group" | "repo";
	/** Parent node path; omit for a top-level group. */
	parent?: string;
}>();
const emit = defineEmits<{ created: [node: NodeDto]; cancel: [] }>();

const api = useApi();
const id = useId();
const slug = ref("");
const visibility = ref<Visibility>("private");
const description = ref("");
const source = ref<"empty" | "sample" | "import">("empty");
const importUrl = ref("");
const busy = ref(false);
const error = ref<string | null>(null);

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const slugValid = computed(() => SLUG_RE.test(slug.value));
const importValid = computed(() =>
	source.value !== "import" || httpsUrl(importUrl.value.trim()) !== null
);
const canSubmit = computed(() =>
	slugValid.value && importValid.value && !busy.value &&
	(props.kind === "group" || props.parent !== undefined)
);

const submit = async (): Promise<void> => {
	if (!canSubmit.value) return;
	busy.value = true;
	error.value = null;
	try {
		const common = {
			slug: slug.value,
			visibility: visibility.value,
			...(description.value.trim() ? { description: description.value.trim() } : {}),
		};
		const created = props.kind === "group"
			? await api.nodes.createGroup({
				kind: "group",
				...(props.parent ? { parent: props.parent } : {}),
				...common,
			})
			: await api.nodes.createRepo({
				parent: props.parent ?? "",
				...common,
				...(source.value === "sample" ? { sample: true } : {}),
				...(source.value === "import"
					? { import: { url: httpsUrl(importUrl.value.trim()) ?? "" } }
					: {}),
			});
		emit("created", created);
		slug.value = "";
		description.value = "";
		importUrl.value = "";
	} catch (e) {
		error.value = errorMessage(e);
	} finally {
		busy.value = false;
	}
};
</script>

<template>
	<form class="create-node tt-panel" novalidate @submit.prevent="submit">
		<h3 class="create-node__title">
			New {{ kind }}<template v-if="parent"> in <code>{{ parent }}</code></template>
		</h3>
		<div class="tt-field">
			<label :for="`${id}-slug`" class="tt-field__label">Name</label>
			<input
				:id="`${id}-slug`"
				v-model="slug"
				class="tt-input"
				name="slug"
				autocomplete="off"
				spellcheck="false"
				:aria-invalid="slug !== '' && !slugValid"
				:aria-describedby="`${id}-slug-hint`"
			/>
			<p :id="`${id}-slug-hint`" class="tt-hint">Lowercase letters, digits and dashes; starts with a letter or digit.</p>
		</div>
		<div class="tt-field">
			<label :for="`${id}-vis`" class="tt-field__label">Visibility</label>
			<select :id="`${id}-vis`" v-model="visibility" class="tt-input" name="visibility">
				<option value="private">Private: members only</option>
				<option value="internal">Internal: everyone signed in</option>
				<option value="public">Public: anyone, read-only</option>
			</select>
		</div>
		<div class="tt-field">
			<label :for="`${id}-desc`" class="tt-field__label">Description (optional)</label>
			<input :id="`${id}-desc`" v-model="description" class="tt-input" name="description" maxlength="500" />
		</div>
		<fieldset v-if="kind === 'repo'" class="create-node__source">
			<legend class="tt-field__label">Content</legend>
			<label class="create-node__radio">
				<input v-model="source" type="radio" value="empty" name="source" />
				Empty repository (one initial commit)
			</label>
			<label class="create-node__radio">
				<input v-model="source" type="radio" value="sample" name="source" />
				Sample monorepo (api, web and a shared package)
			</label>
			<label class="create-node__radio">
				<input v-model="source" type="radio" value="import" name="source" />
				Import a public repository
			</label>
			<div v-if="source === 'import'" class="tt-field">
				<label :for="`${id}-url`" class="tt-field__label">Git URL (https)</label>
				<input
					:id="`${id}-url`"
					v-model="importUrl"
					class="tt-input"
					type="url"
					name="import"
					placeholder="https://github.com/owner/repo.git"
					:aria-invalid="importUrl !== '' && !importValid"
				/>
				<p class="tt-hint">Large or private repositories use the owner-only import mode instead.</p>
			</div>
		</fieldset>
		<p v-if="error" class="chip chip--danger" role="alert">{{ error }}</p>
		<div class="tt-row">
			<button type="submit" class="tt-button tt-button--primary" :disabled="!canSubmit">
				{{ busy ? "Creating…" : `Create ${kind}` }}
			</button>
			<button type="button" class="tt-button" @click="emit('cancel')">Cancel</button>
		</div>
	</form>
</template>

<style scoped>
.create-node {
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-3);
}

.create-node__title {
	font-size: var(--tt-text-md);
}

.create-node__source {
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-1);
	margin: 0;
	padding: 0;
	border: 0;
}

.create-node__radio {
	display: flex;
	align-items: center;
	gap: var(--tt-space-2);
	min-height: 2.75rem;
}
</style>
