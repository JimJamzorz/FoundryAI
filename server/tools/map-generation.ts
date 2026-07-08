import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { Logger } from '../logger.js';

export interface MapGenerationToolsOptions {
  foundryClient?: unknown;
  logger: Logger;
  backendComfyUIHandlers?: any;
}

export class MapGenerationTools {
  private logger: Logger;

  constructor(options: MapGenerationToolsOptions) {
    this.logger = options.logger.child({ component: 'MapGenerationTools' });
  }

  getToolDefinitions(): Tool[] {
    return [
      {
        name: 'generate-map',
        description:
          'Start AI battle-map generation using D&D Battlemaps SDXL. Async: returns a job_id immediately and runs in the background — when the job completes, the image is saved to Foundry and a new scene is created automatically, with progress shown in Foundry as it runs. After starting a job, just tell the user it is underway; do NOT poll check-map-status to "finish" it.',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description:
                'Map description (will be enhanced with "2d DnD battlemap" trigger and perspective)',
            },
            scene_name: {
              type: 'string',
              description:
                'Short, creative name for the Foundry scene (e.g., "Harbor District", "Moonlit Tavern", "Crystal Caverns"). Be creative and evocative!',
            },
            size: {
              type: 'string',
              enum: ['small', 'medium', 'large'],
              default: 'medium',
              description: 'Map size (small=1024px, medium=1536px, large=2048px)',
            },
            grid_size: {
              type: 'number',
              default: 70,
              description: 'Pixels per 5ft square for Foundry scene setup',
            },
            quality: {
              type: 'string',
              enum: ['low', 'medium', 'high'],
              default: 'low',
              description: 'Generation quality (diffusion steps): low=fast draft, high=slow detailed',
            },
            model: {
              type: 'string',
              description:
                'Optional checkpoint filename to generate with, exactly as returned by list-image-models. Omit to use the default battle-map model. Do NOT guess model names.',
            },
            template: {
              type: 'string',
              description:
                'Optional workflow template name from list-image-models (workflow_templates). Default: "txt2img-map" (battle-map tuned). Use "txt2img-lightning" for very fast drafts with a Lightning checkpoint — with that template, include "top-down 2d battlemap, overhead view" in the prompt yourself, since the battlemap trigger is not baked in.',
            },
          },
          required: ['prompt', 'scene_name'],
        },
      },
      {
        name: 'generate-styled-image',
        description:
          'Generate a new image styled after an existing Foundry image (img2img). Use this to keep generated art visually consistent with module/PDF artwork, or to make variations of an existing map or portrait ("same tavern, but on fire"). Pass a reference image path from FoundryAI\'s list_assets plus a prompt describing the result. Async like generate-map: returns a job_id; on completion the image is saved to foundry-ai/images/ (NO scene is created) and its path appears in check-map-status — apply it with FoundryAI\'s update_actor, update_scene, or generate_scene.',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description: 'Description of the desired output image',
            },
            reference_image: {
              type: 'string',
              description:
                'Foundry asset path of the reference image, exactly as returned by FoundryAI\'s list_assets or extract_pdf_images (e.g. "foundry-ai/images/extracted-map.png"). Do NOT guess paths.',
            },
            denoise: {
              type: 'number',
              default: 0.55,
              description:
                'How far to depart from the reference, 0–1: 0.3 = subtle variation, 0.55 = same composition with new details, 0.75 = loose inspiration only.',
            },
            size: {
              type: 'string',
              enum: ['small', 'medium', 'large'],
              default: 'medium',
              description: 'Output size (small=1024px, medium=1536px, large=2048px)',
            },
            quality: {
              type: 'string',
              enum: ['low', 'medium', 'high'],
              default: 'medium',
              description: 'Generation quality (diffusion steps)',
            },
            model: {
              type: 'string',
              description:
                'Optional model filename from list-image-models (checkpoints for SDXL templates, unet_models for Flux templates). Omit for the template default. Do NOT guess model names.',
            },
            template: {
              type: 'string',
              description:
                'Optional img2img workflow template from list-image-models (workflow_templates). Default: "img2img-restyle" (SDXL). Use "img2img-flux" to restyle with a Flux model — pair it with a unet_models filename.',
            },
          },
          required: ['prompt', 'reference_image'],
        },
      },
      {
        name: 'list-image-models',
        description:
          'List image-generation resources installed in the local ComfyUI: model checkpoints, LoRAs, samplers, and available workflow templates. Call this before passing a model to generate-map, and to answer "what image models do I have?". Requires ComfyUI to be running.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'check-map-status',
        description:
          'Check status of a generation job by job_id (from generate-map or generate-styled-image). Progress updates appear automatically in Foundry VTT and completion is automatic (map jobs create their scene; styled-image jobs save to foundry-ai/images/ — the result path is in this response when complete), so polling is never needed. Only call this if the user asks how a job is going, whether it failed, or for a styled image\'s saved path.',
        inputSchema: {
          type: 'object',
          properties: {
            job_id: {
              type: 'string',
              description: 'Job ID to check status for',
            },
          },
          required: ['job_id'],
        },
      },
      {
        name: 'cancel-map-job',
        description: 'Cancel a running map generation job',
        inputSchema: {
          type: 'object',
          properties: {
            job_id: {
              type: 'string',
              description: 'Job ID to cancel',
            },
          },
          required: ['job_id'],
        },
      },
    ];
  }

  async shutdown(): Promise<void> {
    this.logger.info('MapGenerationTools shutdown complete');
  }
}
