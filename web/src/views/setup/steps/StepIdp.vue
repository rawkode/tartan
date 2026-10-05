<script setup lang="ts">
// Step 4: identity provider. "Paste your
// issuer URL": the kernel discovers it (SSRF-guarded, exact issuer match,
// PKCE S256) and registers Tartan by RFC 7591 DCR as a public PKCE client.
// An initial access token, if the IdP needs one, is sent once and never
// stored. If the IdP has no registration endpoint or registration fails, the
// owner enters a client id by hand (public client by default; secret or
// private_key_jwt for confidential clients). Recipes cover Cloudflare Access
// (the zero-new-vendor alternative) and the common IdPs.
import { computed, reactive, ref, useId } from "vue";
import type { IdpClientAuth, SetupStateDto } from "@tartan/contract/api.ts";
import { useApi } from "../../../app/context.ts";
import { errorMessage } from "../../../api/http.ts";
import CopyField from "../../../components/CopyField.vue";
import { checkIssuer, jwksUri, redirectUri } from "../../../setup/issuer.ts";

const props = defineProps<{ state: SetupStateDto }>();
const emit = defineEmits<{ configured: [] }>();

const api = useApi();
const id = useId();
const origin = computed(() =>
	props.state.canonicalOrigin ??
		(typeof globalThis.location === "undefined" ? "" : globalThis.location.origin)
);

const issuer = ref("");
const initialAccessToken = ref("");
const showOptions = ref(false);
const options = reactive({
	scopes: "",
	usernameClaim: "",
	allowedEmailDomains: "",
	jitProvisioning: false,
});
const busy = ref(false);
const error = ref<string | null>(null);
const registeredClientId = ref<string | null>(null);
const mode = ref<"dcr" | "manual">("dcr");

const manual = reactive({
	clientId: "",
	clientAuth: "none" as IdpClientAuth,
	clientSecret: "",
});

const issuerCheck = computed(() => checkIssuer(issuer.value));
const needsSecret = computed(() =>
	manual.clientAuth === "client_secret_basic" || manual.clientAuth === "client_secret_post"
);

const extras = () => ({
	...(options.scopes.trim() ? { scopes: options.scopes.trim() } : {}),
	...(options.usernameClaim.trim() ? { usernameClaim: options.usernameClaim.trim() } : {}),
	...(options.allowedEmailDomains.trim()
		? {
			allowedEmailDomains: options.allowedEmailDomains.split(",").map((d) => d.trim())
				.filter((d) => d !== ""),
		}
		: {}),
	...(options.jitProvisioning ? { jitProvisioning: true } : {}),
});

const register = async (): Promise<void> => {
	const check = issuerCheck.value;
	if (!check.ok) {
		error.value = check.error;
		return;
	}
	busy.value = true;
	error.value = null;
	try {
		const result = await api.setup.registerIdp({
			issuer: check.issuer,
			...(initialAccessToken.value.trim()
				? { initialAccessToken: initialAccessToken.value.trim() }
				: {}),
			...extras(),
		});
		registeredClientId.value = result.clientId;
		initialAccessToken.value = "";
	} catch (e) {
		error.value = errorMessage(e);
		mode.value = "manual";
	} finally {
		busy.value = false;
	}
};

const configureManually = async (): Promise<void> => {
	const check = issuerCheck.value;
	if (!check.ok) {
		error.value = check.error;
		return;
	}
	if (manual.clientId.trim() === "") {
		error.value = "Enter the client id your identity provider gave you.";
		return;
	}
	busy.value = true;
	error.value = null;
	try {
		await api.setup.configureIdp({
			issuer: check.issuer,
			clientId: manual.clientId.trim(),
			clientAuth: manual.clientAuth,
			...(needsSecret.value && manual.clientSecret !== ""
				? { clientSecret: manual.clientSecret }
				: {}),
			...extras(),
		});
		manual.clientSecret = "";
		emit("configured");
	} catch (e) {
		error.value = errorMessage(e);
	} finally {
		busy.value = false;
	}
};

const RECIPES = [
	{
		name: "Rawkode Academy ID (id.rawkode.academy)",
		steps: [
			"Paste https://id.rawkode.academy above and choose Register.",
			"Tartan registers itself as a public client with PKCE; no secret is created.",
		],
	},
	{
		name: "Cloudflare Access (no new vendor)",
		steps: [
			"Zero Trust → Access → Applications → Add an application → SaaS → OIDC.",
			"Set the redirect URL to the one shown under “Enter a client id instead”.",
			"Copy the issuer and client id; use client_secret_post with the client secret.",
		],
	},
	{
		name: "Google, Entra ID, Okta, Auth0",
		steps: [
			"Create an OIDC web application with the redirect URL shown below.",
			"Most of these require a confidential client: choose client_secret_basic and paste the secret.",
		],
	},
	{
		name: "Keycloak, Authentik, Pocket ID",
		steps: [
			"These usually support dynamic registration: paste the issuer and choose Register.",
			"If registration needs an initial access token, create one in the admin console and paste it once.",
		],
	},
] as const;
</script>

