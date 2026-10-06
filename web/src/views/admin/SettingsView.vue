<script setup lang="ts">
// Forge settings and health. What the kernel serves today: the forge name and
// the root-key notice (`GET /-/api/me`), the build and its bindings
// (`/-/health`), the lane-repo self-test (`GET`/`POST
// /-/api/admin/selftest/lanes`, the forge Owner only), the global log tile
// (`/-/api/log/status` and `/-/api/log/dead`, the forge Owner) and invite links. A
// read-only summary of the identity provider, push limits and lane defaults
// and exporting a generated root key have no kernel route yet, so the page
// says so instead of calling routes that answer 404, 405 or 501.
import { computed, ref, shallowRef } from "vue";
import type { LaneSelfTestResult } from "@tartan/contract/api.ts";
import { useApi, useSession } from "../../app/context.ts";
import { errorMessage } from "../../api/http.ts";
import AsyncState from "../../components/AsyncState.vue";
import GlobalLogPanel from "../../components/GlobalLogPanel.vue";
import InviteForm from "../../components/InviteForm.vue";
import PageHeader from "../../components/PageHeader.vue";
import SelfTestResult from "../../components/SelfTestResult.vue";
import TtIcon from "../../components/TtIcon.vue";
import { useResource } from "../../composables/resource.ts";

const api = useApi();
const session = useSession();
const signedIn = computed(() => session.state.status === "signed-in");
const isAdmin = computed(() => session.isAdmin());
const forge = computed(() => session.state.me?.forge ?? null);

const health = useResource(() => 0, () => api.health());

// The lane-repo self-test: the last result, and a run on request (never on
// page load: a run creates and deletes a scratch lane repository).
const lastSelfTest = useResource(
	() => (isAdmin.value ? 1 : 0),
	async () => (isAdmin.value ? await api.admin.lastLaneSelfTest() : null),
);
const ranSelfTest = shallowRef<LaneSelfTestResult | null>(null);
const runningSelfTest = ref(false);
const selfTestError = ref<string | null>(null);
const selfTest = computed(() =>
	ranSelfTest.value ?? lastSelfTest.data.value?.last ?? null
);
const runSelfTest = async (): Promise<void> => {
	runningSelfTest.value = true;
	selfTestError.value = null;
	try {
		ranSelfTest.value = await api.admin.runLaneSelfTest();
	} catch (e) {
		selfTestError.value = errorMessage(e);
	} finally {
		runningSelfTest.value = false;
	}
};
</script>

<template>
	<div class="tt-stack">
		<PageHeader title="Settings" subtitle="How this forge is configured. Change these through your deploy config or the setup wizard." />
		<p v-if="session.state.status === 'anonymous'" class="tt-panel">
			<a :href="session.loginUrl('/-/settings')">Sign in</a> to see the forge settings.
		</p>
		<template v-else>
			<p v-if="forge?.rootKeyFallback" class="chip chip--warning">
				<TtIcon name="lock" /> Root key held in Durable Object storage. Moving it into TARTAN_SECRET from here arrives with milestone M2.
			</p>
			<section class="tt-panel tt-stack" aria-labelledby="forge-title">
				<h2 id="forge-title" class="set-title">Forge</h2>
				<dl class="set-kv">
					<dt>Name</dt><dd>{{ forge?.name ?? "not set" }}</dd>
					<template v-if="health.data.value">
						<dt>Version</dt><dd>{{ health.data.value.product }} {{ health.data.value.version }}</dd>
						<dt>Stage</dt><dd><code>{{ health.data.value.stage }}</code></dd>
						<dt>Compatibility date</dt><dd>{{ health.data.value.compatDate }}</dd>
					</template>
				</dl>
				<p class="tt-hint">
					A read-only summary of the identity provider, push limits and lane defaults arrives with milestone M2.
					Each repository's Owner sets its lane settings on the repository's Settings page.
				</p>
			</section>

			<section class="tt-panel tt-stack" aria-labelledby="health-title">
				<h2 id="health-title" class="set-title">Health</h2>
				<AsyncState
					:loading="health.loading.value"
					:error="health.error.value"
					:ready="health.data.value !== null"
					what="health"
					@retry="health.reload"
				>
					<ul v-if="health.data.value" class="bindings">
						<li v-for="(status, name) in health.data.value.bindings" :key="name" class="chip" :class="status === 'ok' ? 'chip--success' : status === 'missing' ? 'chip--warning' : 'chip--danger'">
							{{ name }}: {{ status }}
						</li>
					</ul>
				</AsyncState>
				<template v-if="isAdmin">
					<h3 class="set-subtitle">Lane-repo self-test</h3>
					<p class="tt-muted">
						Lanes are per-agent Artifacts repositories created with import(), with branch lanes as the fallback.
						The self-test opens one scratch lane repository through the path agents use, then deletes it (the forge Owner only).
					</p>
					<SelfTestResult v-if="selfTest" :result="selfTest" />
					<p v-else-if="!lastSelfTest.loading.value" class="tt-hint">No self-test has run on this forge yet.</p>
					<p v-if="runningSelfTest" aria-live="polite">Opening a test lane… this takes a few seconds.</p>
					<p v-if="selfTestError" class="chip chip--warning" role="alert">The self-test could not run: {{ selfTestError }}</p>
					<div class="tt-row">
						<button type="button" class="tt-button" :disabled="runningSelfTest" @click="runSelfTest">Run the self-test</button>
					</div>
				</template>
			</section>

			<GlobalLogPanel v-if="isAdmin" />

			<section v-if="signedIn" class="tt-panel tt-stack" aria-labelledby="invite-title">
				<h2 id="invite-title" class="set-title">Invite people</h2>
				<InviteForm />
			</section>
		</template>
	</div>
</template>

<style scoped>
.set-title {
	font-size: var(--tt-text-md);
	margin-bottom: var(--tt-space-2);
}

.set-subtitle {
	font-size: var(--tt-text-sm);
	font-weight: 600;
}

.set-kv {
	display: grid;
	grid-template-columns: minmax(8rem, max-content) minmax(0, 1fr);
	gap: var(--tt-space-1) var(--tt-space-4);
	margin: 0;
}

.set-kv dt {
	color: var(--tt-text-muted);
	font-size: var(--tt-text-sm);
}

.set-kv dd {
	margin: 0;
	overflow-wrap: anywhere;
}

.bindings {
	display: flex;
	flex-wrap: wrap;
	gap: var(--tt-space-2);
	margin: 0;
	padding: 0;
	list-style: none;
}
</style>
