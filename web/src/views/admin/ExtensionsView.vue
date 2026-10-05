<script setup lang="ts">
// Extensions admin: installed extensions by node, the package
// registry, and the install flow — choose a package, a node and a mode, read
// the permission sheet the kernel computes, then approve. A single-provider
// interface (queue@1, review@1, …) can be swapped at a node in one step:
// the dry run is the swap sheet, then an Owner applies it.
import { computed, reactive, ref, shallowRef, useId, watch } from "vue";
import { RouterLink } from "vue-router";
import type {
	InstallationDto,
	PackageDto,
	PermissionSheet,
	ReplaceProviderResponse,
} from "@tartan/contract/api.ts";
import {
	PROVIDABLE_INTERFACES,
	type ProvidableInterface,
} from "./interfaces.ts";
import { useApi, useSession } from "../../app/context.ts";
import { errorMessage } from "../../api/http.ts";
import AsyncState from "../../components/AsyncState.vue";
import PageHeader from "../../components/PageHeader.vue";
import { useResource } from "../../composables/resource.ts";
import { useToasts } from "../../shell/toasts.ts";
import { formatTime } from "../../ui/format.ts";

const api = useApi();
const session = useSession();
const toasts = useToasts();
const id = useId();

const signedIn = computed(() => session.state.status === "signed-in");

/**
 * WP7a answers "what is in force at this node" (inherited installations
 * included, nearest first). The page starts where the kernel says (`shownAt`
 * empty: no `node`): the viewer's first readable node with a grant. An
 * invited user has no namespace of their own, so the handle is no default.
 */
const viewAt = ref("");
const shownAt = ref("");
const installations = useResource(
	() => (signedIn.value ? shownAt.value : null),
	(node) =>
		node === null
			? Promise.resolve(null)
			: api.extensions.installations(node === "" ? undefined : node),
);
watch(installations.data, (answer) => {
	if (answer && shownAt.value === "" && viewAt.value === "") {
		viewAt.value = answer.node.path;
	}
});
/** The start-node answer found nothing the viewer may read: not an error. */
const noStart = computed(() =>
	shownAt.value === "" && installations.status.value === 404
);
const inForce = computed(() =>
	(installations.data.value?.installations ?? [])
		.slice()
		.sort((a, b) => b.depth - a.depth)
		.map((i) => i.installation)
);
/** The single-provider interfaces each listed installation provides. */
const providedBy = computed(() => {
	const out = new Map<string, ProvidableInterface[]>();
	for (const i of installations.data.value?.installations ?? []) {
		const ifaces = (i.manifest.provides ?? []).filter((p): p is ProvidableInterface =>
			(PROVIDABLE_INTERFACES as readonly string[]).includes(p)
		);
		if (ifaces.length > 0) out.set(i.installation.id, ifaces);
	}
	return out;
});

const showAt = (): void => {
	const node = viewAt.value.trim();
	if (NODE_RE.test(node)) shownAt.value = node;
};
const packages = useResource(signedIn, (yes) =>
	yes ? api.extensions.packages() : Promise.resolve(null));

const install = reactive({
	pkg: null as PackageDto | null,
	node: "",
	mode: "shadow" as "enforce" | "shadow",
});
const sheet = shallowRef<PermissionSheet | null>(null);
const busy = ref(false);
const error = ref<string | null>(null);

const NODE_RE = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/;
const request = computed(() =>
	install.pkg
		? {
			extId: install.pkg.extId,
			version: install.pkg.version,
			node: install.node.trim(),
			mode: install.mode,
		}
		: null
);

// -- Swapping a provider ---------------------------------------------

const swap = reactive({
	from: null as InstallationDto | null,
	iface: null as ProvidableInterface | null,
	target: "",
	node: "",
});
const swapPlan = shallowRef<ReplaceProviderResponse | null>(null);
const swapError = ref<string | null>(null);
const swapBusy = ref(false);

/** Packages that provide the interface being swapped, the current one excepted. */
const swapCandidates = computed(() =>
	swap.iface === null ? [] : (packages.data.value?.packages ?? []).filter((p) =>
		(p.manifest.provides ?? []).includes(swap.iface!) &&
		p.extId !== swap.from?.extId
	)
);
const swapRequest = computed(() => {
	const pkg = swapCandidates.value.find((p) =>
		`${p.extId}@${p.version}` === swap.target
	);
	return pkg && swap.iface !== null
		? {
			node: swap.node.trim(),
			iface: swap.iface,
			extId: pkg.extId,
			version: pkg.version,
		}
		: null;
});

