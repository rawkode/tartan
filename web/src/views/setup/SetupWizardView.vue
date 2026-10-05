<script setup lang="ts">
// First-run setup wizard (steps in `setup/wizard.ts`).
// main.ts has already taken the setup token out of the URL fragment and
// cleared it with `history.replaceState` before the first render; the
// unlock step submits it from memory and never displays it.
//
// The phase and the setup session come from WP2's `POST /-/setup/status`
// (setup-exempt, any state): `{...SetupStateDto, session}`. Without a valid
// setup session the pre-claim phases start at the unlock step, whatever
// the forge's state (a 30-minute session can expire mid-way).
import { computed, onMounted, ref, shallowRef, watch } from "vue";
import { RouterLink } from "vue-router";
import type {
	SetupStateDto,
	SetupStatusResponse,
} from "@tartan/contract/api.ts";
import { useApi, useSession } from "../../app/context.ts";
import { errorMessage } from "../../api/http.ts";
import PageHeader from "../../components/PageHeader.vue";
import {
	entryStep,
	nextStep,
	postClaimSteps,
	PRE_CLAIM,
	STEP_LABELS,
	type SetupPhase,
	type WizardStep,
} from "../../setup/wizard.ts";
import StepChecks from "./steps/StepChecks.vue";
import StepClaim from "./steps/StepClaim.vue";
import StepContent from "./steps/StepContent.vue";
import StepIdp from "./steps/StepIdp.vue";
import StepName from "./steps/StepName.vue";
import StepPack from "./steps/StepPack.vue";
import StepPeople from "./steps/StepPeople.vue";
import StepSecret from "./steps/StepSecret.vue";
import StepSelfTest from "./steps/StepSelfTest.vue";
import StepUnlock from "./steps/StepUnlock.vue";

const api = useApi();
const session = useSession();

const phase = ref<SetupPhase | null>(null);
const setup = shallowRef<SetupStatusResponse | null>(null);
const step = ref<WizardStep | null>(null);
const error = ref<string | null>(null);

const signedInAdmin = computed(() =>
	session.state.status === "signed-in" && session.isAdmin()
);
// After the claim, `/-/api/me` carries the forge's root-key state; before it,
// the setup status does.
const postClaimRootKey = computed(() =>
	session.state.me?.forge.rootKeyFallback ?? setup.value?.rootKeyFallback ?? false
);

/** Where the wizard lands for a status (no setup session → unlock first). */
const landing = (status: SetupStatusResponse): WizardStep =>
	status.state !== "done" && status.session === null
		? "unlock"
		: entryStep(status.state, signedInAdmin.value);

const load = async (): Promise<void> => {
	error.value = null;
	try {
		const status = await api.setup.status();
		setup.value = status;
		phase.value = status.state;
		step.value = landing(status);
	} catch (e) {
		error.value = errorMessage(e);
	}
};

onMounted(() => void load());

// The session loads in parallel; once a signed-in admin shows up on a set-up
// forge, move from "already set up" to the post-claim steps.
watch(signedInAdmin, (admin) => {
	if (admin && phase.value === "done" && step.value === "already-set-up") {
		step.value = "selftest";
	}
});

const advance = (): void => {
	if (step.value) step.value = nextStep(step.value, postClaimRootKey.value);
};

/** Unlock and the IdP steps change server state: re-read it. */
const onUnlocked = (): void => void load();

const onNamed = (state: SetupStateDto): void => {
	setup.value = { ...state, session: setup.value?.session ?? null };
	advance();
};

const onIdp = (): void => void load();

const steps = computed(() =>
	phase.value === "done" ? postClaimSteps(postClaimRootKey.value) : PRE_CLAIM
);
const stepIndex = computed(() => (step.value ? steps.value.indexOf(step.value) : -1));
</script>

