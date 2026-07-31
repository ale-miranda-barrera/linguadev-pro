import { env } from '../../lib/env.js';
import { getAiApiKey } from '../../lib/ssm.js';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AIProvider {
  name: string;
  model(): string;
  isConfigured(): Promise<boolean>;
  completeJson<T = unknown>(opts: {
    system: string;
    user: string;
    maxTokens?: number;
    signal?: AbortSignal;
  }): Promise<{ raw: string; parsed: T | null; usage?: { inputTokens?: number; outputTokens?: number } }>;
  streamText(opts: {
    system: string;
    user: string;
    maxTokens?: number;
    signal?: AbortSignal;
    onToken: (chunk: string) => void;
  }): Promise<{ usage?: { inputTokens?: number; outputTokens?: number } }>;
  // Chat multi-turn nativo: pasa el historial completo al provider sin concatenar.
  // Es lo que hace posible una conversación real con memoria de turnos previos.
  streamMessages(opts: {
    system: string;
    messages: ChatTurn[];
    maxTokens?: number;
    signal?: AbortSignal;
    onToken: (chunk: string) => void;
  }): Promise<{ usage?: { inputTokens?: number; outputTokens?: number } }>;
}

class UnavailableProvider implements AIProvider {
  name = 'unavailable';
  model() {
    return '';
  }
  async isConfigured(): Promise<boolean> {
    return false;
  }
  async completeJson<T>(): Promise<{ raw: string; parsed: T | null }> {
    throw new Error('AI_UNAVAILABLE');
  }
  async streamText(): Promise<{ usage?: { inputTokens?: number; outputTokens?: number } }> {
    throw new Error('AI_UNAVAILABLE');
  }
  async streamMessages(): Promise<{ usage?: { inputTokens?: number; outputTokens?: number } }> {
    throw new Error('AI_UNAVAILABLE');
  }
}

let cachedProvider: AIProvider | undefined;

export async function getProvider(): Promise<AIProvider> {
  if (cachedProvider) return cachedProvider;
  const key = await getAiApiKey();
  let p: AIProvider;
  if (!key) {
    p = new UnavailableProvider();
  } else if (env.aiProvider === 'anthropic') {
    const { AnthropicProvider } = await import('./anthropic.js');
    p = new AnthropicProvider(key);
  } else if (env.aiProvider === 'openai') {
    const { OpenAIProvider } = await import('./openai.js');
    p = new OpenAIProvider(key);
  } else if (env.aiProvider === 'deepseek') {
    const { DeepSeekProvider } = await import('./deepseek.js');
    p = new DeepSeekProvider(key);
  } else {
    p = new UnavailableProvider();
  }
  cachedProvider = p;
  return p;
}

// Solo para tests: fuerza recomputar el provider tras cambiar env vars.
export function resetProviderCacheForTests(): void {
  cachedProvider = undefined;
}

// Solo para tests: inyecta un provider fake sin necesidad de env vars ni red.
export function setProviderForTests(p: AIProvider | undefined): void {
  cachedProvider = p;
}