const startSwap = (from: InstallationDto, iface: ProvidableInterface): void => {
	swap.from = from;
	swap.iface = iface;
	swap.node = shownAt.value;
	const first = swapCandidates.value[0];
	swap.target = first ? `${first.extId}@${first.version}` : "";
	swapPlan.value = null;
	swapError.value = null;
};

const cancelSwap = (): void => {
	swap.from = null;
	swap.iface = null;
	swapPlan.value = null;
	swapError.value = null;
};

const STEP_TEXT: Readonly<Record<string, string>> = {
	disable: "Disable",
	enable: "Re-enable",
	install: "Install",
	inherit: "Inherit",
};
const stepText = (step: ReplaceProviderResponse["steps"][number]): string =>
	step.kind === "install"
		? `Install ${step.extId}@${step.version} here`
		: `${STEP_TEXT[step.kind]} ${step.installation.extId} (${step.installation.nodePath})`;

const reviewSwap = async (): Promise<void> => {
	const request = swapRequest.value;
	if (request === null || !NODE_RE.test(request.node)) {
		swapError.value = "Choose the new provider and the group or repository to swap it at.";
		return;
	}
	swapBusy.value = true;
	swapError.value = null;
	try {
		swapPlan.value = await api.extensions.replaceProvider({
			...request,
			dryRun: true,
		});
	} catch (e) {
		swapError.value = errorMessage(e);
	} finally {
		swapBusy.value = false;
	}
};

const applySwap = async (): Promise<void> => {
	const request = swapRequest.value;
	if (request === null || swapPlan.value === null) return;
	swapBusy.value = true;
	swapError.value = null;
	try {
		const done = await api.extensions.replaceProvider(request);
		toasts.push({
			tone: "success",
			text: `${done.iface} at ${done.node} is now provided by ${done.provider?.extId ?? request.extId}.`,
		});
		cancelSwap();
		await installations.reload();
	} catch (e) {
		swapError.value = errorMessage(e);
	} finally {
		swapBusy.value = false;
	}
};

const start = (pkg: PackageDto): void => {
	install.pkg = pkg;
	sheet.value = null;
	error.value = null;
};

const review = async (): Promise<void> => {
	if (!request.value || !NODE_RE.test(request.value.node)) {
		error.value = "Enter the group or repository to install into, for example acme.";
		return;
	}
	busy.value = true;
	error.value = null;
	try {
		sheet.value = await api.extensions.sheet(request.value);
	} catch (e) {
		error.value = errorMessage(e);
	} finally {
		busy.value = false;
	}
};

const approve = async (): Promise<void> => {
	if (!request.value || !sheet.value) return;
	busy.value = true;
	error.value = null;
	try {
		const created = await api.extensions.install(request.value);
		toasts.push({ tone: "success", text: `${created.extId} installed at ${created.nodePath} (${created.mode}).` });
		install.pkg = null;
		sheet.value = null;
		await installations.reload();
	} catch (e) {
		error.value = errorMessage(e);
	} finally {
		busy.value = false;
	}
};
</script>

