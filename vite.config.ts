import { defineConfig, type Plugin } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import path from 'path'
import fs from 'fs'

/** Copies module.json and languages/ into dist/ after build */
function foundryModulePlugin(): Plugin {
	function copyDir(src: string, dst: string) {
		if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true })
		for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
			const srcPath = path.resolve(src, entry.name)
			const dstPath = path.resolve(dst, entry.name)
			if (entry.isDirectory()) copyDir(srcPath, dstPath)
			else fs.copyFileSync(srcPath, dstPath)
		}
	}

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

			// Copy PDF.js auxiliary assets. JPX/JPEG2000 image decoding needs
			// openjpeg.wasm; without this, rendered pages can silently miss artwork.
			const pdfjsAssetRoot = path.resolve(distDir, 'pdfjs')
			copyDir(path.resolve(__dirname, 'node_modules/pdfjs-dist/wasm'), path.resolve(pdfjsAssetRoot, 'wasm'))
			copyDir(path.resolve(__dirname, 'node_modules/pdfjs-dist/cmaps'), path.resolve(pdfjsAssetRoot, 'cmaps'))
			copyDir(path.resolve(__dirname, 'node_modules/pdfjs-dist/standard_fonts'), path.resolve(pdfjsAssetRoot, 'standard_fonts'))

			console.log('✔ Copied module.json, languages/, and PDF.js worker/assets into dist/')
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
