/**
 * tRPC always JSON.parse()s the response. Proxies (IAP login, nginx 413/50x,
 * a stale service-worker navigation fallback) often return HTML instead,
 * which surfaces as the cryptic
 * `Unexpected token '<', "<html><hea"... is not valid JSON`.
 */

export function htmlApiErrorMessage(
  status: number,
  contentType: string,
  preview: string,
): string | null {
  const trimmed = preview.trimStart();
  const looksHtml =
    contentType.includes("text/html") ||
    trimmed.startsWith("<!DOCTYPE") ||
    trimmed.startsWith("<!doctype") ||
    trimmed.startsWith("<html");
  if (!looksHtml) return null;
  if (status === 413) {
    return "Upload is too large for the server.";
  }
  if (status === 502 || status === 504) {
    return "The server timed out or crashed while handling the upload.";
  }
  return "Server returned a web page instead of an API response. The sign-in session may have expired — reload the page.";
}

export function isHtmlResponseError(err: unknown): boolean {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : String((err as { message?: unknown } | null)?.message ?? "");
  return /unexpected token ['"]?</i.test(message) && /is not valid json/i.test(message);
}

export async function rejectHtmlApiResponse(response: Response): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json") || contentType.includes("trpc")) {
    return response;
  }
  const preview = await response.clone().text();
  const message = htmlApiErrorMessage(response.status, contentType, preview);
  if (message) {
    throw new TypeError(message);
  }
  return response;
}
