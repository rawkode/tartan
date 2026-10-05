/// <reference types="vite/client" />

interface ImportMetaEnv {
	/** "1" builds the SPA against the in-browser mock API (`src/api/mock`). */
	readonly VITE_TARTAN_MOCK?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
