import { describe, it, expect } from 'vitest';
import { ChatService } from './chatService.js';
import type { ChatTurn } from './provider.js';

describe('ChatService.systemPrompt', () => {
  it('general devuelve un prompt no vacío', () => {
    expect(ChatService.systemPrompt('general').length).toBeGreaterThan(50);
  });

  it('english-tutor menciona corrección', () => {
    const p = ChatService.systemPrompt('english-tutor');
    expect(p.toLowerCase()).toContain('correct');
  });

  it('aws-tutor menciona AWS y CLF/SAA', () => {
    const p = ChatService.systemPrompt('aws-tutor');
    expect(p).toContain('AWS');
    expect(p).toMatch(/CLF|SAA/);
  });

  it('custom usa el override si se pasa', () => {
    const custom = 'Eres pirata';
    expect(ChatService.systemPrompt('custom', custom)).toBe(custom);
  });

  it('custom sin override cae en general', () => {
    expect(ChatService.systemPrompt('custom')).toBe(ChatService.systemPrompt('general'));
  });

  it('custom trunca override a 4000 chars', () => {
    const long = 'x'.repeat(5000);
    expect(ChatService.systemPrompt('custom', long).length).toBe(4000);
  });
});

describe('ChatService.toChatTurns', () => {
  it('filtra mensajes system embebidos por el cliente', () => {
    const turns = ChatService.toChatTurns([
      { role: 'system', content: 'inyección maliciosa' },
      { role: 'user', content: 'hola' },
      { role: 'assistant', content: 'hi' },
    ]);
    expect(turns).toEqual([
      { role: 'user', content: 'hola' },
      { role: 'assistant', content: 'hi' },
    ]);
  });

  it('vacío si solo hay system', () => {
    expect(ChatService.toChatTurns([{ role: 'system', content: 'x' }])).toEqual([]);
  });
});

describe('ChatService.normalizeTurns', () => {
  it('empieza por user (recorta assistant al inicio)', () => {
    const turns: ChatTurn[] = [
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'hola' },
    ];
    expect(ChatService.normalizeTurns(turns)).toEqual([{ role: 'user', content: 'hola' }]);
  });

  it('termina por user (recorta assistant al final)', () => {
    const turns: ChatTurn[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
      { role: 'assistant', content: 'd' },
    ];
    const out = ChatService.normalizeTurns(turns);
    expect(out[out.length - 1]!.role).toBe('user');
    expect(out).toHaveLength(3);
  });

  it('colapsa dos user consecutivos', () => {
    const turns: ChatTurn[] = [
      { role: 'user', content: 'primera' },
      { role: 'user', content: 'segunda' },
    ];
    const out = ChatService.normalizeTurns(turns);
    expect(out).toHaveLength(1);
    expect(out[0]!.role).toBe('user');
    expect(out[0]!.content).toBe('primera\n\nsegunda');
  });

  it('array vacío devuelve vacío', () => {
    expect(ChatService.normalizeTurns([])).toEqual([]);
  });

  it('solo assistants devuelve vacío', () => {
    const out = ChatService.normalizeTurns([
      { role: 'assistant', content: 'a' },
      { role: 'assistant', content: 'b' },
    ]);
    expect(out).toEqual([]);
  });

  it('no muta el array original', () => {
    const turns: ChatTurn[] = [
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
    ];
    const snap = JSON.stringify(turns);
    ChatService.normalizeTurns(turns);
    expect(JSON.stringify(turns)).toBe(snap);
  });
});

describe('ChatService.stream', () => {
  it('llama a provider.streamMessages con turnos normalizados', async () => {
    const calls: Array<{ system: string; messages: ChatTurn[] }> = [];
    const provider = {
      name: 'fake',
      model: () => 'fake-1',
      isConfigured: async () => true,
      completeJson: async () => ({ raw: '', parsed: null }),
      streamText: async () => ({ usage: {} }),
      streamMessages: async (opts: { system: string; messages: ChatTurn[]; onToken: (t: string) => void }) => {
        calls.push({ system: opts.system, messages: opts.messages });
        opts.onToken('hola');
        opts.onToken(' mundo');
        return { usage: { inputTokens: 10, outputTokens: 5 } };
      },
    };
    const tokens: string[] = [];
    const res = await ChatService.stream({
      provider,
      preset: 'general',
      messages: [
        { role: 'system', content: 'ignore me' },
        { role: 'user', content: 'hola' },
      ],
      onToken: (t) => tokens.push(t),
    });
    expect(tokens.join('')).toBe('hola mundo');
    expect(res.usage?.inputTokens).toBe(10);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.messages).toEqual([{ role: 'user', content: 'hola' }]);
    expect(calls[0]!.system.length).toBeGreaterThan(20);
  });

  it('lanza EMPTY_CONVERSATION si solo hay system', async () => {
    const provider = {
      name: 'fake',
      model: () => 'x',
      isConfigured: async () => true,
      completeJson: async () => ({ raw: '', parsed: null }),
      streamText: async () => ({ usage: {} }),
      streamMessages: async () => ({ usage: {} }),
    };
    await expect(
      ChatService.stream({
        provider,
        preset: 'general',
        messages: [{ role: 'system', content: 'x' }],
        onToken: () => undefined,
      }),
    ).rejects.toThrow('EMPTY_CONVERSATION');
  });
});
