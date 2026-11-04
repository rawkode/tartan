<script setup lang="ts">
// The shell's account controls: theme, then the signed-in principal or a sign-in link.
import { computed, ref } from "vue";
import { useRoute } from "vue-router";
import { css } from "../../styled-system/css";
import { useSession } from "../app/context.ts";
import TtIcon from "../components/TtIcon.vue";
import { Button } from "../design-system/index.ts";
import {
	applyThemePreference,
	nextThemePreference,
	readThemePreference,
} from "../theme.ts";

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

const principal = computed(() =>
	session.state.status === "signed-in" ? session.principal() : null
);
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

const box = css({ display: "flex", alignItems: "center", gap: "2" });
const icon = css({
	display: "inline-flex",
	alignItems: "center",
	justifyContent: "center",
	width: "8",
	height: "8",
	cursor: "pointer",
});
const handle = css({ fontFamily: "academy-mono", fontSize: "xs" });
</script>

<template>
	<div :class="box">
		<button
			type="button"
			:class="icon"
			:aria-label="themeLabel"
			:title="themeLabel"
			@click="cycleTheme"
		>
			<TtIcon :name="themeIcon" />
		</button>
		<template v-if="principal">
			<span :class="handle">{{ principal.handle }}</span>
			<Button
				type="button"
				variant="ink"
				size="sm"
				:disabled="signingOut"
				@click="signOut"
			>Sign out</Button>
		</template>
		<a
			v-else-if="session.state.status === 'anonymous'"
			:href="loginHref"
			data-reload
		>Sign in</a>
	</div>
</template>
