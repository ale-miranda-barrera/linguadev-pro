import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SpeakButton } from './SpeakButton.js';

// Mock del módulo speech — evitamos tocar Web Speech API real en tests.
vi.mock('../lib/speech.js', () => ({
  hasTts: () => true,
  speak: vi.fn(),
  ttsStatus: () => ({ supported: true, voicesLoaded: 3 }),
}));

import { speak } from '../lib/speech.js';

describe('SpeakButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renderiza el label por defecto', () => {
    render(<SpeakButton text="hello" />);
    expect(screen.getByRole('button', { name: /pronunciar hello/i })).toBeInTheDocument();
    expect(screen.getByText(/escuchar/i)).toBeInTheDocument();
  });

  it('renderiza el label custom', () => {
    render(<SpeakButton text="hello" label="Play" />);
    expect(screen.getByText(/play/i)).toBeInTheDocument();
  });

  it('al hacer click llama a speak con el texto', async () => {
    (speak as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    render(<SpeakButton text="hola mundo" lang="es-ES" rate={0.8} />);
    const btn = screen.getByRole('button');
    fireEvent.click(btn);
    expect(speak).toHaveBeenCalledWith('hola mundo', { lang: 'es-ES', rate: 0.8 });
  });

  it('cambia a estado "Hablando" mientras habla', async () => {
    // speak devuelve una promise que no resuelve inmediatamente
    let resolveFn: () => void = () => {};
    (speak as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise<void>((resolve) => {
        resolveFn = resolve;
      }),
    );
    render(<SpeakButton text="hola" />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByText(/hablando/i)).toBeInTheDocument());
    resolveFn();
  });

  it('vuelve a idle tras terminar de hablar', async () => {
    (speak as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    render(<SpeakButton text="hola" />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByText(/escuchar/i)).toBeInTheDocument());
  });

  it('muestra "Reintenta" y hint tras error', async () => {
    (speak as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('TTS_ERROR:foo'));
    render(<SpeakButton text="hola" />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByText(/reintenta/i)).toBeInTheDocument());
  });
});
