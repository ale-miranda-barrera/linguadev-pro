import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hasTts, hasSpeechRecognition, isSecureContextForMic, humanizeSpeechError, ttsStatus } from './speech.js';

// Estos tests validan la lógica pura de speech.ts que no requiere APIs de audio reales.
// Los métodos que dependen del browser (speak, recognizeOnce, startMicMeter) requieren
// mock del window.speechSynthesis y navigator.mediaDevices, que no cubrimos aquí.

describe('speech utilities', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('hasTts', () => {
    it('devuelve true cuando speechSynthesis existe', () => {
      expect(hasTts()).toBe('speechSynthesis' in window);
    });
  });

  describe('hasSpeechRecognition', () => {
    it('devuelve boolean', () => {
      expect(typeof hasSpeechRecognition()).toBe('boolean');
    });
  });

  describe('isSecureContextForMic', () => {
    it('respeta window.isSecureContext', () => {
      expect(isSecureContextForMic()).toBe(window.isSecureContext ?? false);
    });
  });

  describe('humanizeSpeechError', () => {
    it('traduce not-allowed', () => {
      expect(humanizeSpeechError('not-allowed')).toContain('micrófono');
    });

    it('traduce no-speech', () => {
      expect(humanizeSpeechError('no-speech')).toContain('audio');
    });

    it('traduce network', () => {
      expect(humanizeSpeechError('network')).toContain('internet');
    });

    it('devuelve el código raw para errores desconocidos', () => {
      const msg = humanizeSpeechError('unknown-error-code');
      expect(msg).toContain('unknown-error-code');
    });

    it('nunca devuelve undefined ni string vacío', () => {
      const codes = ['no-speech', 'audio-capture', 'not-allowed', 'network', 'aborted', 'foo-bar'];
      for (const c of codes) {
        const msg = humanizeSpeechError(c);
        expect(msg).toBeTruthy();
        expect(msg.length).toBeGreaterThan(5);
      }
    });
  });

  describe('ttsStatus', () => {
    it('reporta shape { supported, voicesLoaded, hint? }', () => {
      const s = ttsStatus();
      expect(typeof s.supported).toBe('boolean');
      expect(typeof s.voicesLoaded).toBe('number');
    });
  });
});
