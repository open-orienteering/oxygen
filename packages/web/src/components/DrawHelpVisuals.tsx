import { useState, useRef, useEffect, type ReactNode } from "react";

const CLUB_COLORS = [
  { bg: "bg-blue-500", label: "Club A" },
  { bg: "bg-emerald-500", label: "Club B" },
  { bg: "bg-amber-500", label: "Club C" },
  { bg: "bg-rose-400", label: "Club D" },
];

function RunnerBox({ club, starred }: { club: number; starred?: boolean }) {
  const color = CLUB_COLORS[club % CLUB_COLORS.length];
  return (
    <span
      className={`inline-block w-4 h-4 rounded-sm ${color.bg} ${starred ? "ring-2 ring-offset-1 ring-yellow-400" : ""}`}
      title={color.label}
    />
  );
}

function BoxRow({ clubs, starred }: { clubs: number[]; starred?: Set<number> }) {
  return (
    <span className="inline-flex gap-0.5 items-center flex-wrap">
      {clubs.map((c, i) => (
        <RunnerBox key={i} club={c} starred={starred?.has(i)} />
      ))}
    </span>
  );
}

function Legend() {
  return (
    <span className="inline-flex gap-2 items-center text-[10px] text-slate-400 ml-2">
      {CLUB_COLORS.map((c, i) => (
        <span key={i} className="inline-flex items-center gap-0.5">
          <span className={`inline-block w-2.5 h-2.5 rounded-sm ${c.bg}`} />
          {c.label}
        </span>
      ))}
    </span>
  );
}

function MethodBlock({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-semibold text-slate-700">{title}</span>
        <span className="text-[11px] text-slate-500">{description}</span>
      </div>
      <div className="pl-1">{children}</div>
    </div>
  );
}

export function DrawMethodHelp() {
  const [open, setOpen] = useState(false);

  return (
    <div className="mb-2" data-testid="draw-method-help">
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-[11px] text-blue-600 hover:text-blue-800 cursor-pointer"
        data-testid="draw-method-help-toggle"
      >
        <InfoIcon size={13} />
        {open ? "Hide" : "How do these methods work?"}
      </button>

      {open && (
        <div className="mt-2 p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-3 text-xs">
          <div className="flex items-center gap-1 mb-1">
            <span className="text-[10px] text-slate-400 uppercase tracking-wide font-medium">
              Each color = one club
            </span>
            <Legend />
          </div>

          <MethodBlock title="Random" description="Completely random start order">
            <div className="flex items-center gap-1.5">
              <BoxRow clubs={[0, 0, 1, 2, 1, 0, 2, 2, 1]} />
              <span className="text-[10px] text-slate-400 ml-1">Same club may end up adjacent</span>
            </div>
          </MethodBlock>

          <MethodBlock title="Club separation" description="Runners from the same club are spread apart">
            <div className="flex items-center gap-1.5">
              <BoxRow clubs={[0, 1, 2, 0, 2, 1, 0, 1, 2]} />
              <span className="text-[10px] text-slate-400 ml-1">Same club never adjacent</span>
            </div>
          </MethodBlock>

          <MethodBlock title="Seeded" description="Top-ranked runners get later (better) start times">
            <div className="flex items-center gap-1.5">
              <BoxRow
                clubs={[1, 2, 0, 2, 1, 0, 1, 2]}
                starred={new Set([5, 6, 7])}
              />
              <span className="text-[10px] text-slate-400 ml-1">
                <span className="inline-block w-2.5 h-2.5 rounded-sm bg-slate-300 ring-1 ring-offset-0 ring-yellow-400 align-middle mr-0.5" />
                = seeded (start later)
              </span>
            </div>
          </MethodBlock>

          <MethodBlock title="Simultaneous" description="All runners start at the same time (mass start)">
            <div className="flex items-center gap-1.5">
              <span className="inline-flex flex-col items-center border-l-2 border-slate-400 pl-1.5">
                <BoxRow clubs={[0, 1, 2, 3, 0, 1]} />
              </span>
              <span className="text-[10px] text-slate-400 ml-1">Everyone at the same time</span>
            </div>
          </MethodBlock>
        </div>
      )}
    </div>
  );
}

function InfoIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="currentColor"
      className="shrink-0"
    >
      <path
        fillRule="evenodd"
        d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z"
        clipRule="evenodd"
      />
    </svg>
  );
}

const POPOVER_WIDTH = 384;

