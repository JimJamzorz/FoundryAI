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
          },
          required: ['prompt', 'scene_name'],
        },
      },
      {
        name: 'check-map-status',
        description:
          'Check status of a map generation job by job_id (from generate-map). Progress updates appear automatically in Foundry VTT and the scene is created automatically on completion, so polling is never needed — only call this if the user explicitly asks how the job is going or whether it failed.',
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
