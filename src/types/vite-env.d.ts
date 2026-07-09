/**
 * Minimal typing for the Vite-only import.meta APIs this project uses.
 * (The tsconfig's custom typeRoots keeps us from pulling in vite/client
 * wholesale, so we declare just what we need.)
 */
interface ImportMeta {
	/** Vite glob import — https://vitejs.dev/guide/features#glob-import */
	glob(
		pattern: string,
		options?: { eager?: boolean; import?: string; query?: string },
	): Record<string, any>
	url: string
}
