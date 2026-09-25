/** Consistent 20×20 stroke icons for map viewer / panel chrome. */

type IconProps = {
  className?: string;
  title?: string;
};

const base = {
  width: 20,
  height: 20,
  viewBox: "0 0 20 20",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true as const,
};

export function IconZoomIn({ className, title }: IconProps) {
  return (
    <svg {...base} className={className}>
      {title ? <title>{title}</title> : null}
      <circle cx="8.5" cy="8.5" r="5.25" />
      <path d="M12.5 12.5 17 17" />
      <path d="M8.5 6.25v4.5M6.25 8.5h4.5" />
    </svg>
  );
}

export function IconZoomOut({ className, title }: IconProps) {
  return (
    <svg {...base} className={className}>
      {title ? <title>{title}</title> : null}
      <circle cx="8.5" cy="8.5" r="5.25" />
      <path d="M12.5 12.5 17 17" />
      <path d="M6.25 8.5h4.5" />
    </svg>
  );
}

export function IconFitView({ className, title }: IconProps) {
  return (
    <svg {...base} className={className}>
      {title ? <title>{title}</title> : null}
      <path d="M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4" />
      <rect x="6.5" y="6.5" width="7" height="7" rx="1" />
    </svg>
  );
}

export function IconRuler({ className, title }: IconProps) {
  return (
    <svg {...base} className={className}>
      {title ? <title>{title}</title> : null}
      <path d="M3.5 14.5 14.5 3.5l2 2L5.5 16.5z" />
      <path d="M6 12l1.2-1.2M8 10l1.2-1.2M10 8l1.2-1.2M12 6l1.2-1.2" />
    </svg>
  );
}

export function IconLocate({ className, title }: IconProps) {
  return (
    <svg {...base} className={className}>
      {title ? <title>{title}</title> : null}
      <circle cx="10" cy="10" r="3" />
      <circle cx="10" cy="10" r="6.5" />
      <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2" />
    </svg>
  );
}

export function IconCompass({ className, title }: IconProps) {
  return (
    <svg {...base} className={className}>
      {title ? <title>{title}</title> : null}
      <circle cx="10" cy="10" r="7" />
      <path d="M10 4.5 12.2 12 10 10.5 7.8 12Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconFullscreenEnter({ className, title }: IconProps) {
  return (
    <svg {...base} className={className}>
      {title ? <title>{title}</title> : null}
      <path d="M3.5 7V3.5H7M13 3.5h3.5V7M16.5 13v3.5H13M7 16.5H3.5V13" />
    </svg>
  );
}

export function IconFullscreenExit({ className, title }: IconProps) {
  return (
    <svg {...base} className={className}>
      {title ? <title>{title}</title> : null}
      <path d="M7 3.5V7H3.5M16.5 7H13V3.5M13 16.5V13h3.5M3.5 13H7v3.5" />
    </svg>
  );
}

export function IconUndo({ className, title }: IconProps) {
  return (
    <svg {...base} className={className}>
      {title ? <title>{title}</title> : null}
      <path d="M7 7H3.5V3.5" />
      <path d="M3.5 7a6.5 6.5 0 1 1-1.2 5.2" />
    </svg>
  );
}

export function IconRedo({ className, title }: IconProps) {
  return (
    <svg {...base} className={className}>
      {title ? <title>{title}</title> : null}
      <path d="M13 7h3.5V3.5" />
      <path d="M16.5 7a6.5 6.5 0 1 0 1.2 5.2" />
    </svg>
  );
}

/** Eye with a slash — "hide other controls". */
export function IconEyeOff({ className, title }: IconProps) {
  return (
    <svg {...base} className={className}>
      {title ? <title>{title}</title> : null}
      <path d="M3 3l14 14" />
      <path d="M8.6 8.7a2 2 0 0 0 2.8 2.8" />
      <path d="M7.2 5.4A8.7 8.7 0 0 1 10 5c4 0 6.8 3.3 7.6 5-.4.8-1.1 1.9-2.2 2.9" />
      <path d="M4.6 6.9C3.4 8 2.7 9.2 2.4 10c.8 1.7 3.6 5 7.6 5 1.1 0 2.1-.2 3-.6" />
    </svg>
  );
}

/** Open eye — "show all controls". */
export function IconEye({ className, title }: IconProps) {
  return (
    <svg {...base} className={className}>
      {title ? <title>{title}</title> : null}
      <path d="M2.4 10c.8-1.7 3.6-5 7.6-5s6.8 3.3 7.6 5c-.8 1.7-3.6 5-7.6 5s-6.8-3.3-7.6-5Z" />
      <circle cx="10" cy="10" r="2.25" />
    </svg>
  );
}

/** Scissors — automatic circle slits / leg gaps. */
export function IconScissors({ className, title }: IconProps) {
  return (
    <svg {...base} className={className}>
      {title ? <title>{title}</title> : null}
      <circle cx="5.5" cy="5.5" r="2.25" />
      <circle cx="5.5" cy="14.5" r="2.25" />
      <path d="M7.3 6.9 17 15.5M7.3 13.1 17 4.5M10.5 10l1.2 1" />
    </svg>
  );
}

/** Control-description sheet — a small grid with a header row. */
export function IconDescriptions({ className, title }: IconProps) {
  return (
    <svg {...base} className={className}>
      {title ? <title>{title}</title> : null}
      <rect x="3" y="3.5" width="14" height="13" rx="1.5" />
      <path d="M3 7.5h14M3 11.5h14M7.5 7.5v9M12.5 7.5v9" />
    </svg>
  );
}

/** Check inside a circle — "show progress" (control completion). */
export function IconProgress({ className, title }: IconProps) {
  return (
    <svg {...base} className={className}>
      {title ? <title>{title}</title> : null}
      <circle cx="10" cy="10" r="7" />
      <path d="m6.75 10.25 2.25 2.25 4.25-4.75" />
    </svg>
  );
}
