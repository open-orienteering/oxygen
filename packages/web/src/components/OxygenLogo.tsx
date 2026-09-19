import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { nextNeedleAngle } from "../lib/compass-heading";
import { useCompassHeading } from "../hooks/useCompassHeading";

/**
 * The Oxygen mark: orienteering flag (white / IOF orange split on the
 * diagonal) with a compass-rose "O" cut out of the orange. This is the same
 * artwork as `public/favicon.svg` — keep the two in sync (the favicon is the
 * source for the PNG app icons, see `scripts/generate-app-icons.mjs`).
 *
 * It is inlined here rather than referenced as an `<img>` so the needle can
 * be rotated to a live compass heading.
 */
type OxygenLogoProps = {
  /** Compass heading in degrees clockwise from north; `null` keeps north up. */
  heading?: number | null;
  className?: string;
  title?: string;
};

export function OxygenLogo({ heading = null, className, title }: OxygenLogoProps) {
  // Gradient ids must be unique per instance or two logos on one page
  // would share (and clobber) each other's defs.
  const uid = useId();
  const squircleId = `oxygen-squircle-${uid}`;
  const orangeId = `oxygen-orange-${uid}`;
  const blueId = `oxygen-blue-${uid}`;

  // Continuous angle so the CSS transition never spins the long way round.
  // Derived from the `heading` prop during render (the React-recommended
  // way to adjust state when a prop changes) rather than in an effect.
  const [needle, setNeedle] = useState<{ heading: number | null; angle: number }>({
    heading: null,
    angle: 0,
  });
  if (heading != null && heading !== needle.heading) {
    setNeedle({ heading, angle: nextNeedleAngle(needle.angle, heading) });
  }
  const needleAngle = needle.angle;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 120 120"
      className={className}
      role="img"
      aria-label={title}
      data-testid="oxygen-logo"
    >
      {title ? <title>{title}</title> : null}
      <defs>
        <clipPath id={squircleId}>
          <rect width="120" height="120" rx="28" />
        </clipPath>
        <linearGradient id={orangeId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#FF7A00" />
          <stop offset="100%" stopColor="#D94000" />
        </linearGradient>
        <linearGradient id={blueId} x1="0%" y1="100%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#06B6D4" />
          <stop offset="100%" stopColor="#3B82F6" />
        </linearGradient>
      </defs>
      <g clipPath={`url(#${squircleId})`}>
        <rect width="120" height="120" fill="#F8FAFC" />
        <path d="M0,120 L120,0 L120,120 Z" fill={`url(#${orangeId})`} />

        {/* White halo cut from the orange */}
        <circle cx="60" cy="60" r="34" fill="#F8FAFC" />

        {/* Compass rose: the ring is the O, four cardinal points at two-thirds size */}
        <g fill={`url(#${blueId})`}>
          <path d="M60,28 L64,40 L56,40 Z" />
          <path d="M60,92 L64,80 L56,80 Z" />
          <path d="M28,60 L40,56 L40,64 Z" />
          <path d="M92,60 L80,56 L80,64 Z" />
        </g>
        <circle cx="60" cy="60" r="20" fill="none" stroke={`url(#${blueId})`} strokeWidth="8" />

        {/* Needle: orange north, grey south. Rotated to the live heading when we have one. */}
        <g
          data-testid="oxygen-logo-needle"
          data-angle={needleAngle}
          className="transition-transform duration-300 ease-out origin-[60px_60px]"
          // Dynamic rotation angle — cannot be expressed as a static Tailwind class.
          style={{ transform: `rotate(${needleAngle}deg)` }}
        >
          <path d="M60,44 L65,60 L55,60 Z" fill={`url(#${orangeId})`} />
          <path d="M60,76 L65,60 L55,60 Z" fill="#94A3B8" />
        </g>
      </g>
    </svg>
  );
}

/**
 * The logo wired to the device compass. On iOS the sensor needs a
 * user-gesture permission prompt, so the logo becomes a button until the
 * user taps it; everywhere else it starts listening immediately and the
 * needle just stays north-up when no sensor reports in (desktop).
 */
export function LiveCompassLogo({ className }: { className?: string }) {
  const { t } = useTranslation("event");
  const { heading, permission, requestPermission } = useCompassHeading();

  const logo = (
    <OxygenLogo
      heading={heading}
      className={className}
      title={heading == null ? t("logoAlt") : t("compassHeading", { heading })}
    />
  );

  if (permission === "prompt") {
    return (
      <button
        type="button"
        onClick={() => void requestPermission()}
        aria-label={t("compassEnable")}
        title={t("compassEnable")}
        data-testid="oxygen-logo-enable-compass"
        className="inline-flex rounded-2xl focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      >
        {logo}
      </button>
    );
  }

  return (
    <div className="inline-flex" data-testid="oxygen-logo-live" data-heading={heading ?? ""}>
      {logo}
    </div>
  );
}
