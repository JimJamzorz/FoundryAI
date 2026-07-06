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
        description: 'Start AI map generation using D&D Battlemaps SDXL (async)',
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
          'Check status of map generation job. Progress updates appear automatically in Foundry VTT. DO NOT check frequently - this wastes tokens. Only check if user explicitly asks for status.',
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
