import { readEnvFile } from '../env.js';

const envConfig = readEnvFile([
  'THENVOI_AGENT_ID',
  'THENVOI_API_KEY',
  'THENVOI_BASE_URL',
  'THENVOI_OWNER_ID',
  'THENVOI_MEMORY_TOOLS',
  'THENVOI_MEMORY_LOAD_ON_START',
  'THENVOI_MEMORY_CONSOLIDATION',
  'THENVOI_CONTACT_STRATEGY',
  'THENVOI_CONTACT_AGENT_GROUP_ID',
]);

function env(name: keyof typeof envConfig): string | undefined {
  return process.env[name] || envConfig[name];
}

function envBool(name: keyof typeof envConfig, fallback = false): boolean {
  const value = env(name);
  if (value === undefined) return fallback;
  return value === 'true' || value === '1';
}

export type ThenvoiContactStrategy = 'disabled' | 'hub_room';

export const DEFAULT_THENVOI_BASE_URL = 'https://app.thenvoi.com';

export interface ThenvoiConfig {
  agentId: string;
  apiKey: string;
  baseUrl: string;
  ownerId: string | undefined;
  memoryTools: boolean;
  memoryLoadOnStart: boolean;
  memoryConsolidation: boolean;
  contactStrategy: ThenvoiContactStrategy;
  contactAgentGroupId: string | undefined;
}

export function getThenvoiConfig(): ThenvoiConfig | null {
  const agentId = env('THENVOI_AGENT_ID');
  const apiKey = env('THENVOI_API_KEY');
  const baseUrl = env('THENVOI_BASE_URL') || DEFAULT_THENVOI_BASE_URL;
  if (!agentId || !apiKey) return null;

  const contactStrategy = env('THENVOI_CONTACT_STRATEGY') ?? 'disabled';
  if (contactStrategy !== 'disabled' && contactStrategy !== 'hub_room') {
    throw new Error(`Invalid THENVOI_CONTACT_STRATEGY: ${contactStrategy}`);
  }

  return {
    agentId,
    apiKey,
    baseUrl,
    ownerId: env('THENVOI_OWNER_ID'),
    memoryTools: envBool('THENVOI_MEMORY_TOOLS'),
    memoryLoadOnStart: envBool('THENVOI_MEMORY_LOAD_ON_START'),
    memoryConsolidation: envBool('THENVOI_MEMORY_CONSOLIDATION'),
    contactStrategy,
    contactAgentGroupId: env('THENVOI_CONTACT_AGENT_GROUP_ID'),
  };
}
