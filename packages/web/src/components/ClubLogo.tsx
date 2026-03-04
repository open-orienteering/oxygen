import { trpc } from "../lib/trpc";

const API_BASE = import.meta.env.VITE_API_URL ?? "";

/**
 * Displays a club's logo (if one exists) by looking up the local club ID
 * in the cached logoMap and rendering an <img> from the logo endpoint.
 *
 * Props:
 *   clubId     — local club ID (from oClub.Id)
 *   eventorId  — Eventor organisation ID (from oClub.ExtId). If provided, skips the map lookup.
 *   size       — "sm" (16px), "md" (24px), or "lg" (48px, uses LargeIcon)
 *   className  — extra CSS classes
 */
export function ClubLogo({
  clubId,
  eventorId,
  size = "sm",
  className = "",
  style = {},
}: {
  clubId?: number;
  eventorId?: number;
  size?: "sm" | "md" | "lg";
  className?: string;
  style?: React.CSSProperties;
}) {
  const logoMap = trpc.club.logoMap.useQuery(undefined, {
    staleTime: 5 * 60_000, // cache 5 min
  });

  const resolvedEventorId = eventorId ?? (clubId ? logoMap.data?.[clubId] : undefined);

  if (!resolvedEventorId) return null;

  const variant = size === "lg" ? "large" : "small";
  const px = size === "sm" ? 16 : size === "md" ? 24 : 48;

  return (
    <img
      src={`${API_BASE}/api/club-logo/${resolvedEventorId}?variant=${variant}`}
      alt=""
      width={px}
      height={px}
      className={`inline-block flex-shrink-0 ${className}`}
      style={style}
      loading="lazy"
      onError={(e) => {
        // Hide broken images gracefully
        (e.target as HTMLImageElement).style.display = "none";
      }}
    />
  );
}
