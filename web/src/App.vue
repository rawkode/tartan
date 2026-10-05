<script setup lang="ts">
// Application shell (WP18): header with primary navigation, the signed-in
// principal (or "Sign in"), theme toggle, the routed view and toasts. At
// 375 px the navigation folds behind a menu button.
import { computed, ref, watch } from "vue";
import { RouterLink, RouterView, useRoute } from "vue-router";
import { useSession } from "./app/context.ts";
import TtIcon from "./components/TtIcon.vue";
import ToastRegion from "./shell/ToastRegion.vue";
import {
	applyThemePreference,
	nextThemePreference,
	readThemePreference,
} from "./theme.ts";

const session = useSession();
const route = useRoute();

const theme = ref(readThemePreference());
const themeLabel = computed(() => `Theme: ${theme.value} (change)`);
const themeIcon = computed(() =>
	theme.value === "dark" ? "moon" : theme.value === "light" ? "sun" : "settings"
);

const cycleTheme = (): void => {
	theme.value = nextThemePreference(theme.value);
	applyThemePreference(theme.value);
};

const menuOpen = ref(false);
watch(() => route.fullPath, () => {
	menuOpen.value = false;
});

const signedIn = computed(() => session.state.status === "signed-in");
const principal = computed(() => session.principal());

const nav = computed(() => [
	{ to: "/", label: "Home" },
	{ to: "/-/explore", label: "Explore" },
	...(signedIn.value
		? [
			{ to: "/-/agents", label: "Agents" },
			{ to: "/-/extensions", label: "Extensions" },
			{ to: "/-/settings", label: "Settings" },
		]
		: []),
]);

const loginHref = computed(() => session.loginUrl(route.fullPath));
const signingOut = ref(false);
const signOut = async (): Promise<void> => {
	signingOut.value = true;
	try {
		await session.logout();
	} finally {
		signingOut.value = false;
	}
};
</script>

<template>
	<a class="visually-hidden skip-link" href="#main">Skip to content</a>
	<header class="shell-header">
		<RouterLink class="shell-brand" to="/">
			<svg class="shell-logo" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
				<path d="M2 7h20M2 12h20M2 17h20M7 2v20M12 2v20M17 2v20" />
			</svg>
			<span>Tartan</span>
		</RouterLink>
		<button
			type="button"
			class="shell-menu"
			:aria-expanded="menuOpen"
			aria-controls="shell-nav"
			@click="menuOpen = !menuOpen"
		>
			<TtIcon name="menu" />
			<span class="visually-hidden">Menu</span>
		</button>
		<nav
			id="shell-nav"
			class="shell-nav"
			:class="{ 'shell-nav--open': menuOpen }"
			aria-label="Primary"
		>
			<RouterLink
				v-for="item in nav"
				:key="item.to"
				class="shell-nav__link"
				:to="item.to"
			>{{ item.label }}</RouterLink>
		</nav>
		<div class="shell-tools">
			<button
				type="button"
				class="shell-icon-button"
				:aria-label="themeLabel"
				:title="themeLabel"
				@click="cycleTheme"
			>
				<TtIcon :name="themeIcon" />
			</button>
			<template v-if="signedIn && principal">
				<span class="shell-user">
					<img
						class="shell-avatar"
						:src="`/-/avatar/${principal.id}`"
						alt=""
						width="24"
						height="24"
					/>
					<span class="shell-user__handle">{{ principal.handle }}</span>
				</span>
				<button
					type="button"
					class="tt-button tt-button--sm"
					:disabled="signingOut"
					@click="signOut"
				>Sign out</button>
			</template>
			<a
				v-else-if="session.state.status === 'anonymous'"
				class="tt-button tt-button--sm tt-button--primary"
				:href="loginHref"
			>Sign in</a>
		</div>
	</header>
	<main id="main" class="shell-main" tabindex="-1">
		<RouterView />
	</main>
	<ToastRegion />
</template>

<style scoped>
.shell-header {
	position: sticky;
	top: 0;
	z-index: 20;
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--tt-space-2) var(--tt-space-4);
	min-height: var(--tt-header-h);
	padding: var(--tt-space-2) var(--tt-gutter);
	background: var(--tt-surface);
	border-bottom: 1px solid var(--tt-border);
}

.shell-brand {
	display: inline-flex;
	align-items: center;
	gap: var(--tt-space-2);
	font-weight: 700;
	font-size: var(--tt-text-lg);
	color: var(--tt-text);
	text-decoration: none;
	min-height: 2.75rem;
}

.shell-logo {
	fill: none;
	stroke: var(--tt-accent);
	stroke-width: 2;
}

.shell-menu {
	display: none;
	align-items: center;
	justify-content: center;
	width: 2.75rem;
	height: 2.75rem;
	border: 1px solid var(--tt-border);
	border-radius: var(--tt-radius);
	background: none;
	cursor: pointer;
	order: 3;
}

.shell-nav {
	display: flex;
	flex-wrap: wrap;
	gap: var(--tt-space-1) var(--tt-space-4);
	flex: 1 1 auto;
	min-width: 0;
}

.shell-nav__link {
	display: inline-flex;
	align-items: center;
	min-height: 2.75rem;
	color: var(--tt-text-muted);
	text-decoration: none;
}

.shell-nav__link:hover {
	color: var(--tt-text);
}

.shell-nav__link.router-link-exact-active {
	color: var(--tt-text);
	box-shadow: inset 0 -2px 0 var(--tt-accent);
}

.shell-tools {
	display: flex;
	align-items: center;
	gap: var(--tt-space-2);
	margin-inline-start: auto;
}

.shell-icon-button {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 2.75rem;
	height: 2.75rem;
	border: 1px solid var(--tt-border);
	border-radius: var(--tt-radius);
	background: var(--tt-surface-sunken);
	cursor: pointer;
}

.shell-user {
	display: inline-flex;
	align-items: center;
	gap: var(--tt-space-2);
	min-width: 0;
}

.shell-avatar {
	width: 1.5rem;
	height: 1.5rem;
	border-radius: 50%;
	background: var(--tt-surface-sunken);
}

.shell-main {
	max-width: var(--tt-content-max);
	margin: 0 auto;
	padding: var(--tt-space-6) var(--tt-gutter);
}

.shell-main:focus {
	outline: none;
}

.skip-link:focus {
	position: absolute;
	top: var(--tt-space-2);
	left: var(--tt-space-2);
	padding: var(--tt-space-2) var(--tt-space-3);
	background: var(--tt-surface);
	z-index: 30;
}

@media (max-width: 40rem) {
	.shell-menu {
		display: inline-flex;
	}

	.shell-tools {
		order: 2;
	}

	.shell-nav {
		display: none;
		order: 4;
		flex-basis: 100%;
		flex-direction: column;
		gap: 0;
	}

	.shell-nav--open {
		display: flex;
	}

	.shell-nav__link {
		border-top: 1px solid var(--tt-border);
	}

	.shell-nav__link.router-link-exact-active {
		box-shadow: inset 3px 0 0 var(--tt-accent);
		padding-inline-start: var(--tt-space-2);
	}

	.shell-user__handle {
		display: none;
	}

	.shell-main {
		padding-top: var(--tt-space-4);
	}
}
</style>
