/* ==========================================================================
   Workflow Templates — load ComfyUI API-format workflow JSONs and patch
   node inputs by title.

   Convention: workflows are designed in the ComfyUI editor, exported in
   *API format*, and dropped into server/workflows/. Nodes whose inputs get
   patched at runtime carry an explicit `_meta.title` (set the node title in
   the editor before exporting): "MODEL", "POSITIVE_PROMPT", "SAMPLER", etc.
   Patching by title survives template edits, unlike node IDs (renumbered by
   the editor) or class_type lookups (ambiguous with duplicate node types).

   A template file may also carry an optional top-level "_template" key with
   metadata (description, prompt_prefix/suffix, negative_default, defaults).
   It is stripped before submission — ComfyUI never sees it.
   ========================================================================== */

import { promises as fs } from 'fs';
import * as fss from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { Logger } from './logger.js';

export interface WorkflowNode {
  inputs: Record<string, any>;
  class_type: string;
  _meta?: { title?: string };
}

/** A ComfyUI API-format graph: node-id → node. */
export type WorkflowGraph = Record<string, WorkflowNode>;

export interface TemplateMeta {
  description?: string;
  /** Prepended/appended to the positive prompt when instantiating. */
  prompt_prefix?: string;
  prompt_suffix?: string;
  /** Used for NEGATIVE_PROMPT when the caller doesn't supply one. */
  negative_default?: string;
  /**
   * Per-quality step counts, overriding the client's default 8/20/35 mapping.
   * Distilled models (Lightning, LCM, Turbo) need far fewer steps — running
   * them at 20+ steps wastes time and often degrades output.
   */
  quality_steps?: Partial<Record<'low' | 'medium' | 'high', number>>;
  defaults?: {
    model?: string;
    [key: string]: any;
  };
}

export interface WorkflowTemplate {
  name: string;
  meta: TemplateMeta;
  graph: WorkflowGraph;
  /** title → node id */
  titles: Map<string, string>;
}

/** title → partial inputs to merge into that node's inputs. */
export type WorkflowPatches = Record<string, Record<string, any>>;

const TEMPLATE_META_KEY = '_template';

function isWorkflowNode(value: any): value is WorkflowNode {
  return value && typeof value === 'object' && typeof value.class_type === 'string';
}

/** Resolve the directory this module lives in, in both ESM (tsc dist) and CJS (esbuild bundle) builds. */
function getModuleDir(): string {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (typeof __dirname !== 'undefined') return __dirname; // CJS bundle
  try {
    return path.dirname(fileURLToPath(import.meta.url)); // ESM
  } catch {
    return process.cwd();
  }
}

/** Candidate locations for the workflows directory, first existing wins. */
export function resolveWorkflowsDir(logger?: Logger): string | null {
  const moduleDir = getModuleDir();
  const candidates = [
    process.env.FOUNDRY_AI_WORKFLOWS_DIR,
    path.join(moduleDir, 'workflows'), // running from server/ source or copied into dist
    path.join(moduleDir, '..', 'workflows'), // running from server/dist
    path.join(process.cwd(), 'workflows'),
    path.join(process.cwd(), 'server', 'workflows'),
  ].filter((c): c is string => !!c);

  for (const candidate of candidates) {
    try {
      if (fss.statSync(candidate).isDirectory()) return candidate;
    } catch {
      /* not there, try next */
    }
  }

  logger?.warn('No workflows directory found', { candidates });
  return null;
}

export class WorkflowLibrary {
  private templates = new Map<string, WorkflowTemplate>();
  private logger: Logger;
  private loaded = false;

  constructor(logger: Logger) {
    this.logger = logger.child({ component: 'WorkflowLibrary' });
  }

