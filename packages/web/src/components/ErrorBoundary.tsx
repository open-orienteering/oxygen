import { Component } from "react";
import type { ReactNode, ErrorInfo } from "react";
import { useTranslation } from "react-i18next";
import { canReloadForChunk, isChunkLoadError, shouldResetBoundary } from "../lib/error-recovery";

/** page: light, in a page; dark: inside a dark surface; screen: a whole dark screen (kiosk, start screen); inline: a dialog. */
type Variant = "page" | "dark" | "screen" | "inline";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  /**
   * The boundary resets when this changes (WEB-15): the shell passes the
   * first route segment, so another tab renders again; the kiosk the card.
   */
  resetKey?: unknown;
  variant?: Variant;
  /** Try again by itself after this long (the unattended kiosk and start screen). */
  autoResetMs?: number;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  private autoReset: ReturnType<typeof setTimeout> | null = null;

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
    if (this.props.autoResetMs && !isChunkLoadError(error)) {
      if (this.autoReset) clearTimeout(this.autoReset);
      this.autoReset = setTimeout(() => {
        this.autoReset = null;
        this.setState({ hasError: false, error: null });
      }, this.props.autoResetMs);
    }
  }

  componentWillUnmount() {
    if (this.autoReset) clearTimeout(this.autoReset);
  }

  componentDidUpdate(prev: Props) {
    if (shouldResetBoundary(prev.resetKey, this.props.resetKey, this.state.hasError)) {
      this.setState({ hasError: false, error: null });
    }
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback !== undefined) return this.props.fallback;
      return (
        <ErrorFallback
          error={this.state.error}
          variant={this.props.variant ?? "page"}
          onRetry={() => this.setState({ hasError: false, error: null })}
        />
      );
    }
    return this.props.children;
  }
}

function sessionStore(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

function ErrorFallback({ error, variant, onRetry }: { error: Error | null; variant: Variant; onRetry: () => void }) {
  const { t } = useTranslation();
  const chunk = isChunkLoadError(error);
  const dark = variant === "dark" || variant === "screen";
  const box = {
    inline: "flex flex-col items-center justify-center p-4 text-center",
    dark: "flex flex-col items-center justify-center min-h-[200px] p-8 text-center text-slate-100",
    screen: "flex flex-col items-center justify-center min-h-screen bg-slate-900 p-8 text-center text-slate-100",
    page: "flex flex-col items-center justify-center min-h-[200px] p-8 text-center",
  }[variant];
  return (
    <div className={box} data-testid="error-boundary" data-chunk-error={chunk ? "1" : undefined}>
      <h2 className={`text-lg font-semibold mb-2 ${dark ? "text-red-300" : "text-red-700"}`}>
        {t("errorBoundaryTitle")}
      </h2>
      <p className={`text-sm mb-4 max-w-md break-words ${dark ? "text-slate-300" : "text-gray-600"}`}>
        {chunk ? t("errorBoundaryChunk") : error?.message}
      </p>
      <button
        data-testid="error-boundary-retry"
        onClick={() => {
          // A failed lazy import stays failed in place: only a reload fetches it.
          if (chunk) {
            if (canReloadForChunk(sessionStore())) window.location.reload();
            return;
          }
          onRetry();
        }}
        className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors cursor-pointer"
      >
        {chunk ? t("errorBoundaryReload") : t("errorBoundaryRetry")}
      </button>
    </div>
  );
}
