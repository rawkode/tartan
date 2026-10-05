<script setup lang="ts">
// `code`: preformatted text. `lang` is a label only (no highlighter runs
// extension-chosen grammars).
defineProps<{ text: string; lang?: string }>();
</script>

<template>
	<figure class="ui-code">
		<figcaption v-if="lang" class="ui-code__lang">{{ lang }}</figcaption>
		<pre class="ui-code__pre" tabindex="0"><code>{{ text }}</code></pre>
	</figure>
</template>

<style scoped>
.ui-code {
	margin: 0;
	min-width: 0;
}

.ui-code__lang {
	font-size: var(--tt-text-sm);
	color: var(--tt-text-muted);
	margin-bottom: var(--tt-space-1);
}
</style>
