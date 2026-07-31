// ChatSession: clase de dominio que agrupa toda la lógica de una conversación:
// crear, cargar, añadir turnos, persistir en Dexie, enviar al backend con streaming
// y auto-titulado. La UI la usa a través de un hook (useChatSession) y no toca Dexie directamente.

import { db, type Chat, type ChatMessage, type ChatPresetLocal } from '../../db/dexie.js';
import { streamChat, generateChatTitle, type ChatStreamHandle } from '../../lib/chatClient.js';
import type { ChatMessage as WireMessage } from '@linguadev/shared';

const MAX_CONTEXT_TURNS = 40; // pares de user+assistant que enviamos al backend

export interface ChatSessionSnapshot {
  chat: Chat;
  messages: ChatMessage[];
}

export interface StreamOptions {
  onToken: (chunk: string) => void;
  onDone: (assistant: ChatMessage) => void;
  onError: (err: Error) => void;
}

// Handle enriquecido que sobreescribe abort() con la variante "abortar + persistir el parcial".
// La UI solo tiene que llamar `handle.abort()`; la clase se encarga de la atomicidad.
export interface ChatStreamSessionHandle extends ChatStreamHandle {
  // Aborta el stream y persiste lo que se haya acumulado como mensaje del assistant.
  // Devuelve el mensaje persistido si hubo contenido, null si no había nada que guardar.
  stopAndPersist: () => Promise<ChatMessage | null>;
}

export class ChatSession {
  // Estado del stream en curso. Evita duplicar persistencia entre onDone del server
  // y stop() de la UI (race: si el server termina justo cuando el usuario aprieta Stop,
  // ambos caminos intentarían guardar el mismo buffer).
  private currentBuffer = '';
  private currentPersisted = false;

  constructor(public chat: Chat, public messages: ChatMessage[]) {}

  // ─── Factories ──────────────────────────────────────────────────────────

  static async create(opts: {
    preset?: ChatPresetLocal;
    systemOverride?: string;
    title?: string;
  }): Promise<ChatSession> {
    const now = new Date().toISOString();
    const chat: Chat = {
      id: crypto.randomUUID(),
      title: opts.title?.trim() || 'Nuevo chat',
      preset: opts.preset ?? 'general',
      systemOverride: opts.systemOverride,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
    };
    await db.chats.put(chat);
    return new ChatSession(chat, []);
  }

  static async load(chatId: string): Promise<ChatSession | null> {
    const chat = await db.chats.get(chatId);
    if (!chat) return null;
    // sortBy es más seguro que .between con caracteres mágicos; el volumen por chat
    // es pequeño (decenas de mensajes) así que el coste es despreciable.
    const messages = await db.chatMessages.where('chatId').equals(chatId).sortBy('createdAt');
    return new ChatSession(chat, messages);
  }

  static async list(limit = 50): Promise<Chat[]> {
    return db.chats.orderBy('updatedAt').reverse().limit(limit).toArray();
  }

  static async remove(chatId: string): Promise<void> {
    await db.transaction('rw', db.chats, db.chatMessages, async () => {
      await db.chats.delete(chatId);
      const ids = await db.chatMessages.where('chatId').equals(chatId).primaryKeys();
      if (ids.length) await db.chatMessages.bulkDelete(ids);
    });
  }

  // ─── Mutation ───────────────────────────────────────────────────────────
  //
  // Todas las mutaciones que persisten en Dexie usan patrón `chatExists → put/update`
  // para evitar resucitar un chat que el usuario borró en paralelo (race entre
  // autoTitle/stream tardío y el delete). Sin este guard, `db.chats.put()` haría
  // upsert y volvería a crear una fila fantasma.

  private async ensureChatExists(): Promise<boolean> {
    const row = await db.chats.get(this.chat.id);
    return !!row;
  }

