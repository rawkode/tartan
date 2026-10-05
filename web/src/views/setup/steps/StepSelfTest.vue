<script setup lang="ts">
// Post-claim step: the lane-repo self-test (WP5b's
// `POST /-/api/admin/selftest/lanes`). Runs once when shown; the result is
// displayed only, never applied as a setting change.
import { onMounted, ref, shallowRef } from "vue";
import type { LaneSelfTestResult } from "@tartan/contract/api.ts";
import { useApi } from "../../../app/context.ts";
import { errorMessage } from "../../../api/http.ts";
import SelfTestResult from "../../../components/SelfTestResult.vue";

const emit = defineEmits<{ done: [] }>();
const api = useApi();
const result = shallowRef<LaneSelfTestResult | null>(null);
const running = ref(false);
const error = ref<string | null>(null);

const run = async (): Promise<void> => {
	running.value = true;
	error.value = null;
	try {
		result.value = await api.admin.runLaneSelfTest();
	} catch (e) {
		error.value = errorMessage(e);
	} finally {
		running.value = false;
	}
};

onMounted(() => void run());
</script>

<template>
	<div class="tt-stack">
		<p class="tt-muted">
			Tartan opens one scratch lane as its own repository, through the same path agents use, then deletes it.
		</p>
		<p v-if="running" aria-live="polite">Opening a test lane… this takes a few seconds.</p>
		<SelfTestResult v-if="result" :result="result" />
		<p v-if="error" class="chip chip--warning" role="alert">The self-test could not run: {{ error }}</p>
		<div class="tt-row">
			<button type="button" class="tt-button tt-button--primary" :disabled="running" @click="emit('done')">Continue</button>
			<button type="button" class="tt-button" :disabled="running" @click="run">Run again</button>
		</div>
	</div>
</template>
