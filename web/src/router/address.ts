// Forge addresses: `/` joins groups and repos, `:` joins a project to its repo
// (`oss/devtools/build/kiln:lsp`), and `/-/` separates a page from the address.
//
// The kernel only knows node paths, and `:` is not in its slug grammar, so the
// project has to come off before an address reaches any API call.

export type Address = {
	/** The group or repo path, with no project. Empty for the forge root. */
	readonly path: string;
	/** The project within the repo at `path`, if the address names one. */
	readonly project: string | null;
};

/** Splits an address, or returns null when it is malformed. */
export const parseAddress = (address: string): Address | null => {
	if (address === "") return { path: "", project: null };
	const colon = address.indexOf(":");
	const path = colon === -1 ? address : address.slice(0, colon);
	const project = colon === -1 ? null : address.slice(colon + 1);
	if (path.split("/").some((segment) => segment === "")) return null;
	if (project !== null && !/^[^/:]+$/.test(project)) return null;
	return { path, project };
};

export const formatAddress = ({ path, project }: Address): string =>
	project === null ? path : `${path}:${project}`;
