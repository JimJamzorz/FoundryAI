import * as fs from 'fs';

import * as os from 'os';

import * as path from 'path';

import * as net from 'net';

import { spawn, ChildProcess } from 'child_process';

import { evaluateLockFile } from './lock.js';

import { config } from './config.js';

import { Logger } from './logger.js';

import { FoundryClient } from './foundry-client.js';

import { MapGenerationTools } from './tools/map-generation.js';

const CONTROL_HOST = '127.0.0.1';

const CONTROL_PORT = 31414;

const LOCK_FILE = path.join(os.tmpdir(), 'foundry-mcp-backend.lock');

// Forwards tool calls to FoundryAI via the socket bridge (foundry-connector.ts WebSocket server).
// FoundryAI's mcp-bridge.ts connects to that server and handles mcp-request messages.
class FoundryAIBridge {
  private foundryClient: FoundryClient;
  private logger: Logger;
  private cachedTools: any[] = [];

  constructor(foundryClient: FoundryClient, logger: Logger) {
    this.foundryClient = foundryClient;
    this.logger = logger;
  }

  async callTool(name: string, args: Record<string, any>): Promise<string> {
    console.log(`FoundryAI MCP Server | forwarding tool call: ${name}`);
    const result = await this.foundryClient.query(`foundry-ai.tool.${name}`, args);
    return typeof result === 'string' ? result : JSON.stringify(result);
  }

  async getTools(): Promise<any[]> {
    if (!this.foundryClient.isConnected()) {
      const deadline = Date.now() + 2500;
      while (!this.foundryClient.isConnected() && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!this.foundryClient.isConnected()) {
        console.log('FoundryAI MCP Server | getTools: not connected, returning cached tools');
        return this.cachedTools;
      }
    }
    try {
      const result = await this.foundryClient.query('foundry-ai.get_tools', {});
      const tools = typeof result === 'string' ? JSON.parse(result) : result;
      if (Array.isArray(tools)) {
        this.cachedTools = tools;
        console.log(`FoundryAI MCP Server | getTools: fetched ${tools.length} tools from FoundryAI`);
      }
      return this.cachedTools;
    } catch (err: any) {
      this.logger.warn('Failed to fetch tool definitions from FoundryAI', { error: err?.message });
      return this.cachedTools;
    }
  }

  get isConnected(): boolean {
    return this.foundryClient.isConnected();
  }
}

function getBundledPythonPath(): string {
  // Detect installation directory based on current executable location
  let installDir = path.join(os.homedir(), 'AppData', 'Local', 'FoundryMCPServer');

  // Try to detect install directory from current process location
  const currentDir = process.cwd();
  const execDir = path.dirname(process.execPath);

  // Check if we're running from an installed location
  if (currentDir.includes('FoundryMCPServer') || execDir.includes('FoundryMCPServer')) {
    // Extract the installation directory
    const foundryMcpIndex = currentDir.indexOf('FoundryMCPServer');
    if (foundryMcpIndex !== -1) {
      installDir = currentDir.substring(0, foundryMcpIndex + 'FoundryMCPServer'.length);
    } else {
      const foundryMcpExecIndex = execDir.indexOf('FoundryMCPServer');
      if (foundryMcpExecIndex !== -1) {
        installDir = execDir.substring(0, foundryMcpExecIndex + 'FoundryMCPServer'.length);
      }
    }
  }

  // Check for nested ComfyUI installation (current actual structure)
  const nestedComfyUIPythonPath = path.join(
    installDir,
    'ComfyUI',
    'ComfyUI',
    'python_embeded',
    'python.exe'
  );
  if (fs.existsSync(nestedComfyUIPythonPath)) {
    return nestedComfyUIPythonPath;
  }

  // Check for flat ComfyUI portable installation (fallback)
  const portablePythonPath = path.join(installDir, 'ComfyUI', 'python_embeded', 'python.exe');
  if (fs.existsSync(portablePythonPath)) {
    return portablePythonPath;
  }

  // Path to bundled Python virtual environment (legacy)
  const bundledPythonPath = path.join(installDir, 'ComfyUI-env', 'Scripts', 'python.exe');

  // Check if bundled Python exists
  if (fs.existsSync(bundledPythonPath)) {
    return bundledPythonPath;
  }

  // Fallback: try alternative installation paths
  const fallbackPaths = [
    path.join(
      os.homedir(),
      'AppData',
      'Local',
      'FoundryMCPServer',
      'ComfyUI',
      'ComfyUI',
      'python_embeded',
      'python.exe'
    ),
    path.join(
      os.homedir(),
      'AppData',
      'Local',
      'FoundryMCPServer',
      'ComfyUI-headless',
      'ComfyUI',
      'python_embeded',
      'python.exe'
    ),
    path.join(
      os.homedir(),
      'AppData',
      'Local',
      'FoundryMCPServer',
      'ComfyUI',
      'python_embeded',
      'python.exe'
    ),
    path.join(
      os.homedir(),
      'AppData',
      'Local',
      'FoundryMCPServer',
      'ComfyUI-headless',
      'python_embeded',
      'python.exe'
    ),
    path.join(
      os.homedir(),
      'AppData',
      'Local',
      'FoundryMCPServer',
      'ComfyUI-env',
      'Scripts',
      'python.exe'
    ),
    path.join(process.cwd(), '..', '..', 'ComfyUI-env', 'Scripts', 'python.exe'),
    path.join(os.homedir(), 'AppData', 'Local', 'FoundryMCPServer', 'Python', 'python.exe'),
  ];

  for (const fallbackPath of fallbackPaths) {
    if (fs.existsSync(fallbackPath)) {
      return fallbackPath;
    }
  }

  // Final fallback to system Python (should not happen with bundled installer)
  console.error('Bundled Python not found, falling back to system Python');
  return 'python';
}

// ComfyUI Service Management

