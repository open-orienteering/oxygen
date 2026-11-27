/**
 * Reject when `promise` has not settled within `ms` (CRS-012 / WEB-20): a
 * logo that never loads or a USB transfer to a printer that stopped
 * answering must not hold the caller forever. The underlying work is not
 * cancelled; its late result is ignored.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** How long a logo may take to load before the receipt prints without it. */
export const LOGO_LOAD_TIMEOUT_MS = 10_000;
/** How long one USB transfer to the printer may take. */
export const PRINTER_SEND_TIMEOUT_MS = 30_000;