  /** Load (or reload) all *.json templates from the workflows directory. */
  async load(dir?: string): Promise<void> {
    const workflowsDir = dir ?? resolveWorkflowsDir(this.logger);
    this.templates.clear();
    this.loaded = true;

    if (!workflowsDir) return;

    let files: string[];
    try {
      files = (await fs.readdir(workflowsDir)).filter(f => f.endsWith('.json'));
    } catch (error: any) {
      this.logger.warn('Failed to read workflows directory', {
        dir: workflowsDir,
        error: error.message,
      });
      return;
    }

    for (const file of files) {
      const name = path.basename(file, '.json');
      try {
        const raw = JSON.parse(await fs.readFile(path.join(workflowsDir, file), 'utf-8'));
        const template = this.parseTemplate(name, raw);
        this.templates.set(name, template);
        this.logger.info('Loaded workflow template', {
          name,
          titles: [...template.titles.keys()],
          nodes: Object.keys(template.graph).length,
        });
      } catch (error: any) {
        this.logger.error('Failed to load workflow template — skipping', {
          file,
          error: error.message,
        });
      }
    }
  }

  private parseTemplate(name: string, raw: Record<string, any>): WorkflowTemplate {
    const meta: TemplateMeta = raw[TEMPLATE_META_KEY] ?? {};
    const graph: WorkflowGraph = {};
    const titles = new Map<string, string>();

    for (const [nodeId, node] of Object.entries(raw)) {
      if (nodeId === TEMPLATE_META_KEY) continue;
      if (!isWorkflowNode(node)) {
        throw new Error(`Node "${nodeId}" is not a valid ComfyUI API-format node (missing class_type)`);
      }
      graph[nodeId] = node;

      const title = node._meta?.title;
      if (title) {
        if (titles.has(title)) {
          throw new Error(`Duplicate node title "${title}" (nodes ${titles.get(title)} and ${nodeId}) — titles must be unique`);
        }
        titles.set(title, nodeId);
      }
    }

    if (Object.keys(graph).length === 0) {
      throw new Error('Template contains no nodes');
    }

    return { name, meta, graph, titles };
  }

  async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  has(name: string): boolean {
    return this.templates.has(name);
  }

  get(name: string): WorkflowTemplate | undefined {
    return this.templates.get(name);
  }

  /** Summaries for tool output. */
  list(): Array<{ name: string; description?: string; titles: string[]; class_types: string[] }> {
    return [...this.templates.values()].map(t => ({
      name: t.name,
      description: t.meta.description,
      titles: [...t.titles.keys()],
      class_types: [...new Set(Object.values(t.graph).map(n => n.class_type))],
    }));
  }

  /** All class_types used by a template (for checking against /object_info). */
  classTypes(name: string): string[] {
    const t = this.templates.get(name);
    if (!t) return [];
    return [...new Set(Object.values(t.graph).map(n => n.class_type))];
  }

  /**
   * Deep-clone a template's graph and merge the given patches into the titled
   * nodes' inputs. Throws on unknown template or title so a typo fails loudly
   * at submit time instead of silently generating with defaults.
   */
  instantiate(name: string, patches: WorkflowPatches): WorkflowGraph {
    const template = this.templates.get(name);
    if (!template) {
      throw new Error(
        `Unknown workflow template "${name}". Available: ${[...this.templates.keys()].join(', ') || '(none loaded)'}`
      );
    }

    const graph: WorkflowGraph = structuredClone(template.graph);

    for (const [title, inputPatch] of Object.entries(patches)) {
      const nodeId = template.titles.get(title);
      if (!nodeId) {
        throw new Error(
          `Template "${name}" has no node titled "${title}". Available titles: ${[...template.titles.keys()].join(', ')}`
        );
      }
      const node = graph[nodeId];
      for (const [key, value] of Object.entries(inputPatch)) {
        if (value === undefined) continue;
        if (!(key in node.inputs)) {
          // New keys are allowed (optional node inputs) but worth a breadcrumb —
          // this is where a typo'd input name would otherwise vanish silently.
          this.logger.warn('Patch adds input key not present in template', {
            template: name,
            title,
            key,
          });
        }
        node.inputs[key] = value;
      }
    }

    return graph;
  }
}
