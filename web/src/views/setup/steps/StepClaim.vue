<script setup lang="ts">
// Step 5: claim. Signing in with the configured IdP while the
// setup session is valid makes this person the owner and consumes the setup
// token for good.
import { loginHref } from "../../../api/client.ts";

const href = loginHref("/-/setup", { purpose: "bootstrap" });
</script>

<template>
	<div class="tt-stack">
		<p>
			Sign in with your identity provider. The first account to sign in now becomes the owner of this
			forge, and the setup token stops working.
		</p>
		<div class="tt-row">
			<a class="tt-button tt-button--primary" :href="href">Sign in to become owner</a>
		</div>
		<p class="tt-hint">You come back here afterwards to finish the optional steps.</p>
	</div>
</template>
