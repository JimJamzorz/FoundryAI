/* ==========================================================================
   ComfyUI Workflow Templates (module side)

   Imports the SAME titled API-format workflow JSONs the MCP server uses
   (server/workflows/*.json) via Vite glob, so both sides share one template
   library — no more manually pasted workflow JSON.

   Convention (same as server/workflow-templates.ts): patchable nodes carry a
   `_meta.title` (MODEL, POSITIVE_PROMPT, NEGATIVE_PROMPT, LATENT, SAMPLER,
   NOISE, SCHEDULER, MODEL_SAMPLING, REFERENCE_IMAGE, SAVE), and an optional
   top-level `_template` key holds metadata (description, prompt prefix/suffix,
   default negative, per-quality step counts, default model). The `_template`
   key is stripped before submission.

   The instantiation logic here is a browser port of the server's
   workflow-templates.ts — if you change patch semantics in one, mirror the
   other.
   ========================================================================== */

export interface ComfyWorkflowNode {
	inputs: Record<string, any>
	class_type: string
	_meta?: { title?: string }
}

export type ComfyWorkflowGraph = Record<string, ComfyWorkflowNode>

export interface ComfyTemplateMeta {
	description?: string
	prompt_prefix?: string
	prompt_suffix?: string
	negative_default?: string
	quality_steps?: Partial<Record<'low' | 'medium' | 'high', number>>
	defaults?: { model?: string; [key: string]: any }
}

export interface ComfyWorkflowTemplate {
	name: string
	meta: ComfyTemplateMeta
	graph: ComfyWorkflowGraph
	titles: Map<string, string>
}

export interface BuildComfyPromptOptions {
	prompt: string
	width?: number
	height?: number
	quality?: 'low' | 'medium' | 'high'
	seed?: number
	negativePrompt?: string
	/** ComfyUI-side image name for img2img templates (REFERENCE_IMAGE node). */
	referenceImage?: string
	denoise?: number
}

const TEMPLATE_META_KEY = '_template'

// Eagerly bundle every server workflow template into the module build.
const RAW_TEMPLATES = import.meta.glob('../../server/workflows/*.json', {
	eager: true,
	import: 'default',
}) as Record<string, Record<string, any>>

function parseTemplate(name: string, raw: Record<string, any>): ComfyWorkflowTemplate | null {
	const meta: ComfyTemplateMeta = raw[TEMPLATE_META_KEY] ?? {}
	const graph: ComfyWorkflowGraph = {}
	const titles = new Map<string, string>()

	for (const [nodeId, node] of Object.entries(raw)) {
		if (nodeId === TEMPLATE_META_KEY) continue
		if (!node || typeof node !== 'object' || typeof (node as any).class_type !== 'string') {
			console.warn(`FoundryAI | comfy-workflows: template "${name}" node "${nodeId}" is not valid — skipping template`)
			return null
		}
		graph[nodeId] = node as ComfyWorkflowNode
		const title = (node as ComfyWorkflowNode)._meta?.title
		if (title) {
			if (titles.has(title)) {
				console.warn(`FoundryAI | comfy-workflows: template "${name}" has duplicate title "${title}" — skipping template`)
				return null
			}
			titles.set(title, nodeId)
		}
	}

	if (Object.keys(graph).length === 0) return null
	return { name, meta, graph, titles }
}

const TEMPLATES = new Map<string, ComfyWorkflowTemplate>()
for (const [path, raw] of Object.entries(RAW_TEMPLATES)) {
	const name = path.split('/').pop()!.replace(/\.json$/, '')
	const template = parseTemplate(name, raw)
	if (template) TEMPLATES.set(name, template)
}
console.log(`FoundryAI | comfy-workflows: loaded ${TEMPLATES.size} workflow template(s): ${[...TEMPLATES.keys()].join(', ')}`)

export function listComfyTemplates(): Array<{ name: string; description?: string }> {
	return [...TEMPLATES.values()].map(t => ({ name: t.name, description: t.meta.description }))
}

export function getComfyTemplate(name: string): ComfyWorkflowTemplate | undefined {
	return TEMPLATES.get(name)
}

export function comfyTemplateNames(): string[] {
	return [...TEMPLATES.keys()]
}

/**
 * Instantiate a template into a submittable ComfyUI prompt graph, patching
 * prompt/seed/steps/dimensions into the titled nodes. Mirrors the server's
 * buildWorkflowFromTemplate semantics.
 */
export function buildComfyPrompt(templateName: string, options: BuildComfyPromptOptions): ComfyWorkflowGraph {
	const template = TEMPLATES.get(templateName)
	if (!template) {
		throw new Error(
			`Unknown ComfyUI workflow "${templateName}". Available workflows: ${[...TEMPLATES.keys()].join(', ') || '(none bundled)'}`,
		)
	}

	const meta = template.meta
	const quality = options.quality || 'low'
	const defaultSteps = quality === 'high' ? 35 : quality === 'medium' ? 20 : 8
	const steps = meta.quality_steps?.[quality] ?? defaultSteps
	const seed = options.seed ?? Math.floor(Math.random() * 2 ** 32)
	const positive = `${meta.prompt_prefix ?? ''}${options.prompt}${meta.prompt_suffix ?? ''}`
	const negative = options.negativePrompt ?? meta.negative_default ?? ''

	const graph: ComfyWorkflowGraph = JSON.parse(JSON.stringify(template.graph))
	const patch = (title: string, inputs: Record<string, any>) => {
		const nodeId = template.titles.get(title)
		if (!nodeId) return false
		for (const [key, value] of Object.entries(inputs)) {
			if (value === undefined) continue
			graph[nodeId].inputs[key] = value
		}
		return true
	}

	if (!template.titles.has('POSITIVE_PROMPT')) {
		throw new Error(`Workflow "${templateName}" has no POSITIVE_PROMPT node — the prompt cannot be applied.`)
	}
	patch('POSITIVE_PROMPT', { text: positive })
	patch('NEGATIVE_PROMPT', { text: negative })
	patch('SAMPLER', { seed, steps, denoise: options.denoise })
	patch('NOISE', { noise_seed: seed })
	patch('SCHEDULER', { steps, denoise: options.denoise })
	if (options.width && options.height) {
		patch('LATENT', { width: options.width, height: options.height })
		patch('MODEL_SAMPLING', { width: options.width, height: options.height })
	}
	if (options.referenceImage) {
		if (!patch('REFERENCE_IMAGE', { image: options.referenceImage })) {
			throw new Error(`Workflow "${templateName}" has no REFERENCE_IMAGE node — pick an img2img workflow for reference images.`)
		}
	}

	return graph
}
