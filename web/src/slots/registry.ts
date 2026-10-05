// Slot hosts on one page register here so an action result's `refresh:
// [slotIds]` can re-render sibling slots by contribution id.

import { inject, type InjectionKey, provide } from "vue";

export type SlotRegistry = {
	readonly register: (id: string, refresh: () => void) => () => void;
	readonly refresh: (ids: readonly string[]) => void;
};

export const SLOT_REGISTRY: InjectionKey<SlotRegistry> = Symbol(
	"slot-registry",
);

export const createSlotRegistry = (): SlotRegistry => {
	const entries = new Map<string, Set<() => void>>();
	return {
		register: (id, refresh) => {
			const set = entries.get(id) ?? new Set();
			set.add(refresh);
			entries.set(id, set);
			return () => {
				set.delete(refresh);
				if (set.size === 0) entries.delete(id);
			};
		},
		refresh: (ids) => {
			for (const id of new Set(ids)) {
				for (const fn of entries.get(id) ?? []) fn();
			}
		},
	};
};

/** Provides a fresh registry for a page (call in the page's setup). */
export const provideSlotRegistry = (): SlotRegistry => {
	const registry = createSlotRegistry();
	provide(SLOT_REGISTRY, registry);
	return registry;
};

export const useSlotRegistry = (): SlotRegistry | null =>
	inject(SLOT_REGISTRY, null);
