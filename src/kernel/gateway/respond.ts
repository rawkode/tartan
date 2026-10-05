// Responses of the git routes (WP4): plain text for git
// clients (git prints the status line, not the body), the 401 challenge,
// `ERR` packets for refused upload-pack requests, and the content types of
// smart HTTP.

import { encodePktLine } from "@tartan/gitproto";

/** The realm of the git routes' challenge (as WP2's middleware sends it). */
export const GIT_CHALLENGE = 'Basic realm="Tartan", charset="UTF-8"';

export const CONTENT_TYPE = {
	uploadAdvertisement: "application/x-git-upload-pack-advertisement",
	receiveAdvertisement: "application/x-git-receive-pack-advertisement",
	uploadResult: "application/x-git-upload-pack-result",
	receiveResult: "application/x-git-receive-pack-result",
} as const;

/** Smart-HTTP responses are never cached. */
export const NO_CACHE = "no-cache, max-age=0, must-revalidate";

export const gitText = (status: number, message: string): Response =>
	new Response(`${message}\n`, {
		status,
		headers: {
			"content-type": "text/plain; charset=utf-8",
			"cache-control": "no-store",
		},
	});

/** 401 with the Basic challenge, so git asks for credentials and never sends a pack without them. */
export const unauthorized = (): Response =>
	new Response("authentication required\n", {
		status: 401,
		headers: {
			"content-type": "text/plain; charset=utf-8",
			"cache-control": "no-store",
			"www-authenticate": GIT_CHALLENGE,
		},
	});

/** A smart-HTTP body with its content type. */
export const gitBody = (
	body: BodyInit | null,
	contentType: string,
	status = 200,
): Response =>
	new Response(body, {
		status,
		headers: { "content-type": contentType, "cache-control": NO_CACHE },
	});

/**
 * A refused upload-pack request: one `ERR <reason>` packet, which
 * stock git prints as `remote error: <reason>`; nothing was forwarded.
 */
export const uploadError = (reason: string, detail?: string): Response =>
	gitBody(
		encodePktLine(`ERR ${detail ? `${reason}: ${detail}` : reason}\n`),
		CONTENT_TYPE.uploadResult,
	);