<template>
	<div class="wizard">
		<PageHeader
			title="Set up your forge"
			:subtitle="phase === 'done' ? 'Your forge is ready. A few optional steps remain.' : 'A few minutes, once. Nothing here is shared until you claim the forge.'"
		/>
		<p v-if="error" class="chip chip--danger" role="alert">
			{{ error }} <button type="button" class="tt-button tt-button--sm" @click="load">Try again</button>
		</p>
		<p v-else-if="step === null" aria-live="polite">Loading…</p>

		<template v-else-if="step === 'already-set-up'">
			<section class="tt-panel tt-stack">
				<p>This forge is already set up.</p>
				<p v-if="session.state.status === 'signed-in'" class="tt-muted">
					Only the owner can see the remaining setup steps.
				</p>
				<div class="tt-row">
					<a v-if="session.state.status !== 'signed-in'" class="tt-button tt-button--primary" :href="session.loginUrl('/-/setup')">Sign in</a>
					<RouterLink class="tt-button" to="/">Go to the forge</RouterLink>
				</div>
			</section>
		</template>

		<template v-else>
			<ol class="wizard__steps" aria-label="Setup steps">
				<li
					v-for="(s, i) in steps"
					:key="s"
					class="wizard__step"
					:class="{ 'wizard__step--done': i < stepIndex, 'wizard__step--current': i === stepIndex }"
					:aria-current="i === stepIndex ? 'step' : undefined"
				>
					<span class="wizard__num" aria-hidden="true">{{ i + 1 }}</span>
					<span class="wizard__label">{{ STEP_LABELS[s] }}</span>
				</li>
			</ol>
			<section class="tt-panel wizard__body" :aria-labelledby="`wizard-step-title`">
				<h2 id="wizard-step-title" class="wizard__title">{{ STEP_LABELS[step] }}</h2>
				<StepUnlock v-if="step === 'unlock'" @unlocked="onUnlocked" />
				<StepChecks v-else-if="step === 'checks'" @done="advance" />
				<StepName v-else-if="step === 'name' && setup" :state="setup" @saved="onNamed" />
				<StepIdp v-else-if="step === 'idp' && setup" :state="setup" @configured="onIdp" />
				<StepClaim v-else-if="step === 'claim'" />
				<StepSelfTest v-else-if="step === 'selftest'" @done="advance" />
				<StepPack v-else-if="step === 'pack'" @done="advance" />
				<StepContent v-else-if="step === 'content'" @done="advance" />
				<StepPeople v-else-if="step === 'people'" @done="advance" />
				<StepSecret v-else-if="step === 'secret'" @done="advance" />
				<div v-else-if="step === 'finished'" class="tt-stack">
					<p>All done. Your forge is ready for people and agents.</p>
					<div class="tt-row">
						<RouterLink class="tt-button tt-button--primary" to="/-/explore">Explore your forge</RouterLink>
						<RouterLink class="tt-button" to="/-/agents">Connect an agent</RouterLink>
					</div>
				</div>
			</section>
		</template>
	</div>
</template>

<style scoped>
.wizard {
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-4);
	max-width: 46rem;
}

.wizard__steps {
	display: flex;
	flex-wrap: wrap;
	gap: var(--tt-space-2) var(--tt-space-4);
	margin: 0;
	padding: 0;
	list-style: none;
	font-size: var(--tt-text-sm);
	color: var(--tt-text-muted);
}

.wizard__step {
	display: inline-flex;
	align-items: center;
	gap: var(--tt-space-1);
}

.wizard__num {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 1.5rem;
	height: 1.5rem;
	border-radius: 50%;
	border: 1px solid var(--tt-border);
	font-variant-numeric: tabular-nums;
}

.wizard__step--done .wizard__num {
	background: var(--tt-tone-success-bg);
	color: var(--tt-tone-success);
	border-color: currentColor;
}

.wizard__step--current {
	color: var(--tt-text);
	font-weight: 600;
}

.wizard__step--current .wizard__num {
	background: var(--tt-accent);
	border-color: var(--tt-accent);
	color: var(--tt-on-accent);
}

.wizard__body {
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-4);
}

.wizard__title {
	font-size: var(--tt-text-lg);
}

@media (max-width: 40rem) {
	.wizard__label {
		display: none;
	}

	.wizard__step--current .wizard__label {
		display: inline;
	}
}
</style>