function Popover({ trigger, children }: { trigger: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  useEffect(() => {
    if (!open || !popRef.current || !ref.current) return;
    const panel = ref.current.closest("[class*='fixed']") as HTMLElement | null;
    if (!panel) return;
    const triggerRect = ref.current.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const spaceRight = panelRect.right - triggerRect.left;
    const spaceLeft = triggerRect.right - panelRect.left;

    const pop = popRef.current;
    pop.style.left = "";
    pop.style.right = "";
    if (spaceRight >= POPOVER_WIDTH) {
      pop.style.left = "0px";
    } else if (spaceLeft >= POPOVER_WIDTH) {
      pop.style.right = "0px";
    } else {
      const offset = triggerRect.left - panelRect.left;
      pop.style.left = `-${offset}px`;
      pop.style.width = `${panelRect.width - 24}px`;
    }
  }, [open]);

  return (
    <div className="relative inline-flex items-center" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-slate-400 hover:text-blue-600 cursor-pointer p-0.5"
        type="button"
      >
        {trigger}
      </button>
      {open && (
        <div
          ref={popRef}
          className="absolute top-full mt-1.5 z-50 p-3 bg-white border border-slate-200 rounded-lg shadow-lg text-xs text-slate-700 space-y-2"
          style={{ width: POPOVER_WIDTH }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export function CorridorTooltip() {
  return (
    <Popover trigger={<InfoIcon />}>
      <div data-testid="corridor-tooltip">
        <p className="font-semibold text-slate-800 mb-1.5">Start corridors</p>
        <p className="text-slate-600 mb-2">
          Classes are assigned to parallel start corridors. Within a corridor,
          classes start one after another. More corridors = shorter total start window.
        </p>
        <div className="space-y-1.5 font-mono text-[10px]">
          <div className="flex items-center gap-1">
            <span className="text-slate-400 w-5 shrink-0">C1</span>
            <span className="h-5 bg-blue-400 rounded-sm flex items-center justify-center text-white px-1.5 whitespace-nowrap" style={{ flex: 5 }}>
              H21
            </span>
            <span className="h-5 bg-blue-300 rounded-sm flex items-center justify-center text-white px-1.5 whitespace-nowrap" style={{ flex: 2 }}>
              D16
            </span>
            <span style={{ flex: 3 }} />
          </div>
          <div className="flex items-center gap-1">
            <span className="text-slate-400 w-5 shrink-0">C2</span>
            <span className="h-5 bg-emerald-400 rounded-sm flex items-center justify-center text-white px-1.5 whitespace-nowrap" style={{ flex: 3 }}>
              H16
            </span>
            <span className="h-5 bg-emerald-300 rounded-sm flex items-center justify-center text-white px-1.5 whitespace-nowrap" style={{ flex: 4 }}>
              D21
            </span>
            <span style={{ flex: 3 }} />
          </div>
          <div className="flex items-center gap-1 mt-1">
            <span className="w-5 shrink-0" />
            <span className="text-slate-400">
              ──── time ────→
            </span>
          </div>
        </div>
      </div>
    </Popover>
  );
}

export function OverlapTooltip() {
  return (
    <Popover trigger={<InfoIcon />}>
      <div data-testid="overlap-tooltip">
        <p className="font-semibold text-slate-800 mb-1.5">Course overlap detection</p>
        <p className="text-slate-600 mb-2">
          When enabled, classes whose courses share the same opening controls are
          placed in the same corridor so their runners start sequentially, never at
          the same time. This prevents runners from following each other through
          shared controls.
        </p>
        <div className="space-y-1 font-mono text-[10px]">
          <div className="flex items-center gap-1">
            <span className="text-slate-500 w-14 shrink-0">Course A:</span>
            <span className="text-slate-400">S →</span>
            <ControlBadge code="31" match />
            <span className="text-slate-400">→</span>
            <ControlBadge code="42" match />
            <span className="text-slate-400">→</span>
            <ControlBadge code="55" />
            <span className="text-slate-400">→ ...</span>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-slate-500 w-14 shrink-0">Course B:</span>
            <span className="text-slate-400">S →</span>
            <ControlBadge code="31" match />
            <span className="text-slate-400">→</span>
            <ControlBadge code="42" match />
            <span className="text-slate-400">→</span>
            <ControlBadge code="67" />
            <span className="text-slate-400">→ ...</span>
          </div>
          <div className="flex items-center gap-1 pt-1 text-slate-500">
            <span className="w-14 shrink-0" />
            <span className="inline-block w-2.5 h-2.5 rounded-sm bg-amber-400" />
            <span>= shared opening → same corridor (sequential)</span>
          </div>
        </div>
      </div>
    </Popover>
  );
}

function ControlBadge({ code, match }: { code: string; match?: boolean }) {
  return (
    <span
      className={`inline-flex items-center justify-center w-6 h-5 rounded text-[10px] font-bold ${
        match
          ? "bg-amber-100 text-amber-800 border border-amber-300"
          : "bg-slate-100 text-slate-600 border border-slate-200"
      }`}
    >
      {code}
    </span>
  );
}
