<script setup lang="ts">
import { Combobox, createListCollection } from "@ark-ui/vue/combobox";
import { computed, ref } from "vue";
import { jump } from "../../styled-system/recipes";
import { css } from "../../styled-system/css";
import { splitAddr, urlFor, useForge } from "./data/index.ts";
import { useForgeNav } from "./nav.ts";

const nav = useForgeNav();
const store = useForge();
const query = ref("");

// Each part of the query must start a segment of the address, in order, so o/d/k:l finds oss/devtools/build/kiln:lsp.
const results = computed(() => {
	const parts = query.value.trim().toLowerCase().replace(/^~\/?/, "").split(
		/[/:]/,
	).filter(Boolean);
	if (!parts.length) return [];
	return store.everything()
		.slice(1)
		.map(({ addr }) => ({
			addr,
			segments: splitAddr(addr).map((s) => s.toLowerCase()),
		}))
		.filter(({ segments }) => {
			let hit = 0;
			for (const segment of segments) {
				if (hit < parts.length && segment.startsWith(parts[hit])) hit += 1;
			}
			return hit === parts.length;
		})
		.sort((a, b) => a.segments.length - b.segments.length)
		.slice(0, 7)
		.map(({ addr }) => ({ label: `~/${addr}`, value: addr }));
});

const collection = computed(() =>
	createListCollection({ items: results.value })
);
const nothing = computed(() =>
	query.value.trim().length > 0 && results.value.length === 0
);

// It can only match what is loaded, so the first keystroke loads the rest.
const search = (value: string) => {
	query.value = value;
	if (value) void store.loadEverything();
};

const onSelect = (addr: string) => {
	query.value = "";
	void nav.go(urlFor(addr));
};

const styles = jump();
const control = css({ flex: "[1 1 auto]", minWidth: "0" });
</script>

<template>
	<Combobox.Root
		:collection="collection"
		:input-value="query"
		input-behavior="autohighlight"
		selection-behavior="clear"
		:open-on-click="false"
		:positioning="{ sameWidth: true, gutter: 8 }"
		:class="styles.root"
		@input-value-change="search($event.inputValue)"
		@select="$event.itemValue && onSelect($event.itemValue)"
	>
		<Combobox.Label :class="styles.label">Jump</Combobox.Label>
		<Combobox.Control :class="control">
			<Combobox.Input placeholder="o/d/k:l" :class="styles.input" />
		</Combobox.Control>
		<Combobox.Positioner>
			<Combobox.Content :class="styles.content">
				<Combobox.Item v-for="item in results" :key="item.value" :item="item"
					:class="styles.item">
					<Combobox.ItemText>{{ item.label }}</Combobox.ItemText>
				</Combobox.Item>
			</Combobox.Content>
		</Combobox.Positioner>
		<p v-if="nothing" role="status"
			:class="styles.empty">Nothing at that address.</p>
	</Combobox.Root>
</template>
