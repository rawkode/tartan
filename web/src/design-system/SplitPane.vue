<script setup lang="ts">
import { Splitter, useSplitter } from "@ark-ui/vue/splitter";
import { onBeforeUnmount, onMounted, ref } from "vue";
import { split } from "../../styled-system/recipes";

const props = defineProps<{
	// Names the side panel to assistive technology.
	label: string;
	// Remembers the viewer's width under this localStorage key.
	storageKey: string;
	defaultWidth: number;
	minWidth: number;
	maxWidth: number;
}>();

const mainMinWidth = 320;
const root = ref<{ $el: HTMLElement }>();
const element = () => root.value?.$el;

// The width the viewer asked for. A small window can squeeze the panel below it.
let wanted = props.defaultWidth;

const splitter = useSplitter({
	panels: [
		{
			id: "side",
			minSize: `${props.minWidth}px`,
			maxSize: `${props.maxWidth}px`,
			resizeBehavior: "preserve-pixel-size",
		},
		{ id: "main", minSize: `${mainMinWidth}px` },
	],
	defaultSize: [`${props.defaultWidth}px`, undefined] as unknown as number[],
	keyboardResizeBy: 1,
	onResizeEnd: ({ size }) => {
		wanted = Math.round((size[0] / 100) * (element()?.offsetWidth ?? 0));
		try {
			localStorage.setItem(props.storageKey, String(wanted));
		} catch {}
	},
});

// Give the panel its width back whenever there is room for it.
const restore = () => {
	const total = element()?.offsetWidth ?? 0;
	if (total < wanted + mainMinWidth) return;
	const percent = (wanted / total) * 100;
	if (Math.abs(splitter.value.getSizes()[0] - percent) > 0.1) {
		splitter.value.setSizes([percent, 100 - percent]);
	}
};

let observer: ResizeObserver | undefined;

onMounted(() => {
	try {
		const saved = Number(localStorage.getItem(props.storageKey));
		if (saved >= props.minWidth && saved <= props.maxWidth) wanted = saved;
	} catch {}
	observer = new ResizeObserver(restore);
	observer.observe(element()!);
});

onBeforeUnmount(() => observer?.disconnect());

const styles = split();
</script>

<template>
	<Splitter.RootProvider ref="root" :value="splitter" :class="styles.root">
		<Splitter.Panel id="side"
			:class="styles.side"><slot name="side" /></Splitter.Panel>
		<Splitter.ResizeTrigger id="side:main" :aria-label="`Resize ${label}`"
			:class="styles.trigger" />
		<Splitter.Panel id="main" :class="styles.main"><slot /></Splitter.Panel>
	</Splitter.RootProvider>
</template>
