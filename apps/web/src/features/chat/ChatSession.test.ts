import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Fake Dexie ─────────────────────────────────────────────────────────
// Simulamos las tablas que usa ChatSession con Maps en memoria. Solo implementamos
// los métodos que la clase realmente invoca. Es suficiente para probar la lógica
// del race y la protección contra chats borrados sin depender de fake-indexeddb.

interface FakeChat {
  id: string;
  title: string;
  preset: string;
  systemOverride?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCostUsd?: number;
}

interface FakeMessage {
  id: string;
  chatId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

const chats = new Map<string, FakeChat>();
const messages = new Map<string, FakeMessage>();

function makeChatTable() {
  return {
    get: async (id: string) => chats.get(id),
    put: async (row: FakeChat) => {
      chats.set(row.id, { ...row });
      return row.id;
    },
    update: async (id: string, patch: Partial<FakeChat>) => {
      const cur = chats.get(id);
      if (!cur) return 0;
      chats.set(id, { ...cur, ...patch });
      return 1;
    },
    delete: async (id: string) => {
      chats.delete(id);
    },
    orderBy: () => ({
      reverse: () => ({
        limit: () => ({
          toArray: async () => Array.from(chats.values()),
        }),
      }),
    }),
  };
}

function makeMessagesTable() {
  const table = {
    put: async (m: FakeMessage) => {
      messages.set(m.id, { ...m });
      return m.id;
    },
    where: (_field: string) => ({
      equals: (val: string) => ({
        sortBy: async (_key: string) =>
          Array.from(messages.values())
            .filter((m) => m.chatId === val)
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
        primaryKeys: async () =>
          Array.from(messages.values())
            .filter((m) => m.chatId === val)
            .map((m) => m.id),
      }),
    }),
    bulkDelete: async (ids: string[]) => {
      for (const id of ids) messages.delete(id);
    },
  };
  return table;
}

vi.mock('../../db/dexie.js', () => {
  const chatTable = makeChatTable();
  const msgTable = makeMessagesTable();
  return {
    db: {
      chats: chatTable,
      chatMessages: msgTable,
      transaction: async <T>(_mode: string, _t1: unknown, _t2: unknown, fn: () => Promise<T>) => fn(),
    },
  };
});

// ─── Fake streamChat ────────────────────────────────────────────────────
// Controlamos el timing del stream para reproducir el race: primer test corre
// stopAndPersist DURANTE el streaming; segundo test deja que termine natural.

type Callbacks = {
  onToken: (t: string) => void;
  onDone: (meta: { inputTokens: number | null; outputTokens: number | null; costUsd: number }) => void;
  onError: (e: Error) => void;
};

const streamCalls: Array<{ cb: Callbacks; resolveDone: () => void; aborted: boolean }> = [];

vi.mock('../../lib/chatClient.js', () => {
  return {
    streamChat: (_payload: unknown, cb: Callbacks) => {
      let aborted = false;
      let resolveDone = () => undefined as void;
      const promise = new Promise<void>((resolve) => {
        resolveDone = () => {
          if (aborted) return;
          cb.onDone({ inputTokens: 5, outputTokens: 2, costUsd: 0.0001 });
          resolve();
        };
      });
      const handle = {
        abort: () => {
          aborted = true;
        },
        promise,
      };
      streamCalls.push({
        cb,
        resolveDone,
        get aborted() {
          return aborted;
        },
      });
      // Emitimos tokens de forma síncrona para que el buffer esté lleno cuando el test lo lea.
      cb.onToken('Hola');
      cb.onToken(' ');
      cb.onToken('mundo');
      return handle;
    },
    generateChatTitle: async () => 'título auto',
    fetchAiStatus: async () => ({ configured: true, provider: 'openai', model: 'x' }),
  };
});

// Import after mocks so ChatSession sees them.
import { ChatSession } from './ChatSession.js';

describe('ChatSession — race stop/onDone', () => {
  beforeEach(() => {
    chats.clear();
    messages.clear();
    streamCalls.length = 0;
  });

  it('stopAndPersist antes de onDone: solo persiste 1 mensaje (no duplica)', async () => {
    const s = await ChatSession.create({ preset: 'general' });
    await s.addUserMessage('hola');

    const captured: string[] = [];
    let doneFired = 0;
    const handle = s.send({
      onToken: (t) => captured.push(t),
      onDone: () => {
        doneFired++;
      },
      onError: () => undefined,
    });

    // El usuario aprieta Stop mientras el stream está en marcha (buffer ya con "Hola mundo").
    const saved = await handle.stopAndPersist();
    expect(saved).not.toBeNull();
    expect(saved!.content).toBe('Hola mundo');

    // Ahora el server envía su done tardío — no debe volver a persistir ni disparar onDone en la UI.
    const call = streamCalls[0]!;
    // El handle interno ya marcó aborted=true.
    expect(call.aborted).toBe(true);
    // Simulamos manualmente que el done llega igual (edge del race).
    call.cb.onDone({ inputTokens: 5, outputTokens: 2, costUsd: 0.0001 });
    await new Promise((r) => setTimeout(r, 10));

    // Solo un mensaje assistant en storage.
    const assistantMsgs = Array.from(messages.values()).filter((m) => m.role === 'assistant');
    expect(assistantMsgs).toHaveLength(1);
    expect(assistantMsgs[0]!.content).toBe('Hola mundo');
    expect(doneFired).toBe(0); // el done tardío quedó bloqueado por currentPersisted
  });

  it('flujo normal: onDone persiste 1 mensaje y dispara callback UI', async () => {
    const s = await ChatSession.create({ preset: 'general' });
    await s.addUserMessage('hola');

    let onDoneCount = 0;
    s.send({
      onToken: () => undefined,
      onDone: () => {
        onDoneCount++;
      },
      onError: () => undefined,
    });

    // Disparamos el done del server "naturalmente".
    streamCalls[0]!.cb.onDone({ inputTokens: 4, outputTokens: 3, costUsd: 0.0002 });
    await new Promise((r) => setTimeout(r, 10));

    const assistantMsgs = Array.from(messages.values()).filter((m) => m.role === 'assistant');
    expect(assistantMsgs).toHaveLength(1);
    expect(onDoneCount).toBe(1);
    // El chat.messageCount debe reflejar user + assistant.
    const chat = Array.from(chats.values())[0]!;
    expect(chat.messageCount).toBe(2);
    expect(chat.totalOutputTokens).toBe(3);
  });
});

describe('ChatSession — guardas contra chat borrado', () => {
  beforeEach(() => {
    chats.clear();
    messages.clear();
    streamCalls.length = 0;
  });

  it('addAssistantMessage no crea fila si el chat fue borrado', async () => {
    const s = await ChatSession.create({ preset: 'general' });
    await s.addUserMessage('hola');
    // Borramos por fuera (simulando otra pestaña / delete UI).
    chats.delete(s.chat.id);
    const before = messages.size;
    const saved = await s.addAssistantMessage('respuesta');
    expect(saved).toBeNull();
    expect(messages.size).toBe(before);
  });

  it('addUserMessage lanza CHAT_DELETED si el chat no existe', async () => {
    const s = await ChatSession.create({ preset: 'general' });
    chats.delete(s.chat.id);
    await expect(s.addUserMessage('x')).rejects.toThrow('CHAT_DELETED');
  });

  it('updateTitle no resucita un chat borrado (usa .update, no .put)', async () => {
    const s = await ChatSession.create({ preset: 'general' });
    chats.delete(s.chat.id);
    await s.updateTitle('nuevo título');
    expect(chats.has(s.chat.id)).toBe(false);
  });

  it('setPreset tampoco resucita un chat borrado', async () => {
    const s = await ChatSession.create({ preset: 'general' });
    chats.delete(s.chat.id);
    await s.setPreset('english-tutor');
    expect(chats.has(s.chat.id)).toBe(false);
  });
});
