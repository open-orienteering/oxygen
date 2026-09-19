import { useEffect, useState } from "react";

const API_BASE = import.meta.env.VITE_API_URL ?? "";

export interface BuildInfo {
  startedAt: string;
  buildId?: string | null;
  deployRef?: string | null;
}

/** Runtime provenance for the image currently serving the API. */
export function useBuildInfo(): BuildInfo | null {
  const [info, setInfo] = useState<BuildInfo | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`${API_BASE}/api/version`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then((response) => response.ok ? response.json() as Promise<BuildInfo> : null)
      .then((data) => {
        if (data) setInfo(data);
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          console.warn("Could not load build provenance", error);
        }
      });

    return () => controller.abort();
  }, []);

  return info;
}
