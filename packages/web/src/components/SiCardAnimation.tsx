/**
 * Animated SVG of an SI card sliding into a SPORTident station.
 * Uses the pure-vector si-read.svg loaded from /public.
 *
 * The SVG contains a `#Botal` group (animated card) and a
 * `#serial-number` text element whose content is set dynamically.
 */
import { useEffect, useRef, useState } from "react";

function getTimeSerial(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}${mm}${ss}`;
}

const ANIM_CSS = `
#Botal {
  animation: si-slide 6s linear infinite;
  transform-origin: 50% 50%;
  transform-box: fill-box;
}
@keyframes si-slide {
  0%   { transform: translate(0px, -330px); opacity: 1; }
  50%  { transform: translate(0px, 60px);  opacity: 1; }
  67%  { transform: translate(0px, 60px);  opacity: 1; }
  78%  { transform: translate(0px, 60px);  opacity: 0; }
  80%  { transform: translate(0px, -330px); opacity: 0; }
  83%  { transform: translate(0px, -330px); opacity: 1; }
  100% { transform: translate(0px, -330px); opacity: 1; }
}
`;

const INSERTED_CSS = `
#Botal {
  transform: translate(0px, 60px);
  transform-origin: 50% 50%;
  transform-box: fill-box;
}
`;

let rawSvgCache: string | null = null;

function processSvg(raw: string): string {
  let svg = raw.replace(/<\?xml[^?]*\?>\s*/i, "");
  svg = svg.replace(/<style[\s\S]*?<\/style>/i, "");
  // Extend the outer clip path upward so the card is visible when starting high.
  // Original top edge: "L59.5,12.2h320" → add a rect bump: up 600, across, back down.
  svg = svg.replace(
    "L59.5,12.2h320",
    "L59.5,12.2v-600h320v600",
  );
  return svg;
}

function stampSerial(svg: string, serial: string): string {
  return svg.replace(
    /(<text\s+id=["']serial-number["'][^>]*>)[^<]*(<\/text>)/,
    `$1${serial}$2`,
  );
}

export function SiCardAnimation({
  size = 360,
  cardNumber,
  inserted,
}: {
  size?: number;
  cardNumber?: number;
  /** When true, card is static in the inserted position (no animation). */
  inserted?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [baseSvg, setBaseSvg] = useState<string>(rawSvgCache ?? "");

  useEffect(() => {
    if (rawSvgCache) return;
    fetch("/si-read.svg")
      .then((r) => r.text())
      .then((raw) => {
        rawSvgCache = processSvg(raw);
        setBaseSvg(rawSvgCache);
      })
      .catch(() => {});
  }, []);

  const hasCard = cardNumber != null && cardNumber > 0;
  const serialText = hasCard ? String(cardNumber) : getTimeSerial();
  const svgHtml = baseSvg ? stampSerial(baseSvg, serialText) : "";

  useEffect(() => {
    if (hasCard || !baseSvg) return;
    const el = containerRef.current;
    if (!el) return;
    const iv = setInterval(() => {
      const node = el.querySelector("#serial-number");
      if (node) node.textContent = getTimeSerial();
    }, 1000);
    return () => clearInterval(iv);
  }, [hasCard, baseSvg]);

  return (
    <div className="inline-block" style={{ width: size, height: size }}>
      <style>{inserted ? INSERTED_CSS : ANIM_CSS}</style>
      <div
        ref={containerRef}
        className="w-full h-full [&>svg]:w-full [&>svg]:h-full [&>svg]:overflow-visible"
        dangerouslySetInnerHTML={{ __html: svgHtml }}
      />
    </div>
  );
}
