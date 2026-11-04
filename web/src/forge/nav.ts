// Navigation in the forge shell. Components write plain `<a href>` links, and the
// shell root hands same-origin ones to the router. A link the Worker answers
// itself (sign-in) carries `data-reload` and stays a real page load.

import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useSession } from "../app/context.ts";

/** Back to this page after signing in. The Worker answers it, so a real page load. */
export const useSignInHref = () => {
	const session = useSession();
	const route = useRoute();
	return computed(() => session.loginUrl(route.fullPath));
};

export const useForgeNav = () => {
	const router = useRouter();

	const followLink = (event: MouseEvent): void => {
		if (
			event.defaultPrevented || event.button !== 0 || event.metaKey ||
			event.ctrlKey || event.shiftKey || event.altKey
		) return;
		const link = (event.target as Element).closest?.(
			'a[href^="/"]',
		) as HTMLAnchorElement | null;
		if (!link || link.target || link.hasAttribute("data-reload")) return;
		const href = link.getAttribute("href")!;
		if (href.startsWith("//")) return;
		event.preventDefault();
		void router.push(href);
	};

	return {
		followLink,
		go: (url: string) => router.push(url),
		replace: (url: string) => router.replace(url),
	};
};
