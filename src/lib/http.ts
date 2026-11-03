export class HttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** fetch + JSON with timeout and readable German error messages. */
export async function getJson<T>(url: string, timeoutMs = 15000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { signal: ctrl.signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new HttpError('Zeitüberschreitung beim Laden.');
    throw new HttpError(navigator.onLine ? 'Server nicht erreichbar.' : 'Keine Internetverbindung.');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body.detail || body.reason || '';
    } catch {
      /* ignore */
    }
    throw new HttpError(`Fehler ${res.status}${detail ? `: ${detail}` : ''}`, res.status);
  }
  return res.json() as Promise<T>;
}
