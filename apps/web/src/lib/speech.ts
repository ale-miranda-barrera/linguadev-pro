// Envolturas sobre la Web Speech API (TTS + reconocimiento) + Web Audio.
// Todo local. Degrada limpiamente cuando el navegador no soporta algo.

// ─── Text-to-speech ───

export function hasTts(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

// Cache de voces. speechSynthesis.getVoices() a veces devuelve [] al arranque hasta que
// el evento voiceschanged dispara. Pre-cargamos aquí y mantenemos la lista actualizada.
let cachedVoices: SpeechSynthesisVoice[] = [];
let voicesReady = false;

function primeVoices() {
  if (!hasTts()) return;
  const now = window.speechSynthesis.getVoices();
  if (now.length) {
    cachedVoices = now;
    voicesReady = true;
    return;
  }
  const handler = () => {
    cachedVoices = window.speechSynthesis.getVoices();
    voicesReady = cachedVoices.length > 0;
  };
  window.speechSynthesis.addEventListener('voiceschanged', handler);
  // Fallback: intentar de nuevo en 500ms por si voiceschanged nunca dispara (Safari a veces).
  setTimeout(() => {
    if (!voicesReady) {
      cachedVoices = window.speechSynthesis.getVoices();
      voicesReady = cachedVoices.length > 0;
    }
  }, 500);
}
if (typeof window !== 'undefined' && hasTts()) primeVoices();

function pickVoice(targetLang: string): SpeechSynthesisVoice | undefined {
  const voices = cachedVoices.length > 0 ? cachedVoices : (hasTts() ? window.speechSynthesis.getVoices() : []);
  if (voices.length && !voicesReady) {
    cachedVoices = voices;
    voicesReady = true;
  }
  return (
    voices.find((v) => v.lang === targetLang) ??
    voices.find((v) => v.lang.replace('_', '-').toLowerCase() === targetLang.toLowerCase()) ??
    voices.find((v) => v.lang.toLowerCase().startsWith(targetLang.slice(0, 2).toLowerCase())) ??
    voices.find((v) => v.default) ??
    voices[0]
  );
}

// speak SÍNCRONO: crea la utterance y llama speechSynthesis.speak() en el mismo tick del user gesture.
// Esto es CRÍTICO en iOS Safari, que bloquea el TTS si se llama tras un await/setTimeout.
// Devuelve una Promise que resuelve al terminar de hablar, pero speak() ya arrancó sync.
export function speak(text: string, opts: { rate?: number; lang?: string } = {}): Promise<void> {
  if (!hasTts()) return Promise.reject(new Error('TTS_UNAVAILABLE'));
  const targetLang = opts.lang ?? 'en-US';
  const synth = window.speechSynthesis;
  // Algunas veces Chrome deja el synth 'pausado' tras cancel() previo. Resume por si acaso.
  try {
    if (synth.paused) synth.resume();
  } catch {
    // ignore
  }
  const u = new SpeechSynthesisUtterance(text);
  u.rate = opts.rate ?? 1;
  u.lang = targetLang;
  const voice = pickVoice(targetLang);
  if (voice) u.voice = voice;
  const promise = new Promise<void>((resolve, reject) => {
    u.onend = () => resolve();
    u.onerror = (e) => {
      // 'canceled' / 'interrupted' no son fallos reales — pasa cuando se llama cancel().
      const err = (e as SpeechSynthesisErrorEvent).error;
      if (err === 'canceled' || err === 'interrupted') return resolve();
      // eslint-disable-next-line no-console
      console.warn('[speak] TTS error:', err);
      reject(new Error(`TTS_ERROR:${err}`));
    };
  });
  try {
    synth.cancel();
    synth.speak(u);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[speak] synth.speak threw:', err);
    return Promise.reject(err as Error);
  }
  // Chrome bug: si el tab está inactivo un rato, speechSynthesis se congela tras ~15s.
  // Workaround: pause/resume periódico. Solo activar mientras estamos speaking.
  keepAliveWhileSpeaking();
  return promise;
}

let keepAliveTimer: number | null = null;
function keepAliveWhileSpeaking() {
  if (!hasTts()) return;
  if (keepAliveTimer !== null) return;
  const synth = window.speechSynthesis;
  keepAliveTimer = window.setInterval(() => {
    if (!synth.speaking) {
      if (keepAliveTimer !== null) {
        window.clearInterval(keepAliveTimer);
        keepAliveTimer = null;
      }
      return;
    }
    // Truco conocido: pause+resume mantiene el thread vivo en Chrome/Edge.
    try {
      synth.pause();
      synth.resume();
    } catch {
      // ignore
    }
  }, 10000);
}

export function stopSpeaking(): void {
  if (hasTts()) window.speechSynthesis.cancel();
  if (keepAliveTimer !== null) {
    window.clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

// Diagnóstico útil para el usuario cuando el TTS no funciona.
export function ttsStatus(): { supported: boolean; voicesLoaded: number; hint?: string } {
  if (!hasTts()) return { supported: false, voicesLoaded: 0, hint: 'Tu navegador no soporta síntesis de voz.' };
  const voices = window.speechSynthesis.getVoices();
  if (voices.length === 0) {
    return {
      supported: true,
      voicesLoaded: 0,
      hint: 'Sistema aún cargando voces. Toca de nuevo en 1s.',
    };
  }
  const en = voices.filter((v) => v.lang.toLowerCase().startsWith('en')).length;
  if (en === 0) {
    return {
      supported: true,
      voicesLoaded: voices.length,
      hint: 'No hay voces en inglés instaladas. Se usará la voz por defecto.',
    };
  }
  return { supported: true, voicesLoaded: voices.length };
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

// Pide permiso de micrófono explícitamente. Devuelve true si granted, false si denegado.
// Cierra el stream inmediatamente para no interferir con SpeechRecognition (que gestiona su propio mic interno).
export async function ensureMicPermission(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices) return false;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Cerrar inmediatamente — solo queríamos el permission prompt.
    stream.getTracks().forEach((t) => t.stop());
    return true;
  } catch {
    return false;
  }
}

export function isSecureContextForMic(): boolean {
  if (typeof window === 'undefined') return false;
  // getUserMedia y SpeechRecognition requieren secure context (HTTPS o localhost/127.0.0.1).
  return window.isSecureContext ?? false;
}

export function recognizeOnce(opts: {
  lang?: string;
  onStart?: () => void;
  onSpeechStart?: () => void;
  onPartial?: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (err: Error) => void;
  onEnd?: () => void;
}): RecordHandle {
  if (typeof window === 'undefined') {
    opts.onError(new Error('no-speech'));
    return { stop: () => undefined };
  }
  if (!isSecureContextForMic()) {
    opts.onError(new Error('insecure-context'));
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
  r.maxAlternatives = 3;

  let stopped = false;
  let lastPartial = '';
  let sawFinal = false;

  r.onstart = () => {
    opts.onStart?.();
  };

  r.onaudiostart = () => {
    // El micrófono empezó a capturar audio (permiso concedido y stream activo).
    opts.onStart?.();
  };

  r.onspeechstart = () => {
    // Se detectó habla — punto donde el usuario sabe que 'ya está grabando de verdad'.
    opts.onSpeechStart?.();
  };

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
    // eslint-disable-next-line no-console
    console.warn('[recognizeOnce] SR error:', e.error);
    opts.onError(new Error(e.error));
  };

  r.onend = () => {
    if (!sawFinal && !stopped && lastPartial) {
      opts.onFinal(lastPartial.trim());
    }
    opts.onEnd?.();
  };

  try {
    r.start();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[recognizeOnce] start threw:', err);
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
  onstart?: (() => void) | null;
  onaudiostart?: (() => void) | null;
  onspeechstart?: (() => void) | null;
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