let comfyuiProcess: ChildProcess | null = null;

let comfyuiStatus: 'stopped' | 'starting' | 'running' | 'error' = 'stopped';

let lockFd: number | null = null;

function acquireLock(): boolean {
  try {
    try {
      lockFd = fs.openSync(LOCK_FILE, 'wx');
    } catch (err: any) {
      if (err && err.code === 'EEXIST') {
        try {
          const lockData = fs.readFileSync(LOCK_FILE, 'utf8');

          const lockPid = parseInt(lockData.trim(), 10);

          try {
            process.kill(lockPid, 0);

            if (evaluateLockFile(lockPid, LOCK_FILE) === 'orphaned') {
              console.error(
                `Removing orphaned backend lock for PID ${lockPid} ` +
                `(process is not node.exe or lock file is stale)`,
              );
              try { fs.unlinkSync(LOCK_FILE); } catch {}
              lockFd = fs.openSync(LOCK_FILE, 'wx');
            } else {
              return false;
            }

          } catch {
            console.error(`Removing stale backend lock for PID ${lockPid}`);

            try {
              fs.unlinkSync(LOCK_FILE);
            } catch {}

            lockFd = fs.openSync(LOCK_FILE, 'wx');
          }
        } catch (readErr) {
          console.error('Corrupt backend lock file, removing:', readErr);

          try {
            fs.unlinkSync(LOCK_FILE);
          } catch {}

          lockFd = fs.openSync(LOCK_FILE, 'wx');
        }
      } else {
        console.error('Failed to open backend lock file:', err);

        return false;
      }
    }

    if (lockFd === null) return false;

    fs.writeFileSync(lockFd, String(process.pid));

    try {
      fs.fsyncSync(lockFd);
    } catch {}

    console.error(`Acquired backend lock with PID ${process.pid}`);

    return true;
  } catch (error) {
    console.error('Failed to acquire backend lock:', error);

    return false;
  }
}

function releaseLock(): void {
  try {
    if (lockFd !== null) {
      try {
        fs.closeSync(lockFd);
      } catch {}
      lockFd = null;
    }

    if (fs.existsSync(LOCK_FILE)) {
      try {
        fs.unlinkSync(LOCK_FILE);
      } catch {}
    }
  } catch (error) {
    console.error('Failed to release backend lock:', error);
  }
}

// ComfyUI Service Management Functions

async function findComfyUIPath(): Promise<string> {
  const nestedComfyUIPath = path.join(
    os.homedir(),
    'AppData',
    'Local',
    'FoundryMCPServer',
    'ComfyUI',
    'ComfyUI'
  );

  if (fs.existsSync(path.join(nestedComfyUIPath, 'main.py'))) {
    return nestedComfyUIPath;
  }

  const nestedHeadlessPath = path.join(
    os.homedir(),
    'AppData',
    'Local',
    'FoundryMCPServer',
    'ComfyUI-headless',
    'ComfyUI'
  );

  if (fs.existsSync(path.join(nestedHeadlessPath, 'main.py'))) {
    return nestedHeadlessPath;
  }

  const flatPath = path.join(os.homedir(), 'AppData', 'Local', 'FoundryMCPServer', 'ComfyUI');

  if (fs.existsSync(path.join(flatPath, 'main.py'))) {
    return flatPath;
  }

  const legacyFlatPath = path.join(
    os.homedir(),
    'AppData',
    'Local',
    'FoundryMCPServer',
    'ComfyUI-headless'
  );

  if (fs.existsSync(path.join(legacyFlatPath, 'main.py'))) {
    return legacyFlatPath;
  }

  throw new Error('ComfyUI installation not found');
}

async function waitForComfyUIReady(timeoutMs: number = 60000): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetch('http://127.0.0.1:31411/system_stats', {
        signal: AbortSignal.timeout(5000),
      });

      if (response.ok) {
        return;
      }
    } catch (error) {
      // Still starting up, continue polling
    }

    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  throw new Error('ComfyUI failed to start within timeout');
}

async function startComfyUIService(logger: Logger): Promise<any> {
  if (comfyuiStatus === 'running') {
    return { status: 'already_running', message: 'ComfyUI service is already running' };
  }

  if (comfyuiStatus === 'starting') {
    return { status: 'starting', message: 'ComfyUI service start already in progress' };
  }

  try {
    comfyuiStatus = 'starting';

    logger.info('Starting ComfyUI service...');

    const comfyUIPath = await findComfyUIPath();

    logger.info('ComfyUI found', { path: comfyUIPath });

    logger.info('Starting ComfyUI process', { path: path.join(comfyUIPath, 'main.py') });

    const pythonExe = getBundledPythonPath();
    logger.info('Using bundled Python', { pythonPath: pythonExe });

    comfyuiProcess = spawn(
      pythonExe,
      [
        'main.py',

        '--port',
        '31411',

        '--listen',
        '127.0.0.1',

        '--disable-auto-launch',

        '--dont-print-server',
      ],
      {
        cwd: comfyUIPath,

        stdio: ['ignore', 'pipe', 'pipe'],

        detached: false,

        windowsHide: true,
      }
    );

    comfyuiProcess.on('spawn', () => {
      logger.info('ComfyUI process spawned successfully');
    });

    comfyuiProcess.on('error', error => {
      logger.error('ComfyUI process error', { error: error.message });

      comfyuiStatus = 'error';
    });

    comfyuiProcess.on('exit', (code, signal) => {
      logger.info('ComfyUI process exited', { code, signal });

      comfyuiStatus = 'stopped';

      comfyuiProcess = null;
    });

    comfyuiProcess.stdout?.on('data', data => {
      logger.debug('ComfyUI stdout', { data: data.toString().trim() });
    });

    comfyuiProcess.stderr?.on('data', data => {
      logger.debug('ComfyUI stderr', { data: data.toString().trim() });
    });

    await waitForComfyUIReady();

    comfyuiStatus = 'running';

    logger.info('ComfyUI service started successfully', {
      pid: comfyuiProcess.pid,

      status: comfyuiStatus,
    });

    return {
      status: 'running',

      message: 'ComfyUI service started successfully',

      pid: comfyuiProcess.pid,
    };
  } catch (error: any) {
    logger.error('ComfyUI service start failed', { error: error.message });

    comfyuiStatus = 'error';

    if (comfyuiProcess) {
      comfyuiProcess.kill();

      comfyuiProcess = null;
    }

    return {
      status: 'error',

      message: `Failed to start ComfyUI service: ${error.message}`,
    };
  }
}

