// WebSocket dispatch table. Modules accept
// hibernatable sockets themselves (`ctx.acceptWebSocket(ws, [tag, …])`) and
// register `SocketHandlers` by tag prefix; the thin DO class forwards
// `webSocketMessage/Close/Error` here, and the socket's FIRST tag picks the
// module: a tag matches a prefix when it equals it or starts with
// `<prefix>:` (e.g. `feed` or `feed:<repo>`). Handler failures are caught per
// call; a failing or unroutable message closes that socket with 1011.

import type { SocketHandlers } from "@tartan/contract/kernel.ts";

export type SocketDispatch = {
	readonly prefixes: readonly string[];
	route(ws: WebSocket): SocketHandlers | undefined;
	message(ws: WebSocket, message: string | ArrayBuffer): Promise<void>;
	close(
		ws: WebSocket,
		code: number,
		reason: string,
		wasClean: boolean,
	): Promise<void>;
	error(ws: WebSocket, error: unknown): Promise<void>;
};

export type SocketDispatchDeps = {
	readonly ctx: Pick<DurableObjectState, "getTags">;
	readonly handlers: readonly SocketHandlers[];
	readonly log?: (message: string, data: Record<string, unknown>) => void;
};

const PREFIX_RE = /^[a-z][a-z0-9-]{0,31}$/;

const errorText = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const defaultLog = (message: string, data: Record<string, unknown>): void =>
	console.error(`[tartan] ${message}`, JSON.stringify(data));

const closeQuietly = (ws: WebSocket, code: number, reason: string): void => {
	try {
		ws.close(code, reason);
	} catch {
		// Already closed.
	}
};

export const socketPrefixIssues = (
	handlers: readonly SocketHandlers[],
): string[] => {
	const issues: string[] = [];
	const seen = new Set<string>();
	for (const { tagPrefix } of handlers) {
		if (!PREFIX_RE.test(tagPrefix)) {
			issues.push(`invalid socket tag prefix "${tagPrefix}"`);
		}
		if (seen.has(tagPrefix)) {
			issues.push(`socket tag prefix "${tagPrefix}" registered twice`);
		}
		seen.add(tagPrefix);
	}
	return issues;
};

export const createSocketDispatch = (
	deps: SocketDispatchDeps,
): SocketDispatch => {
	const issues = socketPrefixIssues(deps.handlers);
	if (issues.length > 0) {
		throw new Error(`invalid socket handlers: ${issues.join("; ")}`);
	}
	const log = deps.log ?? defaultLog;
	const byPrefix = new Map(deps.handlers.map((h) => [h.tagPrefix, h]));

	const route = (ws: WebSocket): SocketHandlers | undefined => {
		const [tag] = deps.ctx.getTags(ws);
		if (tag === undefined) return undefined;
		const separator = tag.indexOf(":");
		return byPrefix.get(separator === -1 ? tag : tag.slice(0, separator));
	};

	const message = async (
		ws: WebSocket,
		data: string | ArrayBuffer,
	): Promise<void> => {
		const handler = route(ws);
		if (handler === undefined) {
			closeQuietly(ws, 1011, "no handler");
			return;
		}
		try {
			await handler.message(ws, data);
		} catch (error) {
			log("socket message handler failed", {
				prefix: handler.tagPrefix,
				error: errorText(error),
			});
			closeQuietly(ws, 1011, "internal error");
		}
	};

	const close = async (
		ws: WebSocket,
		code: number,
		reason: string,
		wasClean: boolean,
	): Promise<void> => {
		const handler = route(ws);
		if (handler === undefined) return;
		try {
			await handler.close(ws, code, reason, wasClean);
		} catch (error) {
			log("socket close handler failed", {
				prefix: handler.tagPrefix,
				error: errorText(error),
			});
		}
	};

	const error = async (ws: WebSocket, cause: unknown): Promise<void> => {
		const handler = route(ws);
		if (handler === undefined) return;
		try {
			await handler.error(ws, cause);
		} catch (failure) {
			log("socket error handler failed", {
				prefix: handler.tagPrefix,
				error: errorText(failure),
			});
		}
	};

	return {
		prefixes: [...byPrefix.keys()],
		route,
		message,
		close,
		error,
	};
};
