// A list loaded page by page from a cursor API: reloads from the first page
// when its key changes (a `null` key waits), appends on `more()`, and drops
// responses for an older key.

import { type Ref, shallowRef, watch, type WatchSource } from "vue";
import { errorMessage, isApiError } from "../api/http.ts";

export type Page<T> = {
	readonly items: readonly T[];
	readonly cursor?: string;
};

export type Paged<T> = {
	readonly items: Ref<readonly T[]>;
	readonly cursor: Ref<string | undefined>;
	readonly loading: Ref<boolean>;
	/** True once the first page for the current key arrived (or failed). */
	readonly loaded: Ref<boolean>;
	readonly error: Ref<string | null>;
	/** HTTP status of the last failure (401 asks the viewer to sign in). */
	readonly status: Ref<number | null>;
	readonly more: () => Promise<void>;
	readonly reload: () => Promise<void>;
};

export const usePaged = <T, K>(
	key: WatchSource<K | null>,
	load: (key: K, cursor: string | undefined) => Promise<Page<T>>,
): Paged<T> => {
	const items = shallowRef<readonly T[]>([]);
	const cursor = shallowRef<string | undefined>(undefined);
	const loading = shallowRef(false);
	const loaded = shallowRef(false);
	const error = shallowRef<string | null>(null);
	const status = shallowRef<number | null>(null);
	let generation = 0;
	let current: K | null = null;

	const run = async (reset: boolean): Promise<void> => {
		const k = current;
		if (k === null) return;
		const mine = reset ? ++generation : generation;
		loading.value = true;
		error.value = null;
		status.value = null;
		try {
			const page = await load(k, reset ? undefined : cursor.value);
			if (mine !== generation) return;
			items.value = reset ? page.items : [...items.value, ...page.items];
			cursor.value = page.cursor;
		} catch (e) {
			if (mine !== generation) return;
			if (reset) items.value = [];
			error.value = errorMessage(e);
			status.value = isApiError(e) ? e.status : null;
		} finally {
			if (mine === generation) {
				loading.value = false;
				loaded.value = true;
			}
		}
	};

	watch(key, (k) => {
		current = k;
		generation += 1;
		items.value = [];
		cursor.value = undefined;
		loaded.value = false;
		error.value = null;
		status.value = null;
		loading.value = false;
		if (k !== null) void run(true);
	}, { immediate: true });

	return {
		items,
		cursor,
		loading,
		loaded,
		error,
		status,
		more: () => (cursor.value === undefined ? Promise.resolve() : run(false)),
		reload: () => run(true),
	};
};