async function stopComfyUIService(logger: Logger): Promise<any> {
  if (comfyuiStatus === 'stopped') {
    return { status: 'already_stopped', message: 'ComfyUI service is already stopped' };
  }

  try {
    logger.info('Stopping ComfyUI service...');

    if (comfyuiProcess) {
      comfyuiProcess.kill('SIGTERM');

      await new Promise(resolve => setTimeout(resolve, 5000));

      if (comfyuiProcess && !comfyuiProcess.killed) {
        comfyuiProcess.kill('SIGKILL');
      }
    }

    comfyuiStatus = 'stopped';

    comfyuiProcess = null;

    logger.info('ComfyUI service stopped successfully');

    return { status: 'stopped', message: 'ComfyUI service stopped successfully' };
  } catch (error: any) {
    logger.error('ComfyUI service stop failed', { error: error.message });

    return { status: 'error', message: `Failed to stop ComfyUI service: ${error.message}` };
  }
}

async function checkComfyUIStatus(): Promise<any> {
  try {
    const response = await fetch('http://127.0.0.1:31411/system_stats', {
      signal: AbortSignal.timeout(5000),
    });

    if (response.ok) {
      comfyuiStatus = 'running';
    } else {
      comfyuiStatus = 'error';
    }
  } catch (error) {
    comfyuiStatus = 'stopped';
  }

  return {
    status: comfyuiStatus,

    message: getStatusMessage(comfyuiStatus),

    pid: comfyuiProcess?.pid || null,
  };
}

function getStatusMessage(status: string): string {
  const statusMessages = {
    stopped: 'ComfyUI service is not running',

    starting: 'ComfyUI service is starting...',

    running: 'ComfyUI service is running',

    error: 'ComfyUI service encountered an error',
  };

  return statusMessages[status as keyof typeof statusMessages] || 'Unknown status';
}

// Map generation WebSocket handlers (matching existing tool pattern)
async function handleGenerateMapRequest(
  message: any,
  jobQueue: any,
  comfyuiClient: any,
  logger: Logger,
  foundryClient: any
): Promise<any> {
  try {
    logger.info('Map generation request received via WebSocket', { message });

    if (!jobQueue || !comfyuiClient) {
      throw new Error('Map generation components not initialized');
    }

    const data = message.data || message;

    if (!data.prompt || typeof data.prompt !== 'string') {
      throw new Error('Prompt is required and must be a string');
    }

    if (!data.scene_name || typeof data.scene_name !== 'string') {
      throw new Error('Scene name is required and must be a string');
    }

    const params = {
      prompt: data.prompt.trim(),
      scene_name: data.scene_name.trim(),
      size: data.size || 'medium',
      grid_size: data.grid_size || 70,
      quality: data.quality || 'low',
      model: typeof data.model === 'string' && data.model.trim() ? data.model.trim() : undefined,
      template:
        typeof data.template === 'string' && data.template.trim() ? data.template.trim() : undefined,
    };

    // Validate an explicit model against ComfyUI's installed checkpoints while we
    // can still return a helpful error — a bad name failing inside the async job
    // just produces an opaque "failed" status later. Skipped if ComfyUI isn't up
    // yet (it auto-starts during processing); the job will surface any error then.
    if (params.model) {
      await validateModelInstalled(params.model, comfyuiClient, logger);
    }

    const job = await jobQueue.createJob({ params });
    const jobId = job.id;

    processMapGenerationInBackend(jobId, jobQueue, comfyuiClient, logger, foundryClient).catch(
      error => {
        logger.error('Background map generation failed', { jobId, error });
      }
    );

    return {
      status: 'success',
      jobId: jobId,
      message: 'Map generation started',
      estimatedTime: 'varies by hardware and quality setting',
    };
  } catch (error: any) {
    logger.error('Map generation request failed', { error: error.message });
    return {
      status: 'error',
      message: error.message,
    };
  }
}

/**
 * Reject a model name that isn't installed while we can still return a helpful
 * error — a bad name failing inside the async job just produces an opaque
 * "failed" status later. Accepts both namespaces: checkpoints (SDXL templates)
 * and UNET models (Flux templates). Skipped when ComfyUI isn't reachable yet.
 */
async function validateModelInstalled(
  model: string,
  comfyuiClient: any,
  logger: Logger
): Promise<void> {
  try {
    const [checkpoints, unets]: [string[], string[]] = await Promise.all([
      comfyuiClient.listCheckpoints(),
      comfyuiClient.listUnets(),
    ]);
    const known = [...checkpoints, ...unets];
    if (known.length > 0 && !known.includes(model)) {
      throw new Error(
        `Unknown model "${model}". Installed checkpoints: ${checkpoints.join(', ') || '(none)'}. Installed unet models: ${unets.join(', ') || '(none)'}`
      );
    }
  } catch (validationError: any) {
    if (validationError.message?.startsWith('Unknown model')) throw validationError;
    logger.warn('Skipping model validation (ComfyUI not reachable yet)', { model });
  }
}

