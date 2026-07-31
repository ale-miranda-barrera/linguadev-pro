// Wrapper con errores tipados por dominio. Ayuda a decidir qué UI mostrar sin adivinar.

export type SafeError =
  | { kind: 'network'; message: string }
  | { kind: 'validation'; message: string; details?: unknown }
  | { kind: 'ai'; message: string; retryable: boolean }
  | { kind: 'quota'; message: string }
  | { kind: 'timeout'; message: string }
  | { kind: 'unknown'; message: string };

export type SafeResult<T> = { ok: true; value: T } | { ok: false; error: SafeError };

export async function safeAsync<T>(fn: () => Promise<T>, timeoutMs = 30_000): Promise<SafeResult<T>> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const value = await fn();
    return { ok: true, value };
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      return { ok: false, error: { kind: 'timeout', message: 'operación cancelada' } };
    }
    if (err instanceof DOMException && err.name === 'QuotaExceededError') {
      return { ok: false, error: { kind: 'quota', message: 'sin espacio local disponible' } };
    }
    if (err instanceof TypeError && /fetch/i.test(err.message)) {
      return { ok: false, error: { kind: 'network', message: 'sin conexión' } };
    }
    return { ok: false, error: { kind: 'unknown', message: (err as Error).message } };
  } finally {
    clearTimeout(t);
  }
}
