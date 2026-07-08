import { spawn, ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import * as fss from 'fs';
import * as path from 'path';
import * as os from 'os';
import axios from 'axios';
import WebSocket from 'ws';
import { Logger } from './logger.js';
import { getHiddenProcessSpawnOptions, getAppDataDir } from './utils/platform.js';
import {
  detectComfyUIInstallation,
  isValidComfyUIPath,
  getDefaultPythonCommand as getComfyUIPythonCommand,
} from './utils/comfyui-paths.js';
import { WorkflowLibrary, WorkflowGraph, WorkflowPatches } from './workflow-templates.js';

export interface ComfyUIWorkflowInput {
  prompt: string;
  width: number;
  height: number;
  seed?: number;
  quality?: 'low' | 'medium' | 'high';
  /** Checkpoint filename from listCheckpoints(). Falls back to the template's default. */
  model?: string;
  /** Workflow template name (server/workflows/*.json). Default: txt2img-map, or img2img-restyle when referenceImage is set. */
  template?: string;
  /** ComfyUI-side image name (from uploadImage) for img2img / styled workflows. */
  referenceImage?: string;
  /** img2img denoise 0–1: how far to depart from the reference image. */
  denoise?: number;
  /** Override the template's default negative prompt. */
  negativePrompt?: string;
}

export interface ComfyUIJobResponse {
  prompt_id: string;
  number: number;
  node_errors?: any;
}

export interface ComfyUIConfig {
  installPath?: string | undefined;
  host: string;
  port: number;
  pythonCommand: string;
  autoStart: boolean;
}

export interface ComfyUIHealthInfo {
  available: boolean;
  responseTime?: number;
  systemInfo?: any;
  gpuInfo?: string | undefined;
}

const SIZE_MAPPING = {
  small: 1024,
  medium: 1536,
  large: 2048,
} as const;

export class ComfyUIClient {
  private config: ComfyUIConfig;
  private logger: Logger;
  private process?: ChildProcess | undefined;
  private baseUrl: string;
  private clientId: string;
  private logStream?: fss.WriteStream | undefined;
  private ws?: WebSocket;
  private progressCallbacks: Map<
    string,
    (progress: { currentStep: number; totalSteps: number }) => void
  > = new Map();
  private workflows: WorkflowLibrary;
  private objectInfoCache?: { data: any; fetchedAt: number };
  private static readonly OBJECT_INFO_TTL_MS = 5 * 60 * 1000;

  constructor(options: { logger: Logger; config?: Partial<ComfyUIConfig> }) {
    this.logger = options.logger.child({ component: 'ComfyUIClient' });
    this.clientId = `ai-maps-server-${Date.now()}`;
    this.workflows = new WorkflowLibrary(this.logger);

    // ComfyUI always runs locally on the same machine as the MCP server
    // Try to detect existing installation, fall back to default path
    const detectedPath = detectComfyUIInstallation();
    const installPath = detectedPath || this.getDefaultInstallPath();
    const defaultPython = getComfyUIPythonCommand(installPath);

    this.config = {
      installPath,
      host: '127.0.0.1',
      port: 31411,
      pythonCommand: defaultPython,
      autoStart: true,
      ...options.config,
    };

    this.baseUrl = `http://${this.config.host}:${this.config.port}`;

    this.logger.info('ComfyUI client initialized', {
      baseUrl: this.baseUrl,
      installPath: this.config.installPath,
      detected: !!detectedPath,
      clientId: this.clientId,
    });

    // Initialize WebSocket connection for real-time progress
    this.connectWebSocket();
  }

  private connectWebSocket(): void {
    const wsUrl = `ws://${this.config.host}:${this.config.port}/ws?clientId=${this.clientId}`;

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        this.logger.info('ComfyUI WebSocket connected', { clientId: this.clientId });
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleWebSocketMessage(message);
        } catch (error) {
          this.logger.error('Failed to parse WebSocket message', { error });
        }
      });

      this.ws.on('error', error => {
        this.logger.warn('ComfyUI WebSocket error', { error: error.message });
      });

      this.ws.on('close', () => {
        this.logger.info('ComfyUI WebSocket closed, reconnecting in 5s...');
        setTimeout(() => this.connectWebSocket(), 5000);
      });
    } catch (error) {
      this.logger.error('Failed to connect WebSocket', { error });
    }
  }

  private handleWebSocketMessage(message: any): void {
    // Handle progress messages: {"type": "progress", "data": {"value": 3, "max": 8}}
    if (message.type === 'progress' && message.data) {
      const { value, max } = message.data;
      this.logger.info('ComfyUI progress update', { currentStep: value, totalSteps: max });

      // Notify all registered progress callbacks
      this.progressCallbacks.forEach(callback => {
        callback({ currentStep: value, totalSteps: max });
      });
    }

    // Handle executing messages: {"type": "executing", "data": {"node": "5", "prompt_id": "..."}}
    if (message.type === 'executing' && message.data) {
      this.logger.debug('ComfyUI executing node', {
        node: message.data.node,
        promptId: message.data.prompt_id,
      });
    }
  }

  registerProgressCallback(
    promptId: string,
    callback: (progress: { currentStep: number; totalSteps: number }) => void
  ): void {
    this.progressCallbacks.set(promptId, callback);
  }

  unregisterProgressCallback(promptId: string): void {
    this.progressCallbacks.delete(promptId);
  }

  private getDefaultInstallPath(): string {
    // Use cross-platform app data directory
    return path.join(getAppDataDir(), 'foundry-mcp-server', 'ComfyUI-headless');
  }

  async checkInstallation(): Promise<boolean> {
    if (!this.config.installPath) {
      return false;
    }

    const valid = isValidComfyUIPath(this.config.installPath);

    if (valid) {
      this.logger.debug('ComfyUI installation found', { path: this.config.installPath });
    } else {
      this.logger.warn('ComfyUI installation not found', {
        expectedPath: this.config.installPath,
      });
    }

    return valid;
  }

  async checkHealth(): Promise<ComfyUIHealthInfo> {
    const startTime = Date.now();

    try {
      const response = await axios.get(`${this.baseUrl}/system_stats`, {
        timeout: 5000,
      });

      const responseTime = Date.now() - startTime;
      const gpuInfo = this.extractGPUInfo(response.data);

      return {
        available: true,
        responseTime,
        systemInfo: response.data,
        gpuInfo,
      };
    } catch (error) {
      this.logger.debug('ComfyUI health check failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      return {
        available: false,
      };
    }
  }

  private extractGPUInfo(systemStats: any): string | undefined {
    // Try to extract GPU information from system stats
    const gpuFields = ['device_name', 'gpu_name', 'device', 'gpu_device', 'torch_device_name'];

    for (const field of gpuFields) {
      if (systemStats[field]) {
        return systemStats[field];
      }
    }

    // Try nested objects
    if (systemStats.system && typeof systemStats.system === 'object') {
      for (const field of gpuFields) {
        if (systemStats.system[field]) {
          return systemStats.system[field];
        }
      }
    }

    return undefined;
  }

  async startService(): Promise<void> {
    // Externally-managed instance: never spawn our own — connecting is the
    // user's responsibility, so fail with instructions instead of a mystery
    // second ComfyUI on the wrong port.
    if (!this.config.autoStart) {
      throw new Error(
        `ComfyUI is not reachable at ${this.baseUrl} and auto-start is disabled (COMFYUI_AUTO_START=false). Start your ComfyUI instance and try again.`
      );
    }

    // Skip process spawning if no install path (remote mode)
    if (!this.config.installPath) {
      this.logger.info('ComfyUI in remote mode - skipping service start');
      throw new Error(
        'Cannot start ComfyUI service in remote mode. Ensure remote ComfyUI instance is running.'
      );
    }

    if (this.process && !this.process.killed) {
      this.logger.warn('ComfyUI service already running');
      return;
    }

    const isInstalled = await this.checkInstallation();
    if (!isInstalled) {
      throw new Error('ComfyUI is not installed');
    }

    this.logger.info('Starting ComfyUI service', {
      installPath: this.config.installPath,
      pythonCommand: this.config.pythonCommand,
      port: this.config.port,
    });

    const mainPyPath = path.join(this.config.installPath!, 'main.py');

    // Create log file for ComfyUI output (keeps process hidden on all platforms)
    const logPath = path.join(getAppDataDir(), 'comfyui.log');
    this.logStream = fss.createWriteStream(logPath, { flags: 'a' });

    const spawnOptions = getHiddenProcessSpawnOptions();

    this.process = spawn(
      this.config.pythonCommand,
      [
        mainPyPath,
        '--port',
        this.config.port.toString(),
        '--listen',
        this.config.host,
        '--disable-auto-launch',
        '--dont-print-server',
      ],
      {
        cwd: this.config.installPath,
        ...spawnOptions,
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
        },
      }
    );

    // Unref on Mac/Linux so process doesn't keep Node.js alive
    if (spawnOptions.detached) {
      this.process.unref();
    }

    // Handle process events
    this.process.on('error', error => {
      this.logger.error('ComfyUI process error', { error: error.message });
    });

    this.process.on('exit', (code, signal) => {
      this.logger.info('ComfyUI process exited', { code, signal });
      this.process = undefined as ChildProcess | undefined;
      if (this.logStream) {
        this.logStream.end();
        this.logStream = undefined;
      }
    });

    // Log output to file (only if stdio is pipe, not ignore)
    if (this.process.stderr && typeof this.process.stderr !== 'string') {
      this.process.stderr.on('data', data => {
        if (this.logStream) {
          this.logStream.write(`[STDERR] ${data}`);
        }
      });
    }

    if (this.process.stdout && typeof this.process.stdout !== 'string') {
      this.process.stdout.on('data', data => {
        if (this.logStream) {
          this.logStream.write(`[STDOUT] ${data}`);
        }
      });
    }

    // Wait for service to become available
    await this.waitForServiceReady();
    this.logger.info('ComfyUI service started successfully');
  }

  async stopService(): Promise<void> {
    // Skip process management if no install path (remote mode)
    if (!this.config.installPath) {
      this.logger.info('ComfyUI in remote mode - skipping service stop');
      return;
    }

    if (!this.process || this.process.killed) {
      this.logger.warn('ComfyUI service is not running');
      return;
    }

    this.logger.info('Stopping ComfyUI service');

    this.process.kill('SIGTERM');

    // Close log stream
    if (this.logStream) {
      this.logStream.end();
      this.logStream = undefined;
    }

    // Force kill after timeout
    setTimeout(() => {
      if (this.process && !this.process.killed) {
        this.logger.warn('Force killing ComfyUI process');
        this.process.kill('SIGKILL');
      }
    }, 5000);

    this.process = undefined as ChildProcess | undefined;
    this.logger.info('ComfyUI service stopped');
  }

  private async waitForServiceReady(): Promise<void> {
    const maxWaitTime = 60000; // 60 seconds
    const checkInterval = 2000; // 2 seconds
    const startTime = Date.now();

    this.logger.info('Waiting for ComfyUI service to become ready...');

    while (Date.now() - startTime < maxWaitTime) {
      const health = await this.checkHealth();

      if (health.available) {
        this.logger.info('ComfyUI service is ready', {
          responseTime: health.responseTime,
        });
        return;
      }

      // Check if process is still running
      if (!this.process || this.process.killed) {
        throw new Error('ComfyUI process exited before becoming ready');
      }

      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    throw new Error('ComfyUI service failed to become ready within timeout');
  }

  // ---- Resource discovery (/object_info) ----

  /** Fetch (and cache) ComfyUI's node/model registry. */
  async getObjectInfo(forceRefresh = false): Promise<any> {
    const now = Date.now();
    if (
      !forceRefresh &&
      this.objectInfoCache &&
      now - this.objectInfoCache.fetchedAt < ComfyUIClient.OBJECT_INFO_TTL_MS
    ) {
      return this.objectInfoCache.data;
    }

    const response = await axios.get(`${this.baseUrl}/object_info`, { timeout: 15000 });
    this.objectInfoCache = { data: response.data, fetchedAt: now };
    return response.data;
  }

  /** Enum options for one input of one node class, e.g. checkpoints for CheckpointLoaderSimple.ckpt_name. */
  private async getNodeInputOptions(classType: string, inputName: string): Promise<string[]> {
    try {
      const info = await this.getObjectInfo();
      const options = info?.[classType]?.input?.required?.[inputName]?.[0];
      return Array.isArray(options) ? options : [];
    } catch (error: any) {
      this.logger.warn('Failed to read node input options from object_info', {
        classType,
        inputName,
        error: error.message,
      });
      return [];
    }
  }

  async listCheckpoints(): Promise<string[]> {
    return this.getNodeInputOptions('CheckpointLoaderSimple', 'ckpt_name');
  }

  async listLoras(): Promise<string[]> {
    return this.getNodeInputOptions('LoraLoader', 'lora_name');
  }

  /** Diffusion models loaded via UNETLoader (Flux and friends) — separate namespace from checkpoints. */
  async listUnets(): Promise<string[]> {
    return this.getNodeInputOptions('UNETLoader', 'unet_name');
  }

  async listSamplers(): Promise<string[]> {
    return this.getNodeInputOptions('KSampler', 'sampler_name');
  }

  /** Class types used by a workflow that this ComfyUI install doesn't have (missing custom nodes). */
  async validateWorkflowNodes(graph: WorkflowGraph): Promise<string[]> {
    const info = await this.getObjectInfo();
    const missing = new Set<string>();
    for (const node of Object.values(graph)) {
      if (!info?.[node.class_type]) missing.add(node.class_type);
    }
    return [...missing];
  }

  /** Templates available for submitJob's `template` input. */
  async listWorkflowTemplates(): Promise<
    Array<{ name: string; description?: string; titles: string[]; class_types: string[] }>
  > {
    await this.workflows.ensureLoaded();
    return this.workflows.list();
  }

  // ---- Image upload (for img2img / reference-image workflows) ----

  /**
   * Upload an image into ComfyUI's input folder. Returns the stored name to
   * use as a LoadImage node's `image` input (via the REFERENCE_IMAGE patch).
   */
  async uploadImage(imageData: Buffer, filename: string): Promise<string> {
    const FormDataCtor = (globalThis as any).FormData;
    const BlobCtor = (globalThis as any).Blob;
    if (!FormDataCtor || !BlobCtor) {
      throw new Error('Native FormData/Blob unavailable — Node 18+ required for image upload');
    }

    const form = new FormDataCtor();
    form.append('image', new BlobCtor([imageData], { type: 'image/png' }), filename);
    form.append('overwrite', 'true');

    const response = await axios.post(`${this.baseUrl}/upload/image`, form, { timeout: 30000 });
    const storedName = response.data?.name || filename;
    this.logger.info('Uploaded image to ComfyUI', { filename, storedName });
    return storedName;
  }

  // ---- Job submission ----

  async submitJob(input: ComfyUIWorkflowInput): Promise<ComfyUIJobResponse> {
    let workflow: Record<string, any>;
    try {
      workflow = await this.buildWorkflowFromTemplate(input);
    } catch (templateError: any) {
      // Explicit template/model requests must fail loudly — silently generating
      // with the default workflow would look like success with wrong output.
      if (input.template || input.model || input.referenceImage) throw templateError;
      this.logger.warn('Template workflow unavailable — using built-in fallback', {
        error: templateError.message,
      });
      workflow = this.buildWorkflow(input);
    }

    return this.submitWorkflowGraph(workflow);
  }

  /**
   * Build a graph from a workflow template, patching prompt/model/size/steps
   * by node title. Throws if the template (or a required title) is missing.
   */
  private async buildWorkflowFromTemplate(input: ComfyUIWorkflowInput): Promise<WorkflowGraph> {
    await this.workflows.ensureLoaded();

    const templateName = input.template ?? (input.referenceImage ? 'img2img-restyle' : 'txt2img-map');
    const template = this.workflows.get(templateName);
    if (!template) {
      throw new Error(
        `Workflow template "${templateName}" not found. Available: ${this.workflows
          .list()
          .map(t => t.name)
          .join(', ') || '(none)'}`
      );
    }

    const meta = template.meta;
    const quality = input.quality || 'low';
    const defaultSteps = quality === 'high' ? 35 : quality === 'medium' ? 20 : 8;
    // Templates for distilled models (Lightning etc.) override the step mapping.
    const steps = meta.quality_steps?.[quality] ?? defaultSteps;
    const positive = `${meta.prompt_prefix ?? ''}${input.prompt}${meta.prompt_suffix ?? ''}`;
    const negative = input.negativePrompt ?? meta.negative_default ?? '';

    const seed = input.seed ?? Math.floor(Math.random() * 1000000);

    // Patch by title, but only titles the template actually has — architectures
    // spread these inputs across different nodes (classic SDXL: one KSampler;
    // Flux: RandomNoise + BasicScheduler + SamplerCustomAdvanced; no negative).
    const patches: WorkflowPatches = {
      POSITIVE_PROMPT: { text: positive },
    };
    if (template.titles.has('NEGATIVE_PROMPT')) {
      patches.NEGATIVE_PROMPT = { text: negative };
    }
    if (template.titles.has('SAMPLER')) {
      patches.SAMPLER = { seed, steps, denoise: input.denoise };
    }
    if (template.titles.has('NOISE')) {
      patches.NOISE = { noise_seed: seed };
    }
    if (template.titles.has('SCHEDULER')) {
      patches.SCHEDULER = { steps, denoise: input.denoise };
    }

    const model = input.model ?? meta.defaults?.model;
    if (model && template.titles.has('MODEL')) {
      // Checkpoint loaders take ckpt_name; UNET loaders (Flux etc.) take unet_name.
      const modelNode = template.graph[template.titles.get('MODEL')!];
      const modelKey =
        'ckpt_name' in modelNode.inputs
          ? 'ckpt_name'
          : 'unet_name' in modelNode.inputs
            ? 'unet_name'
            : null;
      if (!modelKey) {
        throw new Error(
          `MODEL node in template "${templateName}" has neither ckpt_name nor unet_name — cannot apply model "${model}"`
        );
      }
      patches.MODEL = { [modelKey]: model };
    }
    if (template.titles.has('LATENT')) {
      patches.LATENT = { width: input.width, height: input.height };
    }
    // Flux's ModelSamplingFlux node carries its own width/height — keep in sync.
    if (template.titles.has('MODEL_SAMPLING')) {
      patches.MODEL_SAMPLING = { width: input.width, height: input.height };
    }
    if (input.referenceImage) {
      if (!template.titles.has('REFERENCE_IMAGE')) {
        throw new Error(
          `Template "${templateName}" has no REFERENCE_IMAGE node but a reference image was provided — use an img2img template`
        );
      }
      patches.REFERENCE_IMAGE = { image: input.referenceImage };
    }

    const graph = this.workflows.instantiate(templateName, patches);

    // Fail fast (with names) if the install is missing custom nodes the template needs.
    try {
      const missing = await this.validateWorkflowNodes(graph);
      if (missing.length > 0) {
        throw new Error(
          `ComfyUI is missing node types required by template "${templateName}": ${missing.join(', ')}. Install the corresponding custom nodes.`
        );
      }
    } catch (error: any) {
      if (error.message?.includes('missing node types')) throw error;
      // object_info unreachable — let submission surface the real connectivity error.
      this.logger.debug('Skipping node validation (object_info unavailable)', {
        error: error.message,
      });
    }

    return graph;
  }

  async submitWorkflowGraph(workflow: Record<string, any>): Promise<ComfyUIJobResponse> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/prompt`,
        {
          prompt: workflow,
          client_id: this.clientId,
        },
        {
          timeout: 10000,
        }
      );

      this.logger.info('ComfyUI job submitted', {
        promptId: response.data.prompt_id,
        clientId: this.clientId,
      });

      return response.data;
    } catch (error: any) {
      const responseStatus = error?.response?.status;
      const responseData = error?.response?.data;
      this.logger.error('Failed to submit job to ComfyUI', {
        error: error instanceof Error ? error.message : 'Unknown error',
        status: responseStatus,
        response: responseData,
      });
      throw error;
    }
  }

  async getJobStatus(promptId: string): Promise<'queued' | 'running' | 'complete' | 'failed'> {
    const info = await this.getJobStatusWithProgress(promptId);
    return info.status;
  }

  async getJobStatusWithProgress(promptId: string): Promise<{
    status: 'queued' | 'running' | 'complete' | 'failed';
    currentStep?: number;
    totalSteps?: number;
    estimatedTimeRemaining?: number;
  }> {
    try {
      this.logger.info('Checking job status', { promptId, baseUrl: this.baseUrl });

      // Check history for completed jobs
      const historyResponse = await axios.get(`${this.baseUrl}/history/${promptId}`, {
        timeout: 5000,
      });

      const historyKeys = Object.keys(historyResponse.data);
      this.logger.info('History response', {
        promptId,
        historyKeys,
        hasData: historyKeys.length > 0,
      });

      if (historyResponse.data && historyKeys.length > 0) {
        this.logger.info('Job found in history - complete', { promptId });
        return { status: 'complete' };
      }

      // Check queue for pending/running jobs
      const queueResponse = await axios.get(`${this.baseUrl}/queue`, {
        timeout: 5000,
      });

      const queueData = queueResponse.data;
      const runningCount = queueData.queue_running?.length || 0;
      const pendingCount = queueData.queue_pending?.length || 0;

      this.logger.info('Queue response', {
        promptId,
        runningCount,
        pendingCount,
        runningIds: queueData.queue_running?.map((item: any) => item[1]) || [],
        pendingIds: queueData.queue_pending?.map((item: any) => item[1]) || [],
      });

      // Check running queue and extract progress info
      const runningItem = queueData.queue_running?.find((item: any) => item[1] === promptId);
      if (runningItem) {
        this.logger.info('Job found in running queue', { promptId });

        // Extract workflow info to determine total steps
        const workflow = runningItem[2];
        let totalSteps = 8; // Default optimized step count
        if (workflow && workflow['5'] && workflow['5'].inputs && workflow['5'].inputs.steps) {
          totalSteps = workflow['5'].inputs.steps;
        }

        // Estimate current step based on time (rough estimate: 15-20 seconds per step on M4)
        const estimatedSecondsPerStep = 18; // Average for M4 MPS
        const estimatedTotalTime = totalSteps * estimatedSecondsPerStep;
        const currentStep = Math.min(totalSteps, Math.floor(Math.random() * totalSteps) + 1); // Placeholder - ComfyUI doesn't expose real-time step progress
        const estimatedTimeRemaining = (totalSteps - currentStep) * estimatedSecondsPerStep;

        return {
          status: 'running',
          currentStep,
          totalSteps,
          estimatedTimeRemaining,
        };
      }

      // Check pending queue
      if (
        queueData.queue_pending &&
        queueData.queue_pending.some((item: any) => item[1] === promptId)
      ) {
        this.logger.info('Job found in pending queue', { promptId });
        return { status: 'queued' };
      }

      // Not found in any queue, might have failed or been removed
      this.logger.warn('Job not found in any queue - returning failed', { promptId });
      return { status: 'failed' };
    } catch (error) {
      this.logger.error('Failed to get job status from ComfyUI', {
        promptId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return { status: 'failed' };
    }
  }

  async getJobImages(promptId: string): Promise<string[]> {
    try {
      const historyResponse = await axios.get(`${this.baseUrl}/history/${promptId}`, {
        timeout: 5000,
      });

      const history = historyResponse.data;
      if (!history || !Object.keys(history).length) {
        return [];
      }

      const jobData = history[promptId];
      if (!jobData || !jobData.outputs) {
        return [];
      }

      // Extract image filenames from outputs
      const imageFilenames: string[] = [];
      for (const nodeId of Object.keys(jobData.outputs)) {
        const nodeOutput = jobData.outputs[nodeId];
        if (nodeOutput && nodeOutput.images && Array.isArray(nodeOutput.images)) {
          for (const image of nodeOutput.images) {
            if (image.filename) {
              imageFilenames.push(image.filename);
            }
          }
        }
      }

      return imageFilenames;
    } catch (error) {
      this.logger.error('Failed to get job images from ComfyUI', {
        promptId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return [];
    }
  }

  async downloadImage(filename: string): Promise<Buffer> {
    try {
      const response = await axios.get(`${this.baseUrl}/view`, {
        params: { filename },
        responseType: 'arraybuffer',
        timeout: 30000,
      });

      return Buffer.from(response.data);
    } catch (error) {
      this.logger.error('Failed to download image from ComfyUI', {
        filename,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  async cancelJob(promptId: string): Promise<boolean> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/interrupt`,
        {},
        {
          timeout: 5000,
        }
      );

      this.logger.info('ComfyUI job cancelled', { promptId });
      return response.status === 200;
    } catch (error) {
      this.logger.error('Failed to cancel ComfyUI job', {
        promptId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return false;
    }
  }

  private buildWorkflow(input: ComfyUIWorkflowInput): Record<string, any> {
    // Enhanced prompt for D&D Battlemaps SDXL
    const enhancedPrompt = `2d DnD battlemap of ${input.prompt}, top-down view, overhead perspective, aerial`;

    // Negative prompt optimized for battlemap generation
    const negativePrompt =
      'grid, low angle, isometric, oblique, horizon, text, watermark, logo, caption, people, creatures, monsters, blurry, artifacts';

    // Map quality setting to diffusion steps
    const quality = input.quality || 'low';
    const steps = quality === 'high' ? 35 : quality === 'medium' ? 20 : 8;

    return {
      '1': {
        // CheckpointLoaderSimple
        inputs: {
          ckpt_name: 'dDBattlemapsSDXL10_upscaleV10.safetensors',
        },
        class_type: 'CheckpointLoaderSimple',
      },
      '2': {
        // CLIP Text Encode (Positive)
        inputs: {
          text: enhancedPrompt,
          clip: ['1', 1],
        },
        class_type: 'CLIPTextEncode',
      },
      '3': {
        // CLIP Text Encode (Negative)
        inputs: {
          text: negativePrompt,
          clip: ['1', 1],
        },
        class_type: 'CLIPTextEncode',
      },
      '4': {
        // Empty Latent Image
        inputs: {
          width: input.width,
          height: input.height,
          batch_size: 1,
        },
        class_type: 'EmptyLatentImage',
      },
      '5': {
        // KSampler - Configurable quality via steps
        inputs: {
          seed: input.seed || Math.floor(Math.random() * 1000000),
          steps: steps, // low=8, medium=20, high=35
          cfg: 2.5, // Lower CFG for faster convergence
          denoise: 1.0,
          sampler_name: 'dpmpp_2m_sde', // SDE variant for better quality at low steps
          scheduler: 'karras',
          model: ['1', 0],
          positive: ['2', 0],
          negative: ['3', 0],
          latent_image: ['4', 0],
        },
        class_type: 'KSampler',
      },
      '9': {
        // VAE Loader
        inputs: {
          vae_name: 'sdxl_vae.safetensors',
        },
        class_type: 'VAELoader',
      },
      '6': {
        // VAE Decode
        inputs: {
          samples: ['5', 0],
          vae: ['9', 0],
        },
        class_type: 'VAEDecode',
      },
      '7': {
        // Save Image
        inputs: {
          filename_prefix: 'battlemap',
          images: ['6', 0],
        },
        class_type: 'SaveImage',
      },
    };
  }

  getSizePixels(size: 'small' | 'medium' | 'large'): number {
    return SIZE_MAPPING[size];
  }

  async shutdown(): Promise<void> {
    if (this.process && !this.process.killed) {
      await this.stopService();
    }
    this.logger.info('ComfyUI client shutdown complete');
  }
}