async function handleGenerateStyledImageRequest(
  message: any,
  jobQueue: any,
  comfyuiClient: any,
  logger: Logger,
  foundryClient: any
): Promise<any> {
  try {
    logger.info('Styled image generation request received', { message });

    if (!jobQueue || !comfyuiClient) {
      throw new Error('Image generation components not initialized');
    }

    const data = message.data || message;

    if (!data.prompt || typeof data.prompt !== 'string') {
      throw new Error('Prompt is required and must be a string');
    }
    if (!data.reference_image || typeof data.reference_image !== 'string') {
      throw new Error(
        'reference_image is required — a Foundry asset path from list_assets, e.g. "foundry-ai/images/portrait.png"'
      );
    }

    const denoise = data.denoise === undefined ? 0.55 : Number(data.denoise);
    if (Number.isNaN(denoise) || denoise <= 0 || denoise > 1) {
      throw new Error('denoise must be a number between 0 (exclusive) and 1');
    }

    const params = {
      prompt: data.prompt.trim(),
      size: data.size || 'medium',
      grid_size: data.grid_size || 70,
      // img2img at low step counts degrades badly, so default one tier higher than maps.
      quality: data.quality || 'medium',
      model: typeof data.model === 'string' && data.model.trim() ? data.model.trim() : undefined,
      template:
        typeof data.template === 'string' && data.template.trim()
          ? data.template.trim()
          : 'img2img-restyle',
      job_type: 'styled-image' as const,
      reference_image: data.reference_image.trim(),
      denoise,
    };

    if (params.model) {
      await validateModelInstalled(params.model, comfyuiClient, logger);
    }

    const job = await jobQueue.createJob({ params });
    const jobId = job.id;

    processStyledImageInBackend(jobId, jobQueue, comfyuiClient, logger, foundryClient).catch(
      error => {
        logger.error('Background styled image generation failed', { jobId, error });
      }
    );

    return {
      status: 'success',
      jobId: jobId,
      message:
        'Styled image generation started. On completion the image is saved to foundry-ai/images/ — the path appears in check-map-status.',
    };
  } catch (error: any) {
    logger.error('Styled image generation request failed', { error: error.message });
    return {
      status: 'error',
      message: error.message,
    };
  }
}

async function processStyledImageInBackend(
  jobId: string,
  jobQueue: any,
  comfyuiClient: any,
  logger: Logger,
  foundryClient: any
): Promise<void> {
  try {
    const job = await jobQueue.getJob(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);
    await jobQueue.markJobStarted(jobId);

    // Ensure ComfyUI is up (same auto-start behavior as map jobs)
    await jobQueue.updateJobProgress(jobId, 10, 'Checking ComfyUI...');
    const healthInfo = await comfyuiClient.checkHealth();
    if (!healthInfo.available) {
      await jobQueue.updateJobProgress(jobId, 15, 'Starting ComfyUI...');
      await comfyuiClient.startService();
    }

    // Pull the reference image out of Foundry storage via the bridge
    await jobQueue.updateJobProgress(jobId, 25, 'Reading reference image from Foundry...');
    const assetResult = await foundryClient.query('foundry-ai.tool.read_asset', {
      path: job.params.reference_image,
    });
    if (!assetResult?.success || !assetResult.imageData) {
      throw new Error(
        `Could not read reference image "${job.params.reference_image}" from Foundry: ${assetResult?.error || 'no data returned'}`
      );
    }

    // Push it into ComfyUI's input folder
    await jobQueue.updateJobProgress(jobId, 35, 'Uploading reference to ComfyUI...');
    const referenceBuffer = Buffer.from(assetResult.imageData, 'base64');
    const referenceName = `ref_${jobId}_${assetResult.filename || 'reference.png'}`;
    const storedName = await comfyuiClient.uploadImage(referenceBuffer, referenceName);

    // Submit the img2img job
    await jobQueue.updateJobProgress(jobId, 45, 'Submitting to ComfyUI...');
    const sizePixels = comfyuiClient.getSizePixels(job.params.size);
    const comfyuiJob = await comfyuiClient.submitJob({
      prompt: job.params.prompt,
      width: sizePixels,
      height: sizePixels,
      quality: job.params.quality,
      model: job.params.model,
      template: job.params.template || 'img2img-restyle',
      referenceImage: storedName,
      denoise: job.params.denoise,
    });

    const currentJob = await jobQueue.getJob(jobId);
    if (currentJob) {
      currentJob.comfyui_job_id = comfyuiJob.prompt_id;
    }

    // Poll to completion, mirroring progress to Foundry like map jobs do
    await jobQueue.updateJobProgress(jobId, 50, 'Generating styled image...');
    comfyuiClient.registerProgressCallback(
      comfyuiJob.prompt_id,
      (progress: { currentStep: number; totalSteps: number }) => {
        const progressPercent = Math.floor((progress.currentStep / progress.totalSteps) * 100);
        foundryClient.sendMessage({
          type: 'map-generation-progress',
          data: {
            jobId: jobId,
            progress: 50 + progressPercent * 0.4,
            status: 'AI generating styled image...',
            queueInfo: {
              currentStep: progress.currentStep,
              totalSteps: progress.totalSteps,
              estimatedTimeRemaining: undefined,
            },
          },
        });
      }
    );

    let status = await comfyuiClient.getJobStatus(comfyuiJob.prompt_id);
    while (status === 'queued' || status === 'running') {
      await new Promise(resolve => setTimeout(resolve, 5000));
      status = await comfyuiClient.getJobStatus(comfyuiJob.prompt_id);
    }
    comfyuiClient.unregisterProgressCallback(comfyuiJob.prompt_id);

    if (status === 'failed') {
      throw new Error('ComfyUI generation failed');
    }

    // Download the result and save it into Foundry (images, not maps — no scene)
    await jobQueue.updateJobProgress(jobId, 90, 'Saving image to Foundry...');
    const imageFilenames = await comfyuiClient.getJobImages(comfyuiJob.prompt_id);
    if (!imageFilenames || imageFilenames.length === 0) {
      throw new Error('No images found in ComfyUI job output');
    }
    const imageBuffer = await comfyuiClient.downloadImage(imageFilenames[0]);

    const filename = `styled_${jobId}_${Date.now()}.png`;
    const uploadResult = await foundryClient.query('foundry-ai.tool.upload_generated_map', {
      filename,
      imageData: imageBuffer.toString('base64'),
      folder: 'images',
    });
    if (!uploadResult?.success) {
      throw new Error(`Failed to upload image to Foundry: ${uploadResult?.error}`);
    }

    await jobQueue.updateJobProgress(jobId, 100, 'Complete');
    await jobQueue.markJobComplete(jobId, {
      generation_time_ms: Date.now() - (job.started_at || job.created_at),
      image_url: uploadResult.path,
    });

    logger.info('Styled image generation completed', { jobId, path: uploadResult.path });
  } catch (error: any) {
    logger.error('Background styled image processing failed', { jobId, error });
    await jobQueue.markJobFailed(jobId, error.message);
    foundryClient.sendMessage({
      type: 'map-generation-failed',
      jobId: jobId,
      error: error.message,
    });
  }
}

