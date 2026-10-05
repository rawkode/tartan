// App-wide services, provided once in `main.ts` (or by a test) and injected by
// views: the API client, the live store and the auth session.

import { inject, type InjectionKey } from "vue";
import type { Api } from "../api/client.ts";
import type { LiveStore } from "../live/store.ts";
import type { Session } from "../auth/session.ts";

export const API: InjectionKey<Api> = Symbol("api");
export const LIVE: InjectionKey<LiveStore> = Symbol("live");
export const SESSION: InjectionKey<Session> = Symbol("session");

const required = <T>(key: InjectionKey<T>, name: string): T => {
	const value = inject(key, null);
	if (value === null) throw new Error(`${name} is not provided`);
	return value;
};

export const useApi = (): Api => required(API, "api");
export const useLive = (): LiveStore => required(LIVE, "live store");
export const useSession = (): Session => required(SESSION, "session");