<template>
	<div class="tt-stack">
		<template v-if="registeredClientId">
			<p class="chip chip--success">Registered. Client id <code>{{ registeredClientId }}</code> (a public client with PKCE).</p>
			<div class="tt-row">
				<button type="button" class="tt-button tt-button--primary" @click="emit('configured')">Continue</button>
			</div>
		</template>
		<template v-else>
			<form class="tt-stack" novalidate @submit.prevent="mode === 'dcr' ? register() : configureManually()">
				<div class="tt-field">
					<label :for="`${id}-issuer`" class="tt-field__label">Issuer URL</label>
					<input
						:id="`${id}-issuer`"
						v-model="issuer"
						class="tt-input"
						type="url"
						name="issuer"
						placeholder="https://id.example.com"
						spellcheck="false"
						autocomplete="url"
						:aria-invalid="issuer !== '' && !issuerCheck.ok"
						:aria-describedby="`${id}-issuer-hint`"
					/>
					<p :id="`${id}-issuer-hint`" class="tt-hint">
						Your identity provider's OpenID Connect issuer, exactly as its discovery document states it.
					</p>
				</div>
				<p v-if="issuer !== '' && issuerCheck.ok && issuerCheck.warning" class="chip chip--warning">{{ issuerCheck.warning }}</p>

				<template v-if="mode === 'dcr'">
					<div class="tt-field">
						<label :for="`${id}-iat`" class="tt-field__label">Initial access token (only if your provider requires one)</label>
						<input
							:id="`${id}-iat`"
							v-model="initialAccessToken"
							class="tt-input"
							type="password"
							name="initialAccessToken"
							autocomplete="off"
							spellcheck="false"
						/>
						<p class="tt-hint">Sent once with the registration request and never stored.</p>
					</div>
				</template>
				<template v-else>
					<CopyField label="Redirect URI to register at your provider" :value="redirectUri(origin)" />
					<div class="tt-field">
						<label :for="`${id}-client`" class="tt-field__label">Client id</label>
						<input :id="`${id}-client`" v-model="manual.clientId" class="tt-input" name="clientId" autocomplete="off" spellcheck="false" />
					</div>
					<div class="tt-field">
						<label :for="`${id}-auth`" class="tt-field__label">Client authentication</label>
						<select :id="`${id}-auth`" v-model="manual.clientAuth" class="tt-input" name="clientAuth">
							<option value="none">None: public client with PKCE (recommended)</option>
							<option value="client_secret_basic">Client secret (HTTP Basic)</option>
							<option value="client_secret_post">Client secret (form post)</option>
							<option value="private_key_jwt">Private key JWT</option>
						</select>
					</div>
					<div v-if="needsSecret" class="tt-field">
						<label :for="`${id}-secret`" class="tt-field__label">Client secret</label>
						<input :id="`${id}-secret`" v-model="manual.clientSecret" class="tt-input" type="password" name="clientSecret" autocomplete="off" />
						<p class="tt-hint">Sealed at rest; never shown again.</p>
					</div>
					<CopyField v-if="manual.clientAuth === 'private_key_jwt'" label="JWKS URL for your provider" :value="jwksUri(origin)" />
				</template>

				<details class="idp-options" :open="showOptions" @toggle="showOptions = ($event.target as HTMLDetailsElement).open">
					<summary>Advanced options</summary>
					<div class="tt-stack idp-options__body">
						<div class="tt-field">
							<label :for="`${id}-scopes`" class="tt-field__label">Scopes</label>
							<input :id="`${id}-scopes`" v-model="options.scopes" class="tt-input" name="scopes" placeholder="openid profile email groups" />
						</div>
						<div class="tt-field">
							<label :for="`${id}-claim`" class="tt-field__label">Username claim</label>
							<input :id="`${id}-claim`" v-model="options.usernameClaim" class="tt-input" name="usernameClaim" placeholder="preferred_username" />
						</div>
						<div class="tt-field">
							<label :for="`${id}-domains`" class="tt-field__label">Allowed email domains (comma separated)</label>
							<input :id="`${id}-domains`" v-model="options.allowedEmailDomains" class="tt-input" name="allowedEmailDomains" />
						</div>
						<label class="idp-check">
							<input v-model="options.jitProvisioning" type="checkbox" name="jitProvisioning" />
							Let people with a verified email in those domains sign up without an invite
						</label>
					</div>
				</details>

				<p v-if="error" class="chip chip--danger" role="alert">{{ error }}</p>
				<p v-if="error && mode === 'manual'" class="tt-hint">Registration did not work, so enter a client id instead.</p>
				<div class="tt-row">
					<button type="submit" class="tt-button tt-button--primary" :disabled="busy || !issuerCheck.ok">
						{{ busy ? "Working…" : mode === "dcr" ? "Register Tartan" : "Save identity provider" }}
					</button>
					<button
						type="button"
						class="tt-button"
						@click="mode = mode === 'dcr' ? 'manual' : 'dcr'; error = null"
					>{{ mode === "dcr" ? "Enter a client id instead" : "Use dynamic registration" }}</button>
				</div>
			</form>

			<section class="tt-stack" aria-labelledby="recipes-title">
				<h3 id="recipes-title" class="recipes-title">Recipes</h3>
				<details v-for="recipe in RECIPES" :key="recipe.name" class="recipe">
					<summary>{{ recipe.name }}</summary>
					<ol class="recipe__steps">
						<li v-for="(step, i) in recipe.steps" :key="i">{{ step }}</li>
					</ol>
				</details>
			</section>
		</template>
	</div>
</template>

<style scoped>
.idp-options > summary,
.recipe > summary {
	cursor: pointer;
	min-height: 2.75rem;
	display: flex;
	align-items: center;
	font-weight: 600;
}

.idp-options__body {
	padding-top: var(--tt-space-2);
}

.idp-check {
	display: flex;
	align-items: center;
	gap: var(--tt-space-2);
	min-height: 2.75rem;
}

.recipes-title {
	font-size: var(--tt-text-md);
}

.recipe {
	border-bottom: 1px solid var(--tt-border);
}

.recipe__steps {
	margin: 0 0 var(--tt-space-3);
	padding-inline-start: 1.25rem;
}
</style>