async function handleListImageModelsRequest(comfyuiClient: any, logger: Logger): Promise<any> {
  try {
    const health = await comfyuiClient.checkHealth();
    if (!health.available) {
      return {
        status: 'error',
        message:
          'ComfyUI is not running, so installed models cannot be listed. It starts automatically when a generation job runs; try generate-map, or ask again after a job has started it.',
      };
    }

    const [checkpoints, unets, loras, samplers, templates] = await Promise.all([
      comfyuiClient.listCheckpoints(),
      comfyuiClient.listUnets(),
      comfyuiClient.listLoras(),
      comfyuiClient.listSamplers(),
      comfyuiClient.listWorkflowTemplates(),
    ]);

    return {
      status: 'success',
      checkpoints,
      unet_models: unets,
      loras,
      samplers,
      workflow_templates: templates,
      note: 'Pass a checkpoint or unet filename (exactly as listed) as the "model" argument. Checkpoints suit the SDXL templates; unet_models (Flux) require a Flux template such as txt2img-flux.',
    };
  } catch (error: any) {
    logger.error('list-image-models failed', { error: error.message });
    return { status: 'error', message: error.message };
  }
}

async function handleCheckMapStatusRequest(data: any, jobQueue: any, logger: Logger): Promise<any> {
  try {
    if (!data) {
      throw new Error('Request data is required');
    }
    const jobId = data.job_id;
    if (!jobId) {
      throw new Error('Job ID is required');
    }

    const job = await jobQueue.getJob(jobId);
    if (!job) {
      return {
        status: 'error',
        message: `Job ${jobId} not found`,
      };
    }

    return {
      status: 'success',
      job: {
        id: job.id,
        status: job.status,
        progress_percent: job.progress_percent,
        current_stage: job.current_stage,
        result: job.result,
        error: job.error,
      },
    };
  } catch (error: any) {
    logger.error('Map status check failed', { error: error.message });
    return {
      status: 'error',
      message: error.message,
    };
  }
}

async function handleCancelMapJobRequest(
  data: any,
  jobQueue: any,
  comfyuiClient: any,
  logger: Logger
): Promise<any> {
  try {
    if (!data) {
      throw new Error('Request data is required');
    }
    const jobId = data.job_id;
    if (!jobId) {
      throw new Error('Job ID is required');
    }

    const job = await jobQueue.getJob(jobId);
    if (!job) {
      return {
        status: 'error',
        message: 'Job not found',
      };
    }

    if (job.comfyui_job_id) {
      logger.info('Cancelling ComfyUI job', { jobId, promptId: job.comfyui_job_id });
      const comfyuiCancelled = await comfyuiClient.cancelJob(job.comfyui_job_id);
      if (comfyuiCancelled) {
        logger.info('ComfyUI job interrupted successfully', {
          jobId,
          promptId: job.comfyui_job_id,
        });
      } else {
        logger.warn('Failed to interrupt ComfyUI job', { jobId, promptId: job.comfyui_job_id });
      }
    }

    const cancelled = await jobQueue.cancelJob(jobId);

    return {
      status: cancelled ? 'success' : 'error',
      message: cancelled ? 'Job cancelled successfully' : 'Failed to cancel job',
    };
  } catch (error: any) {
    logger.error('Map job cancellation failed', { error: error.message });
    return {
      status: 'error',
      message: error.message,
    };
  }
}