<template>
	<div class="tt-stack">
		<PageHeader title="Extensions" subtitle="Everything beyond git is an extension: work, review, CI, merge queues, gates." />
		<p v-if="session.state.status === 'anonymous'" class="tt-panel">
			<a :href="session.loginUrl('/-/extensions')">Sign in</a> to manage extensions.
		</p>
		<template v-else>
			<section class="tt-stack" aria-labelledby="installed-title">
				<h2 id="installed-title" class="ext-title">Installed</h2>
				<form class="tt-row ext-at" @submit.prevent="showAt">
					<label :for="`${id}-at`" class="tt-field__label">In force at</label>
					<input
						:id="`${id}-at`"
						v-model="viewAt"
						class="tt-input ext-at__input"
						name="installed-at"
						autocomplete="off"
						spellcheck="false"
					/>
					<button type="submit" class="tt-button tt-button--sm">Show</button>
				</form>
				<p v-if="noStart" class="tt-muted">Enter a namespace to see the extensions in force there.</p>
				<AsyncState
					v-else
					:loading="installations.loading.value"
					:error="installations.error.value"
					:status="installations.status.value"
					:ready="installations.data.value !== null"
					what="installations"
					@retry="installations.reload"
				>
					<div class="tt-scroll-x tt-panel ext-table">
						<table class="tt-table">
							<thead>
								<tr>
									<th scope="col">Extension</th>
									<th scope="col">Node</th>
									<th scope="col">Mode</th>
									<th scope="col">Version</th>
									<th scope="col">Installed</th>
								</tr>
							</thead>
							<tbody>
								<tr v-for="inst in inForce" :key="inst.id">
									<td>
										<RouterLink :to="`/-/extensions/${encodeURIComponent(inst.id)}`">{{ inst.extId }}</RouterLink>
										<span v-if="inst.locked" class="chip chip--muted">locked</span>
										<span v-if="inst.pack" class="chip chip--muted">{{ inst.pack.replace("tartan.pack.", "") }} pack</span>
										<button
											v-for="iface in providedBy.get(inst.id) ?? []"
											:key="iface"
											type="button"
											class="tt-button tt-button--sm ext-swap"
											@click="startSwap(inst, iface)"
										>
											Swap {{ iface }}…
										</button>
									</td>
									<td><code>{{ inst.nodePath }}</code></td>
									<td>
										<span class="chip" :class="inst.mode === 'enforce' ? 'chip--success' : inst.mode === 'shadow' ? 'chip--warning' : 'chip--muted'">{{ inst.mode }}</span>
									</td>
									<td>{{ inst.version }}</td>
									<td>{{ formatTime(inst.installedAt) }}</td>
								</tr>
							</tbody>
						</table>
					</div>
				</AsyncState>
				<form
					v-if="swap.from && swap.iface"
					class="tt-stack tt-panel swap"
					aria-label="Swap provider"
					novalidate
					@submit.prevent="swapPlan ? applySwap() : reviewSwap()"
				>
					<p class="sheet__title">
						Swap the {{ swap.iface }} provider ({{ swap.from.extId }} now)
					</p>
					<div class="install__grid">
						<div class="tt-field">
							<label :for="`${id}-swap-to`" class="tt-field__label">New provider</label>
							<select :id="`${id}-swap-to`" v-model="swap.target" class="tt-input" name="swap-to" @change="swapPlan = null">
								<option v-for="p in swapCandidates" :key="`${p.extId}@${p.version}`" :value="`${p.extId}@${p.version}`">
									{{ p.manifest.name }} ({{ p.extId }}@{{ p.version }})
								</option>
							</select>
							<p v-if="swapCandidates.length === 0" class="tt-hint">No other package provides {{ swap.iface }}.</p>
						</div>
						<div class="tt-field">
							<label :for="`${id}-swap-at`" class="tt-field__label">At</label>
							<input :id="`${id}-swap-at`" v-model="swap.node" class="tt-input" name="swap-at" spellcheck="false" @input="swapPlan = null" />
						</div>
					</div>
					<div v-if="swapPlan" class="sheet" role="region" aria-label="Swap sheet">
						<ol class="sheet__lines">
							<li v-for="(step, i) in swapPlan.steps" :key="i">{{ stepText(step) }}</li>
						</ol>
						<p class="sheet__title">The new provider will be able to:</p>
						<ul class="sheet__lines">
							<li v-for="(line, i) in swapPlan.lines" :key="`l${i}`">{{ line }}</li>
						</ul>
						<p v-if="swapPlan.needsOwner" class="tt-hint">Swapping {{ swapPlan.iface }} needs an Owner of the node.</p>
					</div>
					<p v-if="swapError" class="chip chip--danger" role="alert">{{ swapError }}</p>
					<div class="tt-row">
						<button type="submit" class="tt-button tt-button--primary" :disabled="swapBusy || swapCandidates.length === 0">
							{{ swapBusy ? "Working…" : swapPlan ? "Swap provider" : "Review swap" }}
						</button>
						<button type="button" class="tt-button" @click="cancelSwap">Cancel</button>
					</div>
				</form>
			</section>

			<section class="tt-stack" aria-labelledby="registry-title">
				<h2 id="registry-title" class="ext-title">Available packages</h2>
				<AsyncState
					:loading="packages.loading.value"
					:error="packages.error.value"
					:status="packages.status.value"
					:ready="packages.data.value !== null"
					what="packages"
					@retry="packages.reload"
				>
					<ul class="pkg-list">
						<li v-for="pkg in packages.data.value?.packages ?? []" :key="`${pkg.extId}@${pkg.version}`" class="pkg tt-panel">
							<div class="pkg__head">
								<strong>{{ pkg.manifest.name }}</strong>
								<code class="pkg__id">{{ pkg.extId }}@{{ pkg.version }}</code>
								<span class="chip chip--muted">{{ pkg.runtime }}</span>
								<span v-if="pkg.bundled" class="chip chip--muted">bundled</span>
							</div>
							<p v-if="pkg.manifest.description" class="pkg__desc">{{ pkg.manifest.description }}</p>
							<div class="tt-row">
								<button type="button" class="tt-button tt-button--sm" @click="start(pkg)">Install…</button>
							</div>

							<form
								v-if="install.pkg?.extId === pkg.extId && install.pkg.version === pkg.version"
								class="tt-stack install"
								novalidate
								@submit.prevent="sheet ? approve() : review()"
							>
								<div class="install__grid">
									<div class="tt-field">
										<label :for="`${id}-node`" class="tt-field__label">Install at</label>
										<input :id="`${id}-node`" v-model="install.node" class="tt-input" name="node" placeholder="acme" spellcheck="false" @input="sheet = null" />
									</div>
									<div class="tt-field">
										<label :for="`${id}-mode`" class="tt-field__label">Mode</label>
										<select :id="`${id}-mode`" v-model="install.mode" class="tt-input" name="mode" @change="sheet = null">
											<option value="shadow">Shadow: runs, but its decisions are only recorded</option>
											<option value="enforce">Enforce</option>
										</select>
									</div>
								</div>
								<div v-if="sheet" class="sheet" role="region" aria-label="Permission sheet">
									<p class="sheet__title">{{ pkg.manifest.name }} will be able to:</p>
									<ul class="sheet__lines">
										<li v-for="(line, i) in sheet.lines" :key="i">{{ line }}</li>
									</ul>
									<p v-if="sheet.replaces" class="chip chip--warning">
										Replaces {{ sheet.replaces.ext }} as the {{ sheet.replaces.iface }} provider at {{ sheet.replaces.node }}.
									</p>
									<p v-for="(warning, i) in sheet.warnings" :key="`w${i}`" class="chip chip--warning">{{ warning }}</p>
									<p v-if="sheet.needsOwner" class="tt-hint">This install needs an Owner of the node.</p>
								</div>
								<p v-if="error" class="chip chip--danger" role="alert">{{ error }}</p>
								<div class="tt-row">
									<button type="submit" class="tt-button tt-button--primary" :disabled="busy">
										{{ busy ? "Working…" : sheet ? "Approve and install" : "Review permissions" }}
									</button>
									<button type="button" class="tt-button" @click="install.pkg = null">Cancel</button>
								</div>
							</form>
						</li>
					</ul>
				</AsyncState>
			</section>
		</template>
	</div>
