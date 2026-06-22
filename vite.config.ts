import { defineConfig, type Plugin } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import path from 'path'
import fs from 'fs'

/** Copies module.json and languages/ into dist/ after build */
function foundryModulePlugin(): Plugin {
	return {
		name: 'foundry-module-copy',
		closeBundle() {
			const distDir = path.resolve(__dirname, 'dist')

			// Copy module.json
			fs.copyFileSync(path.resolve(__dirname, 'module.json'), path.resolve(distDir, 'module.json'))

			// Copy languages/
			const langSrc = path.resolve(__dirname, 'languages')
			const langDst = path.resolve(distDir, 'languages')
			if (!fs.existsSync(langDst)) fs.mkdirSync(langDst, { recursive: true })
			for (const file of fs.readdirSync(langSrc)) {
				fs.copyFileSync(path.resolve(langSrc, file), path.resolve(langDst, file))
			}

			// Copy PDF.js worker so it can be loaded at runtime
			fs.copyFileSync(
				path.resolve(__dirname, 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs'),
				path.resolve(distDir, 'pdf.worker.min.mjs'),
			)

			console.log('✔ Copied module.json, languages/, and pdf.worker.min.mjs into dist/')
		},
	}
}

export default defineConfig({
	plugins: [
		svelte({
			compilerOptions: {
				// Svelte 5 runes mode
				runes: true,
			},
		}),
		foundryModulePlugin(),
	],
	build: {
		outDir: 'dist',
		emptyOutDir: true,
		sourcemap: true,
		lib: {
			entry: path.resolve(__dirname, 'src/module.ts'),
			formats: ['es'],
			fileName: () => 'module.js',
		},
		rollupOptions: {
			// Don't bundle Foundry globals
			external: [],
			output: {
				// Ensure CSS gets output as styles.css
				assetFileNames: (assetInfo) => {
					if (assetInfo.name?.endsWith('.css')) return 'styles.css'
					return assetInfo.name || 'assets/[name].[ext]'
				},
			},
		},
	},
	resolve: {
		alias: {
			'@core': path.resolve(__dirname, 'src/core'),
			'@ui': path.resolve(__dirname, 'src/ui'),
			'@': path.resolve(__dirname, 'src'),
		},
	},
	css: {
		preprocessorOptions: {
			scss: {
				// SCSS options
			},
		},
	},
})
