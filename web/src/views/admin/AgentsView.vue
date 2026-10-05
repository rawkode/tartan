<script setup lang="ts">
// Agents admin: create an agent principal with a node-scoped,
// role-capped, expiring token; show the token and setup snippets ONCE
// (Claude Code, Codex, git credential helper); revoke tokens; disable agents.
import { computed, reactive, ref, shallowRef, useId } from "vue";
import type { AgentCreatedResponse, AgentDto } from "@tartan/contract/api.ts";
import { useApi, useSession } from "../../app/context.ts";
import { errorMessage } from "../../api/http.ts";
import AsyncState from "../../components/AsyncState.vue";
import CopyField from "../../components/CopyField.vue";
import PageHeader from "../../components/PageHeader.vue";
import { useResource } from "../../composables/resource.ts";
import { useToasts } from "../../shell/toasts.ts";
import { formatTime, relativeTime } from "../../ui/format.ts";

const api = useApi();
const session = useSession();
const toasts = useToasts();
const id = useId();

const agents = useResource(() => session.state.status, (status) =>
	status === "signed-in" ? api.agents.list() : Promise.resolve(null));

const TOOLS = [
	{ value: "claude-code", label: "Claude Code" },
	{ value: "codex", label: "Codex CLI" },
	{ value: "opencode", label: "OpenCode" },
	{ value: "other", label: "Other MCP client" },
] as const;

const ROLES = [
	{ value: 20, label: "Reporter (read)" },
	{ value: 30, label: "Developer (claim, push to own lane)" },
	{ value: 40, label: "Maintainer" },
] as const;

const form = reactive({
	name: "",
	tool: "claude-code" as (typeof TOOLS)[number]["value"],
	model: "",
	node: "",
	maxRole: 30 as 20 | 30 | 40,
	ttlDays: 7,
});
const creating = ref(false);
const createError = ref<string | null>(null);
const created = shallowRef<AgentCreatedResponse | null>(null);

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const NODE_RE = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/;
const valid = computed(() =>
	NAME_RE.test(form.name) && NODE_RE.test(form.node.trim()) &&
	Number.isInteger(form.ttlDays) && form.ttlDays >= 1 && form.ttlDays <= 30
);

const create = async (): Promise<void> => {
	if (!valid.value) return;
	creating.value = true;
	createError.value = null;
	try {
		created.value = await api.agents.create({
			name: form.name,
			tool: form.tool,
			...(form.model.trim() ? { model: form.model.trim() } : {}),
			node: form.node.trim(),
			maxRole: form.maxRole,
			ttlDays: form.ttlDays,
		});
		form.name = "";
		form.model = "";
		await agents.reload();
	} catch (e) {
		createError.value = errorMessage(e);
	} finally {
		creating.value = false;
	}
};

const busyIds = reactive(new Set<string>());
const act = async (key: string, fn: () => Promise<unknown>, done: string): Promise<void> => {
	if (!globalThis.confirm?.(`${done}?`)) return;
	busyIds.add(key);
	try {
		await fn();
		toasts.push({ tone: "success", text: `${done}.` });
		await agents.reload();
	} catch (e) {
		toasts.push({ tone: "danger", text: errorMessage(e) });
	} finally {
		busyIds.delete(key);
	}
};

const revoke = (tokenId: string) =>
	act(tokenId, () => api.agents.revokeToken(tokenId), "Revoke this token");
const disable = (agent: AgentDto) =>
	act(agent.id, () => api.agents.disable(agent.id), `Disable ${agent.handle}`);

const now = Date.now();
</script>