// Background processing using mapgen's proven approach
async function processMapGenerationInBackend(
  jobId: string,
  jobQueue: any,
  comfyuiClient: any,
  logger: Logger,
  foundryClient: any
): Promise<void> {
  const fs2 = await import('fs').then(m => m.promises);
  const path2 = await import('path');
  const os2 = await import('os');
  const processDebugLog = path2.join(os2.tmpdir(), 'process-mapgen-debug.log');
  await fs2.appendFile(
    processDebugLog,
    `[${new Date().toISOString()}] processMapGenerationInBackend ENTERED - jobId: ${jobId}\n`
  );

  try {
    await fs2.appendFile(
      processDebugLog,
      `[${new Date().toISOString()}] Getting job from queue...\n`
    );
    const job = await jobQueue.getJob(jobId);
    if (!job) {
      await fs2.appendFile(
        processDebugLog,
        `[${new Date().toISOString()}] ERROR: Job not found!\n`
      );
      throw new Error(`Job ${jobId} not found`);
    }

    await fs2.appendFile(
      processDebugLog,
      `[${new Date().toISOString()}] Job retrieved: ${JSON.stringify(job.params)}\n`
    );
    logger.info('Starting background map generation processing', { jobId, params: job.params });

    await fs2.appendFile(
      processDebugLog,
      `[${new Date().toISOString()}] Marking job as started...\n`
    );
    await jobQueue.markJobStarted(jobId);
    await fs2.appendFile(processDebugLog, `[${new Date().toISOString()}] Job marked as started\n`);

    foundryClient.sendMessage({
      type: 'map-generation-progress',
      jobId: jobId,
      progress: 10,
      stage: 'Starting processing...',
    });

    await fs2.appendFile(
      processDebugLog,
      `[${new Date().toISOString()}] Checking ComfyUI health...\n`
    );
    const healthInfo = await comfyuiClient.checkHealth();
    await fs2.appendFile(
      processDebugLog,
      `[${new Date().toISOString()}] Health check: ${JSON.stringify(healthInfo)}\n`
    );
    if (!healthInfo.available) {
      await comfyuiClient.startService();
    }

    await jobQueue.updateJobProgress(jobId, 25, 'Submitting to ComfyUI...');
    foundryClient.sendMessage({
      type: 'map-generation-progress',
      jobId: jobId,
      progress: 25,
      stage: 'Submitting to ComfyUI...',
    });

    await fs2.appendFile(
      processDebugLog,
      `[${new Date().toISOString()}] Submitting job to ComfyUI...\n`
    );
    const sizePixels = comfyuiClient.getSizePixels(job.params.size as any);
    await fs2.appendFile(
      processDebugLog,
      `[${new Date().toISOString()}] Size pixels: ${sizePixels}\n`
    );

    let comfyuiJob;
    try {
      comfyuiJob = await comfyuiClient.submitJob({
        prompt: job.params.prompt,
        width: sizePixels,
        height: sizePixels,
        quality: job.params.quality,
        model: job.params.model,
        template: job.params.template,
      });
      await fs2.appendFile(
        processDebugLog,
        `[${new Date().toISOString()}] ComfyUI job submitted: ${comfyuiJob.prompt_id}\n`
      );

      const currentJob = await jobQueue.getJob(jobId);
      if (currentJob) {
        currentJob.comfyui_job_id = comfyuiJob.prompt_id;
      }
    } catch (submitError: any) {
      await fs2.appendFile(
        processDebugLog,
        `[${new Date().toISOString()}] ERROR submitting to ComfyUI: ${submitError.message}\n`
      );
      throw submitError;
    }

    await jobQueue.updateJobProgress(jobId, 50, 'Generating battlemap...');
    foundryClient.sendMessage({
      type: 'map-generation-progress',
      jobId: jobId,
      progress: 50,
      stage: 'Generating battlemap...',
    });

    await fs2.appendFile(
      processDebugLog,
      `[${new Date().toISOString()}] Starting status polling with WebSocket progress...\n`
    );

    comfyuiClient.registerProgressCallback(
      comfyuiJob.prompt_id,
      (progress: { currentStep: number; totalSteps: number }) => {
        const { currentStep, totalSteps } = progress;
        const progressPercent = Math.floor((currentStep / totalSteps) * 100);

        logger.info('Real-time progress update from ComfyUI', {
          jobId,
          promptId: comfyuiJob.prompt_id,
          currentStep,
          totalSteps,
          progressPercent,
        });

        foundryClient.sendMessage({
          type: 'map-generation-progress',
          data: {
            jobId: jobId,
            progress: 50 + progressPercent / 2,
            status: 'AI generating battlemap...',
            queueInfo: {
              currentStep,
              totalSteps,
              estimatedTimeRemaining: undefined,
            },
          },
        });
      }
    );

    let status = await comfyuiClient.getJobStatus(comfyuiJob.prompt_id);
    logger.info('Initial job status', { jobId, promptId: comfyuiJob.prompt_id, status });

    let pollCount = 0;
    while (status === 'queued' || status === 'running') {
      pollCount++;
      await new Promise(resolve => setTimeout(resolve, 5000));
      status = await comfyuiClient.getJobStatus(comfyuiJob.prompt_id);
    }

    comfyuiClient.unregisterProgressCallback(comfyuiJob.prompt_id);

    logger.info('Job polling completed', {
      jobId,
      promptId: comfyuiJob.prompt_id,
      finalStatus: status,
      totalPolls: pollCount,
    });

    if (status === 'failed') {
      throw new Error('ComfyUI generation failed');
    }

    await jobQueue.updateJobProgress(jobId, 85, 'Downloading image...');

    const imageFilenames = await comfyuiClient.getJobImages(comfyuiJob.prompt_id);
    if (!imageFilenames || imageFilenames.length === 0) {
      throw new Error('No images found in ComfyUI job output');
    }

    const firstImageFilename = imageFilenames[0];
    const imageBuffer = await comfyuiClient.downloadImage(firstImageFilename);
    if (!imageBuffer) {
      throw new Error(`Failed to download generated image: ${firstImageFilename}`);
    }

    await jobQueue.updateJobProgress(jobId, 90, 'Saving image...');

    const timestamp = Date.now();
    const filename = `map_${jobId}_${timestamp}.png`;

    const base64Image = imageBuffer.toString('base64');

    let uploadResult: any;
    try {
      uploadResult = await foundryClient.query('foundry-ai.tool.upload_generated_map', {
        filename: filename,
        imageData: base64Image,
      });

      if (!uploadResult.success) {
        throw new Error(`Failed to upload image to Foundry: ${uploadResult.error}`);
      }
    } catch (error) {
      throw error;
    }

    const webPath = uploadResult.path;
    logger.info('Image uploaded successfully to Foundry', { path: webPath });

    await jobQueue.updateJobProgress(jobId, 95, 'Creating Foundry scene...');

    const sceneSize = comfyuiClient.getSizePixels(job.params.size as any);

    if (!job.params.scene_name) {
      throw new Error(
        `Scene name missing from job params. Received params: ${JSON.stringify(job.params)}`
      );
    }

    const sceneName = job.params.scene_name.trim();
    const sceneResult = await foundryClient.query('foundry-ai.tool.generate_scene', {
      name: sceneName,
      image_path: webPath,
      size: `${sceneSize}x${sceneSize}`,
      grid_distance: 5,
      grid_units: 'ft',
    });

    await jobQueue.updateJobProgress(jobId, 100, 'Complete');
    await jobQueue.markJobComplete(jobId, {
      generation_time_ms: Date.now() - (job.started_at || job.created_at),
      image_url: webPath,
      scene_id: sceneResult?.scene_id,
    });

    logger.info('Map generation completed successfully', { jobId });
  } catch (error: any) {
    await fs2.appendFile(
      processDebugLog,
      `[${new Date().toISOString()}] ERROR in processMapGenerationInBackend: ${error.message}\n`
    );

    logger.error('Background map generation processing failed', { jobId, error });
    await jobQueue.markJobFailed(jobId, error.message);

    foundryClient.sendMessage({
      type: 'map-generation-failed',
      jobId: jobId,
      error: error.message,
    });
  }
}

