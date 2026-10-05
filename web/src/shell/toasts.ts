// Toast notifications (action results `toast`, copy confirmations, errors).
// The shell renders them in an `aria-live` region; text is always text.

import { inject, type InjectionKey, reactive } from "vue";
import type { Tone } from "../ui/nodeTypes.ts";

export type Toast = {
	readonly id: number;
	readonly tone: Tone;
	readonly text: string;
};

export type Toasts = {
	readonly items: readonly Toast[];
	readonly push: (
		toast: { tone: Tone; text: string },
		ttlMs?: number,
	) => number;
	readonly dismiss: (id: number) => void;
};

export const TOASTS: InjectionKey<Toasts> = Symbol("toasts");

const MAX_TOASTS = 4;
const MAX_TEXT = 500;

export const createToasts = (
	schedule: (fn: () => void, ms: number) => unknown = (fn, ms) =>
		globalThis.setTimeout(fn, ms),
): Toasts => {
	const items = reactive<Toast[]>([]);
	let next = 1;
	const dismiss = (id: number): void => {
		const index = items.findIndex((t) => t.id === id);
		if (index !== -1) items.splice(index, 1);
	};
	return {
		items,
		dismiss,
		push: (toast, ttlMs = 6000) => {
			const id = next++;
			items.push({ id, tone: toast.tone, text: toast.text.slice(0, MAX_TEXT) });
			while (items.length > MAX_TOASTS) items.shift();
			if (ttlMs > 0) schedule(() => dismiss(id), ttlMs);
			return id;
		},
	};
};

let fallback: Toasts | null = null;

/** The app's toasts, or a detached instance (tests, isolated components). */
export const useToasts = (): Toasts =>
	inject(TOASTS, null) ?? (fallback ??= createToasts());