<template>
	<div class="tt-stack">
		<PageHeader title="Agents" subtitle="Tokens for coding agents. Each agent works in its own lane and can only push there." />

		<p v-if="session.state.status === 'anonymous'" class="tt-panel">
			<a :href="session.loginUrl('/-/agents')">Sign in</a> to manage agents.
		</p>

		<template v-else>
			<section v-if="created" class="tt-panel tt-stack agent-created" aria-labelledby="created-title">
				<h2 id="created-title" class="agents-title">{{ created.agent.handle }} is ready</h2>
				<p class="chip chip--warning">Copy these now. The token is shown only once.</p>
				<CopyField label="Token" :value="created.token" secret />
				<CopyField label="Claude Code" :value="created.snippets.claudeCode" multiline />
				<CopyField label="Codex CLI (~/.codex/config.toml)" :value="created.snippets.codex" multiline />
				<CopyField label="Git credential helper" :value="created.snippets.gitCredential" multiline />
				<div class="tt-row">
					<button type="button" class="tt-button" @click="created = null">I have copied them</button>
				</div>
			</section>

			<form class="tt-panel tt-stack" novalidate aria-labelledby="new-agent-title" @submit.prevent="create">
				<h2 id="new-agent-title" class="agents-title">New agent</h2>
				<div class="agents-grid">
					<div class="tt-field">
						<label :for="`${id}-name`" class="tt-field__label">Name</label>
						<input :id="`${id}-name`" v-model="form.name" class="tt-input" name="name" autocomplete="off" spellcheck="false" placeholder="claude-laptop" :aria-invalid="form.name !== '' && !NAME_RE.test(form.name)" />
					</div>
					<div class="tt-field">
						<label :for="`${id}-tool`" class="tt-field__label">Tool</label>
						<select :id="`${id}-tool`" v-model="form.tool" class="tt-input" name="tool">
							<option v-for="tool in TOOLS" :key="tool.value" :value="tool.value">{{ tool.label }}</option>
						</select>
					</div>
					<div class="tt-field">
						<label :for="`${id}-model`" class="tt-field__label">Model (optional)</label>
						<input :id="`${id}-model`" v-model="form.model" class="tt-input" name="model" maxlength="80" />
					</div>
					<div class="tt-field">
						<label :for="`${id}-node`" class="tt-field__label">Scope (group or repo)</label>
						<input :id="`${id}-node`" v-model="form.node" class="tt-input" name="node" placeholder="acme/platform" spellcheck="false" :aria-invalid="form.node !== '' && !NODE_RE.test(form.node.trim())" />
					</div>
					<div class="tt-field">
						<label :for="`${id}-role`" class="tt-field__label">Highest role</label>
						<select :id="`${id}-role`" v-model.number="form.maxRole" class="tt-input" name="maxRole">
							<option v-for="role in ROLES" :key="role.value" :value="role.value">{{ role.label }}</option>
						</select>
					</div>
					<div class="tt-field">
						<label :for="`${id}-ttl`" class="tt-field__label">Expires after (days)</label>
						<input :id="`${id}-ttl`" v-model.number="form.ttlDays" class="tt-input" type="number" min="1" max="30" step="1" name="ttlDays" />
					</div>
				</div>
				<p v-if="createError" class="chip chip--danger" role="alert">{{ createError }}</p>
				<div class="tt-row">
					<button type="submit" class="tt-button tt-button--primary" :disabled="!valid || creating">
						{{ creating ? "Creating…" : "Create agent and token" }}
					</button>
				</div>
			</form>

			<section class="tt-stack" aria-labelledby="agents-list-title">
				<h2 id="agents-list-title" class="agents-title">Your agents</h2>
				<AsyncState
					:loading="agents.loading.value"
					:error="agents.error.value"
					:status="agents.status.value"
					:ready="agents.data.value !== null"
					what="agents"
					@retry="agents.reload"
				>
					<p v-if="agents.data.value?.agents.length === 0" class="tt-muted">No agents yet.</p>
					<ul v-else class="agent-list">
						<li v-for="agent in agents.data.value?.agents ?? []" :key="agent.id" class="agent tt-panel">
							<div class="agent__head">
								<div class="agent__name">
									<strong>{{ agent.handle }}</strong>
									<span class="tt-muted">{{ agent.display }}</span>
								</div>
								<span v-if="agent.tool" class="chip chip--muted">{{ agent.tool }}</span>
								<span v-if="agent.model" class="chip chip--muted">{{ agent.model }}</span>
								<span v-if="agent.disabled" class="chip chip--danger">disabled</span>
								<button
									v-else
									type="button"
									class="tt-button tt-button--sm tt-button--danger"
									:disabled="busyIds.has(agent.id)"
									@click="disable(agent)"
								>Disable</button>
							</div>
							<div class="tt-scroll-x">
								<table class="tt-table">
									<thead>
										<tr>
											<th scope="col">Scope</th>
											<th scope="col">Role</th>
											<th scope="col">Expires</th>
											<th scope="col">Last used</th>
											<th scope="col"><span class="visually-hidden">Actions</span></th>
										</tr>
									</thead>
									<tbody>
										<tr v-for="token in agent.tokens" :key="token.id">
											<td><code>{{ token.nodePath ?? "forge" }}</code></td>
											<td>{{ token.maxRole }}</td>
											<td>{{ formatTime(token.expiresAt) }}</td>
											<td>{{ token.lastUsedAt ? relativeTime(token.lastUsedAt, now) : "never" }}</td>
											<td>
												<span v-if="token.revoked" class="chip chip--muted">revoked</span>
												<button
													v-else
													type="button"
													class="tt-button tt-button--sm"
													:disabled="busyIds.has(token.id)"
													@click="revoke(token.id)"
												>Revoke</button>
											</td>
										</tr>
									</tbody>
								</table>
							</div>
						</li>
					</ul>
				</AsyncState>
			</section>
		</template>
	</div>
</template>

<style scoped>
.agents-title {
	font-size: var(--tt-text-md);
}

.agents-grid {
	display: grid;
	grid-template-columns: minmax(0, 1fr);
	gap: var(--tt-space-3);
}

@media (min-width: 40rem) {
	.agents-grid {
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}
}

@media (min-width: 64rem) {
	.agents-grid {
		grid-template-columns: repeat(3, minmax(0, 1fr));
	}
}

.agent-created {
	border-color: var(--tt-tone-warning);
}

.agent-list {
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-3);
	margin: 0;
	padding: 0;
	list-style: none;
}

.agent {
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-2);
}

.agent__head {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--tt-space-2);
}

.agent__name {
	display: flex;
	flex-direction: column;
	flex: 1 1 10rem;
	min-width: 0;
}
</style>
