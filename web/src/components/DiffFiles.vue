<script setup lang="ts">
// A list of `FileDiff`s (commit, compare, `diff` nodes): one collapsible
// section per file with its counts and patch. A missing patch says why only
// as the kernel did (`patchOmitted`); "too large" is never a guess.
import type { FileDiff, PatchOmitted } from "@tartan/contract/git.ts";
import DiffPatch from "./DiffPatch.vue";

// Files start expanded when there are a few of them (≤ 8), unless `collapsed`.
defineProps<{ files: readonly FileDiff[]; collapsed?: boolean }>();

const CHANGE_LABEL: Record<FileDiff["change"], string> = {
	added: "added",
	modified: "modified",
	deleted: "deleted",
	renamed: "renamed",
	type: "type changed",
};

const OMITTED_TEXT: Record<PatchOmitted, string> = {
	"too-large": "Patch too large to show inline.",
	budget: "Not shown: this diff is too large to show every patch inline.",
	"path-level": "Only the file name is known for this change.",
};

const hasLines = (patch: string): boolean => /^@@ /m.test(patch);
</script>

<template>
	<div class="diff-files">
		<p v-if="files.length === 0" class="tt-muted">No file changes.</p>
		<details
			v-for="file in files"
			:key="file.path"
			class="diff-files__file"
			:open="!collapsed && files.length <= 8"
		>
			<summary class="diff-files__summary">
				<code class="diff-files__path">{{ file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path }}</code>
				<span class="chip chip--muted">{{ CHANGE_LABEL[file.change] }}</span>
				<span class="diff-files__counts">
					<span class="diff-files__add">+{{ file.additions }}</span>
					<span class="diff-files__del">−{{ file.deletions }}</span>
				</span>
			</summary>
			<p v-if="file.binary" class="tt-muted">Binary file not shown.</p>
			<DiffPatch v-else-if="file.patch !== undefined && hasLines(file.patch)" :patch="file.patch" />
			<p v-else-if="file.patch !== undefined" class="tt-muted">No content changes.</p>
			<p v-else-if="file.patchOmitted" class="tt-muted">{{ OMITTED_TEXT[file.patchOmitted] }}</p>
			<p v-else class="tt-muted">No patch available.</p>
		</details>
	</div>
</template>

<style scoped>
.diff-files {
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-2);
}

.diff-files__file {
	border: 1px solid var(--tt-border);
	border-radius: var(--tt-radius);
	background: var(--tt-surface);
	padding: var(--tt-space-2);
}

.diff-files__summary {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--tt-space-2);
	cursor: pointer;
	min-height: 2.75rem;
}

.diff-files__path {
	overflow-wrap: anywhere;
	min-width: 0;
}

.diff-files__counts {
	margin-inline-start: auto;
	display: inline-flex;
	gap: var(--tt-space-2);
	font-family: var(--tt-font-mono);
	font-size: var(--tt-text-sm);
}

.diff-files__add {
	color: var(--tt-tone-success);
}

.diff-files__del {
	color: var(--tt-tone-danger);
}
</style>
