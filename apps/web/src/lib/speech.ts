// Envolturas sobre la Web Speech API (TTS + reconocimiento) + Web Audio.
// Todo local. Degrada limpiamente cuando el navegador no soporta algo.

// ─── Text-to-speech ───

export function hasTts(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    const now = window.speechSynthesis.getVoices();
    if (now.length) return resolve(now);
    const handler = () => {
      window.speechSynthesis.removeEventListener('voiceschanged', handler);
      resolve(window.speechSynthesis.getVoices());
    };
    window.speechSynthesis.addEventListener('voiceschanged', handler);
    setTimeout(() => resolve(window.speechSynthesis.getVoices()), 800);
  });
}

export async function speak(text: string, opts: { rate?: number; lang?: string } = {}): Promise<void> {
  if (!hasTts()) throw new Error('TTS_UNAVAILABLE');
  const voices = await loadVoices();
  const targetLang = opts.lang ?? 'en-US';
  const voice =
    voices.find((v) => v.lang === targetLang) ??
    voices.find((v) => v.lang.startsWith('en')) ??
    voices[0];
  return new Promise((resolve, reject) => {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = opts.rate ?? 1;
    u.lang = targetLang;
    if (voice) u.voice = voice;
    u.onend = () => resolve();
    u.onerror = (e) => reject(new Error(`TTS_ERROR:${e.error}`));
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  });
}

export function stopSpeaking(): void {
  if (hasTts()) window.speechSynthesis.cancel();
}

// ─── SpeechRecognition ───

export function hasSpeechRecognition(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  return !!(w.SpeechRecognition || w.webkitSpeechRecognition);
}

// Errores conocidos del API SpeechRecognition traducidos a lenguaje humano.
export function humanizeSpeechError(code: string): string {
  switch (code) {
    case 'no-speech':
      return 'No detecté audio. Habla más cerca del micrófono e intenta de nuevo.';
    case 'audio-capture':
      return 'No pude acceder al micrófono. Revisa que esté conectado.';
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Permiso de micrófono denegado. Actívalo en la barra de dirección.';
    case 'network':
      return 'El reconocimiento requiere conexión a internet (usa el servicio de Google).';
    case 'aborted':
      return 'Grabación cancelada.';
    case 'language-not-supported':
      return 'El idioma no está soportado en este navegador.';
    default:
      return `Error de reconocimiento: ${code}`;
  }
}

export interface RecordHandle {
  stop: () => void;
}

export function recognizeOnce(opts: {
  lang?: string;
  onPartial?: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (err: Error) => void;
  onEnd?: () => void;
}): RecordHandle {
  if (typeof window === 'undefined') {
    opts.onError(new Error('no-speech'));
    return { stop: () => undefined };
  }
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionInstance;
    webkitSpeechRecognition?: new () => SpeechRecognitionInstance;
  };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  if (!Ctor) {
    opts.onError(new Error('service-not-allowed'));
    return { stop: () => undefined };
  }
  const r = new Ctor();
  r.lang = opts.lang ?? 'en-US';
  r.interimResults = true;
  r.continuous = false;
  // Solicita más alternativas → toma la mejor y las muestra para debug si hace falta.
  r.maxAlternatives = 3;

  let stopped = false;
  let lastPartial = '';
  let sawFinal = false;

  r.onresult = (e: SpeechRecognitionEventLike) => {
    let finalText = '';
    let interim = '';
    for (let i = 0; i < e.results.length; i++) {
      const res = e.results[i];
      if (!res) continue;
      const alt = res[0]?.transcript ?? '';
      if (res.isFinal) finalText += alt;
      else interim += alt;
    }
    if (interim && interim !== lastPartial) {
      lastPartial = interim;
      opts.onPartial?.(interim);
    }
    if (finalText) {
      sawFinal = true;
      opts.onFinal(finalText.trim());
    }
  };

  r.onerror = (e: { error: string }) => {
    if (stopped) return;
    opts.onError(new Error(e.error));
  };

  r.onend = () => {
    // Safety net: si termina sin haber disparado result (silencio total), reporta como no-speech.
    if (!sawFinal && !stopped && lastPartial) {
      // Al menos hubo texto interino: úsalo como resultado final.
      opts.onFinal(lastPartial.trim());
    }
    opts.onEnd?.();
  };

  try {
    r.start();
  } catch (err) {
    opts.onError(err as Error);
  }

  return {
    stop: () => {
      stopped = true;
      try {
        r.stop();
      } catch {
        // Si nunca arrancó, stop puede lanzar. Ignorar.
      }
    },
  };
}

interface SpeechRecognitionInstance {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}

interface SpeechRecognitionEventLike {
  results: {
    length: number;
    [i: number]:
      | undefined
      | ({
          isFinal: boolean;
          [j: number]: { transcript: string } | undefined;
        });
  };
}

// ─── Medidor de voz (Web Audio) ───
// IMPORTANTE: en muchos navegadores compite con SpeechRecognition por el micrófono. Por eso
// startMicMeter puede fallar o hacer que SR falle. Los consumidores deben empezar recognition
// PRIMERO y luego intentar el meter, tolerando error del meter sin romper la grabación.

export interface MicMeter {
  stop: () => void;
}

export async function startMicMeter(onLevel: (level0to1: number) => void): Promise<MicMeter> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
    throw new Error('MIC_UNAVAILABLE');
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const AudioCtor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtor) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('AUDIO_CONTEXT_UNAVAILABLE');
  }
  const ctx = new AudioCtor();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  let raf = 0;
  const tick = () => {
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = ((data[i] ?? 128) - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / data.length);
    onLevel(Math.min(1, rms * 3));
    raf = requestAnimationFrame(tick);
  };
  tick();
  return {
    stop: () => {
      cancelAnimationFrame(raf);
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    },
  };
}
