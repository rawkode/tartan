// A value loaded from the API that reloads when its key changes; stale
// responses (an older key) are dropped. While a new key loads, `data` keeps
// the previous value; `loadedKey` says which key that value belongs to.

import { type Ref, shallowRef, watch, type WatchSource } from "vue";
import { errorMessage, isApiError } from "../api/http.ts";

export type Resource<T, K = unknown> = {
	readonly data: Ref<T | null>;
	/** The key `data` was loaded for (undefined while there is none). */
	readonly loadedKey: Ref<K | undefined>;
	readonly error: Ref<string | null>;
	/** HTTP status of the last failure (0 for network errors). */
	readonly status: Ref<number | null>;
	readonly loading: Ref<boolean>;
	readonly reload: () => Promise<void>;
};

export const useResource = <T, K>(
	key: WatchSource<K>,
	load: (key: K) => Promise<T>,
	options: { readonly immediate?: boolean } = {},
): Resource<T, K> => {
	const data = shallowRef<T | null>(null);
	const loadedKey = shallowRef<K | undefined>(undefined);
	const error = shallowRef<string | null>(null);
	const status = shallowRef<number | null>(null);
	const loading = shallowRef(false);
	let generation = 0;
	let current: K | undefined;

	const run = async (k: K): Promise<void> => {
		const mine = ++generation;
		current = k;
		loading.value = true;
		error.value = null;
		status.value = null;
		try {
			const value = await load(k);
			if (mine === generation) {
				data.value = value;
				loadedKey.value = k;
			}
		} catch (e) {
			if (mine === generation) {
				data.value = null;
				loadedKey.value = undefined;
				error.value = errorMessage(e);
				status.value = isApiError(e) ? e.status : null;
			}
		} finally {
			if (mine === generation) loading.value = false;
		}
	};

	watch(key, (k) => void run(k), { immediate: options.immediate ?? true });

	return {
		data,
		loadedKey,
		error,
		status,
		loading,
		reload: () => (current === undefined ? Promise.resolve() : run(current)),
	};
};
