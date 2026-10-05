<script setup lang="ts">
// Post-claim step, the protocol pack: Swarm
// (recommended) or Classic. A pack is a registry package; installing it
// through WP7a's ordinary `POST /-/api/installations` installs its members
// too. It goes at the owner's root namespace (the claim created it from the
// IdP username) unless the owner names another node.
import { ref, useId } from "vue";
import { useApi, useSession } from "../../../app/context.ts";
import { ApiError, errorMessage } from "../../../api/http.ts";

const emit = defineEmits<{ done: [] }>();
const api = useApi();
const session = useSession();
const id = useId();
const pack = ref<"tartan.pack.swarm" | "tartan.pack.classic">("tartan.pack.swarm");
const node = ref(session.principal()?.handle ?? "");
const busy = ref(false);
const error = ref<string | null>(null);

const NODE_RE = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/;

const submit = async (): Promise<void> => {
	const at = node.value.trim();
	if (!NODE_RE.test(at)) {
		error.value = "Enter the namespace to install into, for example your user name.";
		return;
	}
	busy.value = true;
	error.value = null;
	try {
		const pkg = (await api.extensions.packages()).packages
			.filter((p) => p.extId === pack.value)
			.sort((a, b) => b.publishedAt - a.publishedAt)[0];
		if (!pkg) throw new ApiError(404, "not_found", `${pack.value} is not in the registry.`);
		await api.extensions.install({
			extId: pkg.extId,
			version: pkg.version,
			node: at,
			mode: "enforce",
		});
		emit("done");
	} catch (e) {
		error.value = errorMessage(e);
	} finally {
		busy.value = false;
	}
};
</script>

<template>
	<form class="tt-stack" @submit.prevent="submit">
		<fieldset class="packs">
			<legend class="visually-hidden">Protocol pack</legend>
			<label class="pack" :class="{ 'pack--on': pack === 'tartan.pack.swarm' }">
				<input v-model="pack" type="radio" name="pack" value="tartan.pack.swarm" />
				<span>
					<strong>Swarm</strong> <span class="chip chip--success">recommended</span>
					<span class="pack__desc">Agents claim work, each gets its own lane, conflicts are predicted, and a merge queue lands changes on trunk.</span>
				</span>
			</label>
			<label class="pack" :class="{ 'pack--on': pack === 'tartan.pack.classic' }">
				<input v-model="pack" type="radio" name="pack" value="tartan.pack.classic" />
				<span>
					<strong>Classic</strong>
					<span class="pack__desc">Branches and reviewed changes, for teams of humans.</span>
				</span>
			</label>
		</fieldset>
		<div class="tt-field">
			<label :for="`${id}-node`" class="tt-field__label">Install at</label>
			<input
				:id="`${id}-node`"
				v-model="node"
				class="tt-input"
				name="pack-node"
				autocomplete="off"
				spellcheck="false"
				:aria-describedby="`${id}-node-hint`"
			/>
			<p :id="`${id}-node-hint`" class="tt-hint">Your namespace by default; every group and repository below it inherits the pack.</p>
		</div>
		<p class="tt-hint">Any group can choose a different pack later.</p>
		<p v-if="error" class="chip chip--danger" role="alert">{{ error }}</p>
		<div class="tt-row">
			<button type="submit" class="tt-button tt-button--primary" :disabled="busy">{{ busy ? "Installing…" : "Install and continue" }}</button>
			<button type="button" class="tt-button tt-button--muted" :disabled="busy" @click="emit('done')">Skip for now</button>
		</div>
	</form>
</template>

<style scoped>
.packs {
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-2);
	margin: 0;
	padding: 0;
	border: 0;
}

.pack {
	display: flex;
	gap: var(--tt-space-3);
	align-items: flex-start;
	padding: var(--tt-space-3);
	border: 1px solid var(--tt-border);
	border-radius: var(--tt-radius);
	background: var(--tt-surface);
	cursor: pointer;
}

.pack--on {
	border-color: var(--tt-accent);
	box-shadow: 0 0 0 1px var(--tt-accent);
}

.pack input {
	margin-top: 0.3rem;
}

.pack__desc {
	display: block;
	color: var(--tt-text-muted);
	font-size: var(--tt-text-sm);
}
</style>