async function startBackend(): Promise<void> {
  const logger = new Logger({
    level: config.logLevel,

    format: config.logFormat,

    enableConsole: false,

    enableFile: true,

    filePath: path.join(os.tmpdir(), 'foundry-mcp-server', 'mcp-server.log'),
  });

  logger.info('Starting FoundryAI MCP Backend', {
    version: config.server.version,

    foundryHost: config.foundry.host,

    foundryPort: config.foundry.port,
  });

  console.log(`FoundryAI MCP Server | starting backend v${config.server.version}`);

  const foundryClient = new FoundryClient(config.foundry, logger);
  const foundryAIBridge = new FoundryAIBridge(foundryClient, logger);
  const controlSockets = new Set<net.Socket>();

  // Initialize mapgen-style backend components for map generation
  let mapGenerationJobQueue: any = null;
  let mapGenerationComfyUIClient: any = null;

  try {
    const { JobQueue } = await import('./job-queue.js');
    const { ComfyUIClient } = await import('./comfyui-client.js');

    mapGenerationJobQueue = new JobQueue({ logger });

    // Pass the full comfyui config through. installPath/pythonCommand are only
    // forwarded when explicitly set via env — otherwise the client's own
    // installation detection would be clobbered by the config-schema defaults.
    const comfyClientConfig: any = {
      port: config.comfyui?.port || 31411,
      host: config.comfyui?.host || '127.0.0.1',
      autoStart: config.comfyui?.autoStart ?? true,
    };
    if (process.env.COMFYUI_INSTALL_PATH) {
      comfyClientConfig.installPath = process.env.COMFYUI_INSTALL_PATH;
    }
    if (process.env.COMFYUI_PYTHON_COMMAND) {
      comfyClientConfig.pythonCommand = process.env.COMFYUI_PYTHON_COMMAND;
    }

    mapGenerationComfyUIClient = new ComfyUIClient({
      logger,
      config: comfyClientConfig,
    });

    logger.info(
      `Map generation backend components initialized (ComfyUI on ${comfyClientConfig.host}:${comfyClientConfig.port}, autoStart=${comfyClientConfig.autoStart})`
    );
    console.log('FoundryAI MCP Server | map generation components initialized');

    if (mapGenerationComfyUIClient && (mapGenerationComfyUIClient as any).config?.autoStart) {
      const isInstalled = await (mapGenerationComfyUIClient as any).checkInstallation();
      if (isInstalled) {
        logger.info('Auto-starting ComfyUI service...');
        try {
          await (mapGenerationComfyUIClient as any).startService();
          logger.info('ComfyUI service auto-started successfully');
        } catch (error) {
          logger.warn('Failed to auto-start ComfyUI service', { error });
        }
      } else {
        logger.info('ComfyUI not installed, skipping auto-start');
      }
    }
  } catch (error) {
    logger.warn('Failed to initialize map generation components', { error });
  }

  (globalThis as any).backendComfyUIHandlers = {
    handleMessage: async (message: any) => {
      logger.info('Handling ComfyUI message', {
        requestId: message.requestId,

        type: message.type,

        hasData: !!message.data,
      });

      try {
        let result: any;

        switch (message.type) {
          case 'start-comfyui-service':
            result = await startComfyUIService(logger);

            break;

          case 'stop-comfyui-service':
            result = await stopComfyUIService(logger);

            break;

          case 'check-comfyui-status':
            result = await checkComfyUIStatus();

            break;

          case 'generate-map-request':
            result = await handleGenerateMapRequest(
              message,
              mapGenerationJobQueue,
              mapGenerationComfyUIClient,
              logger,
              foundryClient
            );
            break;

          case 'check-map-status-request':
            result = await handleCheckMapStatusRequest(message.data, mapGenerationJobQueue, logger);

            break;

          case 'cancel-map-job-request':
            result = await handleCancelMapJobRequest(
              message.data,
              mapGenerationJobQueue,
              mapGenerationComfyUIClient,
              logger
            );

            break;

          default:
            logger.warn('Unknown ComfyUI message type', { type: message.type });

            result = { status: 'error', message: `Unknown message type: ${message.type}` };
        }

        if (message.requestId && foundryClient) {
          const response = {
            type: `${message.type}-response`,

            requestId: message.requestId,

            ...result,
          };

          try {
            foundryClient.sendMessage(response);
          } catch (error) {
            logger.error('Failed to send ComfyUI response to Foundry', { error, response });
          }
        }

        return result;
      } catch (error: any) {
        logger.error('ComfyUI message handling failed', {
          requestId: message.requestId,

          type: message.type,

          error: error.message,
        });

        const errorResult = {
          status: 'error',

          message: error.message,
        };

        if (message.requestId && foundryClient) {
          try {
            foundryClient.sendMessage({
              type: `${message.type}-response`,

              requestId: message.requestId,

              ...errorResult,
            });
          } catch (sendError) {
            logger.error('Failed to send ComfyUI error response', { sendError });
          }
        }

        return errorResult;
      }
    },
  };

  const mapGenerationTools = new MapGenerationTools({
    foundryClient,
    logger,
    backendComfyUIHandlers: (globalThis as any).backendComfyUIHandlers,
  });

  const mapTools = mapGenerationTools.getToolDefinitions();

  // Tools handled locally — all others forward to FoundryAI
  const MAP_JOB_TOOLS = new Set([
    'generate-map',
    'generate-styled-image',
    'check-map-status',
    'cancel-map-job',
    'list-image-models',
  ]);

  // Start Foundry connector (WebSocket server that FoundryAI's mcp-bridge.ts connects to)
  foundryClient.connect().catch(e => {
    logger.error('Foundry connector failed to start', e);
  });

  foundryClient.setOnFoundryConnected(async () => {
    logger.info('Foundry module connected — warming tool cache and notifying index');
    try {
      await foundryAIBridge.getTools();
    } catch (e: any) {
      logger.warn('Failed to warm tool cache on Foundry connect', { error: e?.message });
    }
    const notification = JSON.stringify({ type: 'notification', method: 'tools_changed' }) + '\n';
    for (const sock of controlSockets) {
      try { sock.write(notification); } catch {}
    }
  });

  const autoStartComfyUI = async () => {
    try {
      logger.info('Auto-starting ComfyUI service...');

      const result = await startComfyUIService(logger);

      logger.info('ComfyUI auto-start result', result);
    } catch (error: any) {
      logger.warn('ComfyUI auto-start failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // Control channel (TCP JSON-lines) — index.ts talks to us via this
  const server = net.createServer(socket => {
    controlSockets.add(socket);
    socket.on('close', () => { controlSockets.delete(socket); });
    socket.on('error', () => { controlSockets.delete(socket); });

    socket.setEncoding('utf8');

    let buffer = '';

    socket.on('data', async (chunk: string) => {
      buffer += chunk;

      let idx: number;

      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();

        buffer = buffer.slice(idx + 1);

        if (!line) continue;

        try {
          const msg = JSON.parse(line) as { id: string; method: string; params?: any };

          if (msg.method === 'ping') {
            socket.write(JSON.stringify({ id: msg.id, result: { ok: true } }) + '\n');

            continue;
          }

          if (msg.method === 'list_tools') {
            const foundryTools = await foundryAIBridge.getTools();
            const allTools = [...foundryTools, ...mapTools];
            socket.write(JSON.stringify({ id: msg.id, result: { tools: allTools } }) + '\n');

            continue;
          }

          if (msg.method === 'call_tool') {
            const { name, args } = (msg.params || {}) as { name: string; args?: any };

            try {
              let result: any;

              if (MAP_JOB_TOOLS.has(name)) {
                switch (name) {
                  case 'generate-map':
                    result = await handleGenerateMapRequest(
                      args,
                      mapGenerationJobQueue,
                      mapGenerationComfyUIClient,
                      logger,
                      foundryClient
                    );
                    break;

                  case 'check-map-status':
                    result = await handleCheckMapStatusRequest(args, mapGenerationJobQueue, logger);
                    break;

                  case 'cancel-map-job':
                    result = await handleCancelMapJobRequest(
                      args,
                      mapGenerationJobQueue,
                      mapGenerationComfyUIClient,
                      logger
                    );
                    break;

                  case 'list-image-models':
                    result = await handleListImageModelsRequest(mapGenerationComfyUIClient, logger);
                    break;

                  case 'generate-styled-image':
                    result = await handleGenerateStyledImageRequest(
                      args,
                      mapGenerationJobQueue,
                      mapGenerationComfyUIClient,
                      logger,
                      foundryClient
                    );
                    break;
                }
              } else {
                // Forward everything else to FoundryAI via socket bridge
                const text = await foundryAIBridge.callTool(name, args ?? {});
                result = text;
              }

              const payload = {
                content: [
                  {
                    type: 'text',
                    text: typeof result === 'string' ? result : JSON.stringify(result),
                  },
                ],
              };

              socket.write(JSON.stringify({ id: msg.id, result: payload }) + '\n');
            } catch (e: any) {
              const errorMessage = e instanceof Error ? e.message : 'Unknown error occurred';

              socket.write(
                JSON.stringify({
                  id: msg.id,
                  result: {
                    content: [{ type: 'text', text: `Error: ${errorMessage}` }],
                    isError: true,
                  },
                }) + '\n'
              );
            }

            continue;
          }

          // Unknown method
          socket.write(JSON.stringify({ id: msg.id, error: { message: 'Unknown method' } }) + '\n');
        } catch (e: any) {
          try {
            socket.write(
              JSON.stringify({ error: { message: e?.message || 'Bad request' } }) + '\n'
            );
          } catch {}
        }
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(CONTROL_PORT, CONTROL_HOST, () => {
      logger.info(`Backend control channel listening on ${CONTROL_HOST}:${CONTROL_PORT}`);
      console.log(`FoundryAI MCP Server | control channel ready on ${CONTROL_HOST}:${CONTROL_PORT}`);

      resolve();
    });

    server.on('error', reject);
  });

  void autoStartComfyUI();

  process.on('SIGINT', () => {
    foundryClient.disconnect();
    releaseLock();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    foundryClient.disconnect();
    releaseLock();
    process.exit(0);
  });
}

// Check lock BEFORE any async operations
const hasLock = acquireLock();

(async function main() {
  if (!hasLock) {
    // Another backend is running — wait forever so Claude Desktop doesn't see an error
    await new Promise(() => {}); // Never resolves
    return;
  }

  process.on('exit', releaseLock);

  try {
    await startBackend();
  } catch (e: any) {
    console.error('Failed to start backend:', e?.message || e);

    releaseLock();

    process.exit(1);
  }
})();
