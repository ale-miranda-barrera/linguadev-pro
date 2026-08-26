import Dexie, { type Table } from 'dexie';
import type { SrsState, ErrorEntry, Pack } from '@linguadev/shared';

// Dexie es la fuente de verdad local. El sync a DynamoDB es solo un respaldo.

export interface StoredPack extends Pack {
  enabled: boolean;
  installedAt: string;
}

export interface Profile {
  id: 'me';
  level: 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2';
  streak: number;
  lastStudiedIsoDay?: string;
  dailyGoalMinutes: number;
  tz: string;
  version: number;
  updatedAt: string;
}

export interface ConversationTurn {
  role: 'user' | 'assistant';
  text: string;
  ts: string;
}

export interface Conversation {
  id: string;
  createdAt: string;
  updatedAt: string;
  level: 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2';
  scenario: string;
  turns: ConversationTurn[];
  // Métricas útiles para review posterior.
  durationMs?: number;
  userWordCount?: number;
}

// Chat de texto genérico con IA (independiente de VoiceCall que usa `conversations`).
// Un chat = una conversación con su preset. Los mensajes viven en otra tabla para
// facilitar índices por chat + orden temporal.
export type ChatPresetLocal = 'general' | 'english-tutor' | 'aws-tutor' | 'custom';

export interface Chat {
  id: string;
  title: string;
  preset: ChatPresetLocal;
  systemOverride?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  // Métricas acumuladas útiles para el panel de monitoreo.
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCostUsd?: number;
}

export interface ChatMessage {
  id: string;
  chatId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  // Opcionales, solo poblados en mensajes assistant.
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

// Progreso por simulación AWS. Un registro por simulación intentada.
export interface AwsSimAttempt {
  simId: string; // ej. "clf-c02-sim-01-cloud-concepts-fundamentals"
  certId: 'clf-c02' | 'saa-c03';
  order: number;
  bestScore01: number; // mejor puntaje 0-1
  attempts: number;
  passed: boolean;
  firstPassedAt?: string;
  lastAttemptAt: string;
  // Historial por dominio: {domainId: {correct, total}}
  perDomainStats?: Record<string, { correct: number; total: number }>;
}

// Progreso por simulación Tech (Programador, Arquitectura, DevOps, etc.).
// Mismo espíritu que AwsSimAttempt pero desacoplado del enum AWS.
export interface TechSimAttempt {
  simId: string;
  trackId: 'programmer' | 'architecture' | 'devops' | 'databases' | 'systemdesign' | 'ai-programming';
  order: number;
  bestScore01: number;
  attempts: number;
  passed: boolean;
  firstPassedAt?: string;
  lastAttemptAt: string;
  // Estadísticas por área temática (fundamentals, data-structures, ...)
  perAreaStats?: Record<string, { correct: number; total: number }>;
}

// Progreso por nivel (los 250 niveles CEFR). Un registro por pack completado.
export interface LevelProgress {
  packId: string; // ej. "a2-01-greetings-introductions"
  band: 'A2' | 'A2+' | 'B1' | 'B1+' | 'B2' | 'B2+' | 'C1';
  levelOrder: number;
  bestScore01: number; // mejor puntaje 0-1
  attempts: number;
  passed: boolean; // superó passThreshold (default 0.8)
  firstPassedAt?: string; // ISO
  lastAttemptAt: string; // ISO
}

class LinguaDB extends Dexie {
  packs!: Table<StoredPack, string>;
  srs!: Table<SrsState, string>;
  errors!: Table<ErrorEntry, string>;
  profile!: Table<Profile, 'me'>;
  conversations!: Table<Conversation, string>;
  levelProgress!: Table<LevelProgress, string>;
  awsAttempts!: Table<AwsSimAttempt, string>;
  chats!: Table<Chat, string>;
  chatMessages!: Table<ChatMessage, string>;
  techAttempts!: Table<TechSimAttempt, string>;

  constructor() {
    super('linguadev');
    this.version(1).stores({
      packs: 'id, level, enabled',
      srs: 'cardId, due, state',
      errors: 'id, ts, skill',
      profile: 'id',
    });
    // v2: añade la tabla `conversations` para persistir llamadas con la IA.
    this.version(2).stores({
      packs: 'id, level, enabled',
      srs: 'cardId, due, state',
      errors: 'id, ts, skill',
      profile: 'id',
      conversations: 'id, createdAt, level',
    });
    // v3: añade tabla `levelProgress` para tracking de los 250 niveles CEFR.
    this.version(3).stores({
      packs: 'id, level, enabled',
      srs: 'cardId, due, state',
      errors: 'id, ts, skill',
      profile: 'id',
      conversations: 'id, createdAt, level',
      levelProgress: 'packId, band, [band+levelOrder], passed',
    });
    // v4: añade tabla `awsAttempts` para tracking de simulaciones AWS.
    this.version(4).stores({
      packs: 'id, level, enabled',
      srs: 'cardId, due, state',
      errors: 'id, ts, skill',
      profile: 'id',
      conversations: 'id, createdAt, level',
      levelProgress: 'packId, band, [band+levelOrder], passed',
      awsAttempts: 'simId, certId, [certId+order], passed',
    });
    // v5: chat de texto genérico (independiente de VoiceCall).
    this.version(5).stores({
      packs: 'id, level, enabled',
      srs: 'cardId, due, state',
      errors: 'id, ts, skill',
      profile: 'id',
      conversations: 'id, createdAt, level',
      levelProgress: 'packId, band, [band+levelOrder], passed',
      awsAttempts: 'simId, certId, [certId+order], passed',
      chats: 'id, updatedAt, preset',
      chatMessages: 'id, [chatId+createdAt], chatId, createdAt',
    });
    // v6: añade tabla `techAttempts` para tracks de programación/arquitectura.
    this.version(6).stores({
      packs: 'id, level, enabled',
      srs: 'cardId, due, state',
      errors: 'id, ts, skill',
      profile: 'id',
      conversations: 'id, createdAt, level',
      levelProgress: 'packId, band, [band+levelOrder], passed',
      awsAttempts: 'simId, certId, [certId+order], passed',
      chats: 'id, updatedAt, preset',
      chatMessages: 'id, [chatId+createdAt], chatId, createdAt',
      techAttempts: 'simId, trackId, [trackId+order], passed',
    });
  }
}

export const db = new LinguaDB();

db.on('blocked', () => console.warn('[dexie] db blocked'));
db.on('versionchange', () => db.close());

export async function ensureProfile(): Promise<Profile> {
  const cur = await db.profile.get('me');
  if (cur) return cur;
  const p: Profile = {
    id: 'me',
    level: 'A2',
    streak: 0,
    dailyGoalMinutes: 15,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
    version: 1,
    updatedAt: new Date().toISOString(),
  };
  await db.profile.put(p);
  return p;
}