</template>

<style scoped>
.ext-title {
	font-size: var(--tt-text-md);
}

.ext-at {
	align-items: center;
}

.ext-at__input {
	flex: 1 1 12rem;
	min-width: 0;
	max-width: 24rem;
}

.ext-table {
	padding: 0;
}

.pkg-list {
	display: grid;
	grid-template-columns: minmax(0, 1fr);
	gap: var(--tt-space-3);
	margin: 0;
	padding: 0;
	list-style: none;
}

@media (min-width: 64rem) {
	.pkg-list {
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}
}

.pkg {
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-2);
}

.pkg__head {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--tt-space-2);
}

.pkg__id {
	color: var(--tt-text-muted);
}

.pkg__desc {
	margin: 0;
	color: var(--tt-text-muted);
}

.ext-swap {
	margin-inline-start: var(--tt-space-2);
}

.swap {
	max-width: 48rem;
}

.install {
	padding-top: var(--tt-space-3);
	border-top: 1px solid var(--tt-border);
}

.install__grid {
	display: grid;
	grid-template-columns: minmax(0, 1fr);
	gap: var(--tt-space-3);
}

.sheet {
	padding: var(--tt-space-3);
	background: var(--tt-surface-sunken);
	border-radius: var(--tt-radius);
}

.sheet__title {
	margin: 0 0 var(--tt-space-2);
	font-weight: 600;
}

.sheet__lines {
	margin: 0 0 var(--tt-space-2);
	padding-inline-start: 1.25rem;
}
</style>
