<script setup lang="ts">
// Step 2: environment checks, with the container check retried
// for up to 2 minutes (a new container app's first start can take ≈ 54 s).
// The lane-repo self-test is NOT here: it runs after the claim.
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import type { EnvironmentCheck } from "@tartan/contract/api.ts";
import { useApi } from "../../../app/context.ts";
import { errorMessage } from "../../../api/http.ts";
import CheckList from "../../../components/CheckList.vue";
import { useScheduler } from "../../../live/scheduler.ts";
import { requiredChecksPass, runChecksWithRetry } from "../../../setup/checks.ts";

const emit = defineEmits<{ done: [] }>();

const api = useApi();
const scheduler = useScheduler();
const checks = shallowRef<readonly EnvironmentCheck[]>([]);
const retrying = ref(false);
const remainingS = ref(0);
const running = ref(false);
const error = ref<string | null>(null);
let unmounted = false;

const run = async (): Promise<void> => {
	running.value = true;
	error.value = null;
	try {
		await runChecksWithRetry({
			fetchChecks: async () => (await api.setup.checks()).checks,
			scheduler,
			cancelled: () => unmounted,
			onProgress: (p) => {
				checks.value = p.checks;
				retrying.value = p.retrying;
				remainingS.value = Math.ceil(p.remainingMs / 1000);
			},
		});
	} catch (e) {
		error.value = errorMessage(e);
	} finally {
		running.value = false;
		retrying.value = false;
	}
};

onMounted(() => void run());
onBeforeUnmount(() => {
	unmounted = true;
});

const canContinue = computed(() => requiredChecksPass(checks.value));
</script>

<template>
	<div class="tt-stack">
		<p class="tt-muted">Tartan checks the Cloudflare products it uses. Optional ones only limit features.</p>
		<p v-if="running && checks.length === 0" aria-live="polite">Running checks…</p>
		<CheckList v-if="checks.length > 0" :checks="checks" :pending="retrying ? ['containers'] : []" />
		<p v-if="retrying" class="chip chip--info" aria-live="polite">
			The container is still starting; checking again (up to {{ remainingS }} s more).
		</p>
		<p v-else-if="!running && checks.some((c) => c.id === 'containers' && !c.ok)" class="tt-hint">
			Containers are unavailable for now: CI shows “unavailable” until they start. You can continue.
		</p>
		<p v-if="error" class="chip chip--danger" role="alert">{{ error }}</p>
		<div class="tt-row">
			<button type="button" class="tt-button tt-button--primary" :disabled="!canContinue" @click="emit('done')">Continue</button>
			<button type="button" class="tt-button" :disabled="running" @click="run">Run checks again</button>
		</div>
	</div>
</template>