  async addUserMessage(content: string): Promise<ChatMessage> {
    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      chatId: this.chat.id,
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
    };
    if (!(await this.ensureChatExists())) {
      // Chat borrado mientras el usuario escribía. No persistimos.
      throw new Error('CHAT_DELETED');
    }
    await db.chatMessages.put(msg);
    this.messages.push(msg);
    this.chat.messageCount = this.messages.length;
    this.chat.updatedAt = msg.createdAt;
    await db.chats.put(this.chat);
    return msg;
  }

  async addAssistantMessage(
    content: string,
    meta?: { inputTokens?: number | null; outputTokens?: number | null; costUsd?: number },
  ): Promise<ChatMessage | null> {
    if (!(await this.ensureChatExists())) return null;
    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      chatId: this.chat.id,
      role: 'assistant',
      content,
      createdAt: new Date().toISOString(),
      inputTokens: meta?.inputTokens ?? undefined,
      outputTokens: meta?.outputTokens ?? undefined,
      costUsd: meta?.costUsd,
    };
    await db.chatMessages.put(msg);
    this.messages.push(msg);
    this.chat.messageCount = this.messages.length;
    this.chat.updatedAt = msg.createdAt;
    this.chat.totalInputTokens = (this.chat.totalInputTokens ?? 0) + (meta?.inputTokens ?? 0);
    this.chat.totalOutputTokens = (this.chat.totalOutputTokens ?? 0) + (meta?.outputTokens ?? 0);
    this.chat.totalCostUsd = (this.chat.totalCostUsd ?? 0) + (meta?.costUsd ?? 0);
    await db.chats.put(this.chat);
    return msg;
  }

  async updateTitle(title: string): Promise<void> {
    this.chat.title = title.slice(0, 80);
    this.chat.updatedAt = new Date().toISOString();
    // .update() es no-op si la fila no existe, así evitamos resucitar chats borrados.
    await db.chats.update(this.chat.id, { title: this.chat.title, updatedAt: this.chat.updatedAt });
  }

  async setPreset(preset: ChatPresetLocal, systemOverride?: string): Promise<void> {
    this.chat.preset = preset;
    this.chat.systemOverride = systemOverride;
    this.chat.updatedAt = new Date().toISOString();
    await db.chats.update(this.chat.id, {
      preset: this.chat.preset,
      systemOverride: this.chat.systemOverride,
      updatedAt: this.chat.updatedAt,
    });
  }

  // ─── Context building ───────────────────────────────────────────────────

  // Convierte los mensajes locales al formato que espera el backend, truncando
  // por número de turnos para no reventar el límite de contexto ni el presupuesto.
  private contextForApi(): WireMessage[] {
    const trimmed = this.messages.slice(-MAX_CONTEXT_TURNS);
    return trimmed.map((m) => ({ role: m.role, content: m.content }));
  }

  // ─── Streaming ──────────────────────────────────────────────────────────

  // Envía el turno actual al backend y va acumulando la respuesta. Al terminar,
  // persiste el mensaje del assistant y dispara onDone con el mensaje ya guardado.
  send(opts: StreamOptions): ChatStreamSessionHandle {
    this.currentBuffer = '';
    this.currentPersisted = false;
    const handle = streamChat(
      {
        conversationId: this.chat.id,
        preset: this.chat.preset,
        systemOverride: this.chat.systemOverride,
        messages: this.contextForApi(),
      },
      {
        onToken: (chunk) => {
          this.currentBuffer += chunk;
          opts.onToken(chunk);
        },
        onDone: (meta) => {
          // Check-and-set atómico (JS single-threaded). Si stopAndPersist ya persistió,
          // no volvemos a guardar ni disparamos onDone en la UI (ya lo hizo el stop path).
          if (this.currentPersisted) return;
          this.currentPersisted = true;
          void this.addAssistantMessage(this.currentBuffer.trim() || '(respuesta vacía)', meta).then(
            (saved) => {
              if (!saved) return; // chat borrado en paralelo
              opts.onDone(saved);
              if (
                (this.chat.title === 'Nuevo chat' || this.chat.title === '') &&
                this.messages.length >= 2
              ) {
                void this.autoTitle();
              }
            },
          );
        },
        onError: opts.onError,
      },
    );

    const stopAndPersist = async (): Promise<ChatMessage | null> => {
      if (this.currentPersisted) return null;
      this.currentPersisted = true;
      handle.abort();
      const partial = this.currentBuffer.trim();
      if (!partial) return null;
      return await this.addAssistantMessage(partial);
    };

    return {
      abort: handle.abort,
      promise: handle.promise,
      stopAndPersist,
    };
  }

  private async autoTitle(): Promise<void> {
    try {
      const first = this.messages.slice(0, 4).map((m) => ({ role: m.role, content: m.content }));
      const title = await generateChatTitle(first);
      if (title) await this.updateTitle(title);
    } catch {
      // no bloquea al usuario
    }
  }
}
