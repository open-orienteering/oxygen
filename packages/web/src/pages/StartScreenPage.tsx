/**
 * Start Screen — Call-Up Time Display ("Gå fram"-skärm)
 *
 * Fullscreen display for the start area. Shows which runners should
 * prepare to advance at the NEXT whole minute.
 *
 * Timing logic:
 *   advanceClock         = wallClock + offsetMinutes
 *   advanceFloorMinute   = floor(advanceClock) to minute boundary
 *   nextAdvanceMinute    = advanceFloorMinute + 1 minute
 *   runnersShown         = those with startTime in nextAdvanceMinute
 *
 * Example with 3 min offset:
 *   Wall clock 08:04:30 → advance clock 08:07:30 → runners starting at 08:08
 *   Wall clock 08:05:00 → advance clock 08:08:00 → runners starting at 08:09
 */

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useParams } from "react-router-dom";
import { trpc } from "../lib/trpc";
import { ClubLogo } from "../components/ClubLogo";

// ─── Types ──────────────────────────────────────────────────

interface StartRunner {
    id: number;
    name: string;
    clubId: number;
    clubName: string;
    clubExtId: number;
    classId: number;
    className: string;
    startTime: number;
    startNo: number;
    status: number;
}

interface MinuteGroup {
    minuteKey: number;
    label: string;
    runners: StartRunner[];
}

// ─── Helpers ────────────────────────────────────────────────

function wallClockToMeos(date: Date): number {
    return (date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds()) * 10;
}

function formatMinute(ds: number): string {
    const totalSec = Math.floor(ds / 10);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}

function formatClock(ds: number): string {
    const totalSec = Math.floor(ds / 10);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function floorToMinute(ds: number): number {
    return Math.floor(ds / 600) * 600;
}

// ─── Class badge colors ─────────────────────────────────────

const CLASS_COLORS = [
    { bg: "rgba(59,130,246,0.18)", text: "#60a5fa", border: "rgba(59,130,246,0.35)" },
    { bg: "rgba(168,85,247,0.18)", text: "#c084fc", border: "rgba(168,85,247,0.35)" },
    { bg: "rgba(236,72,153,0.18)", text: "#f472b6", border: "rgba(236,72,153,0.35)" },
    { bg: "rgba(34,197,94,0.18)", text: "#4ade80", border: "rgba(34,197,94,0.35)" },
    { bg: "rgba(245,158,11,0.18)", text: "#fbbf24", border: "rgba(245,158,11,0.35)" },
    { bg: "rgba(6,182,212,0.18)", text: "#22d3ee", border: "rgba(6,182,212,0.35)" },
    { bg: "rgba(244,63,94,0.18)", text: "#fb7185", border: "rgba(244,63,94,0.35)" },
    { bg: "rgba(99,102,241,0.18)", text: "#818cf8", border: "rgba(99,102,241,0.35)" },
];

function getClassColor(classId: number) {
    return CLASS_COLORS[classId % CLASS_COLORS.length];
}

// ─── Main Component ─────────────────────────────────────────

export function StartScreenPage() {
    const { nameId } = useParams<{ nameId: string }>();
    const [offsetMinutes, setOffsetMinutes] = useState(3);
    const [showSettings, setShowSettings] = useState(false);
    const [now, setNow] = useState(() => new Date());
    const [transitioning, setTransitioning] = useState(false);
    const [windowSize, setWindowSize] = useState({ width: window.innerWidth, height: window.innerHeight });
    const prevMinuteRef = useRef<number>(-1);

    // Track window size
    useEffect(() => {
        const handleResize = () => setWindowSize({ width: window.innerWidth, height: window.innerHeight });
        window.addEventListener("resize", handleResize);
        return () => window.removeEventListener("resize", handleResize);
    }, []);

    // Select competition
    const selectMutation = trpc.competition.select.useMutation();
    useEffect(() => {
        if (nameId) selectMutation.mutate({ nameId });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [nameId]);

    // Fetch runner data (poll every 5s)
    const { data } = trpc.runner.startScreen.useQuery(undefined, {
        enabled: selectMutation.isSuccess,
        refetchInterval: 5000,
    });

    // Tick clock every second
    useEffect(() => {
        const id = setInterval(() => setNow(new Date()), 1000);
        return () => clearInterval(id);
    }, []);

    // ── Timing ─────────────────────────────────────────────────
    const meosNow = wallClockToMeos(now);
    // The advance clock = wall clock + offset
    const advanceClock = meosNow + offsetMinutes * 600;
    const advanceFloorMinute = floorToMinute(advanceClock);
    // Runners shown = those starting at the NEXT whole minute of the advance clock
    const startMinuteShown = advanceFloorMinute + 600;
    const nextStartMinute = startMinuteShown + 600;

    // Seconds within the current advance-minute (for progress bar + beep zone)
    const advanceSecondsInMinute = Math.floor((advanceClock - advanceFloorMinute) / 10);
    const progressPct = (advanceSecondsInMinute / 60) * 100;
    const isBeepZone = advanceSecondsInMinute >= 55; // last 5 seconds

    // Group runners by minute
    const groups: MinuteGroup[] = useMemo(() => {
        if (!data?.runners) return [];
        const map = new Map<number, StartRunner[]>();
        for (const r of data.runners) {
            const key = floorToMinute(r.startTime);
            const arr = map.get(key);
            if (arr) arr.push(r);
            else map.set(key, [r]);
        }
        return Array.from(map.entries())
            .sort((a, b) => a[0] - b[0])
            .map(([key, runners]) => ({ minuteKey: key, label: formatMinute(key), runners }));
    }, [data?.runners]);

    const currentGroup = groups.find((g) => g.minuteKey === startMinuteShown) ?? null;
    const nextGroup = groups.find((g) => g.minuteKey === nextStartMinute) ?? null;

    // ── Truly Dynamic UNIT-BASED scaling logic ─────────────────
    // We treat the entire screen height as a budget of "proportional units" (U).
    // Let's define the height of each part in terms of a base font unit (F).

    // Non-runner parts budgets:
    const U_HEADER = 0.8;         // Top bar (Competition name, wall clock, etc)
    const U_CLOCK = 2.0;          // The big countdown clock font area + padding
    const U_PROGRESS = 0.5;       // Progress bar area + margins
    const U_SUBHEADING = 1.4;     // "Start 12:59 · 3 runners" heading area + padding
    const U_FOOTER_LABEL = 0.9;   // "Coming up" label area
    const U_FOOTER_RUNNERS = 1.7; // Upcoming runner names area + margin
    const U_SAFETY = 0.5;         // Aggressive breathing room budget

    const runnerCount = currentGroup?.runners.length || 1;
    // One tile = 1.0 (text) + 0.8 (padding 0.4+0.4) + 0.5 (gap/buffer) = 2.3 units
    const U_PER_RUNNER = 2.3;

    // Total Units sum - exactly matches the component stack
    const totalUnits = U_HEADER + U_CLOCK + U_PROGRESS + U_SUBHEADING +
        (U_PER_RUNNER * runnerCount) +
        U_FOOTER_LABEL + U_FOOTER_RUNNERS + U_SAFETY;

    // Calculate the base font unit (F)
    const CLOCK_FONT_RATIO = 1.4;
    const MIN_CLOCK_FONT = 100; // Ensure timer stays readable at high densities

    const rawF = windowSize.height / totalUnits;
    let finalF = rawF;
    let finalClockFontSize = rawF * CLOCK_FONT_RATIO;

    if (finalClockFontSize < MIN_CLOCK_FONT) {
        finalClockFontSize = MIN_CLOCK_FONT;
        // Recalculate F for the rest of the items by subtracting the fixed clock box height
        const fixedClockBoxHeight = (MIN_CLOCK_FONT / CLOCK_FONT_RATIO) * U_CLOCK;
        finalF = Math.max(windowSize.height - fixedClockBoxHeight, 0) / (totalUnits - U_CLOCK);
    }

    const widthConstrainedF = windowSize.width * 0.075;
    const tileFontSize = Math.max(Math.min(finalF, widthConstrainedF, 180), 18);
    const clockFontSize = finalClockFontSize;

    // Derived scaling for all other elements based on the unit (F)
    const labelFontSize = tileFontSize * 0.35;
    const subHeadingFontSize = tileFontSize * 0.45;
    const upcomingRunnerFontSize = tileFontSize * 0.55;

    // Scale padding and gap proportionally
    const tilePadding = `${tileFontSize * 0.4}px ${tileFontSize * 0.6}px`;
    const tileGap = tileFontSize * 0.35;

    // Animate on minute transition
    useEffect(() => {
        if (prevMinuteRef.current === -1) { prevMinuteRef.current = advanceFloorMinute; return; }
        if (advanceFloorMinute !== prevMinuteRef.current) {
            setTransitioning(true);
            const timer = setTimeout(() => { setTransitioning(false); prevMinuteRef.current = advanceFloorMinute; }, 500);
            return () => clearTimeout(timer);
        }
    }, [advanceFloorMinute]);

    // Fullscreen
    const containerRef = useRef<HTMLDivElement>(null);
    const toggleFullscreen = useCallback(() => {
        if (document.fullscreenElement) document.exitFullscreen();
        else containerRef.current?.requestFullscreen();
    }, []);

    return (
        <div
            ref={containerRef}
            style={{
                height: "100vh", overflow: "hidden",
                background: "linear-gradient(160deg, #0c0a1d 0%, #1a1145 40%, #0f172a 100%)",
                color: "white", fontFamily: "'Inter', system-ui, sans-serif",
                display: "flex", flexDirection: "column", userSelect: "none",
                position: "relative",
            }}
        >
            {/* Ambient glows */}
            <div style={{ position: "absolute", top: "-15%", left: "25%", width: "50%", height: "35%", background: "radial-gradient(circle, rgba(99,102,241,0.12) 0%, transparent 70%)", pointerEvents: "none" }} />
            <div style={{ position: "absolute", bottom: "0", right: "15%", width: "35%", height: "25%", background: "radial-gradient(circle, rgba(168,85,247,0.08) 0%, transparent 70%)", pointerEvents: "none" }} />

            {/* ── Top bar ──────────────────────────────────────── */}
            <header style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: `${tileFontSize * 0.1}px 28px`, position: "relative", zIndex: 10, flexShrink: 0,
                height: tileFontSize * 0.5,
            }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#4ade80", boxShadow: "0 0 6px rgba(74,222,128,0.5)", animation: "ss-pulse 2s infinite" }} />
                    <span style={{ fontSize: labelFontSize * 0.8, color: "rgba(255,255,255,0.45)", fontWeight: 500 }}>
                        {data?.competitionName || nameId}
                    </span>
                </div>

                <div style={{
                    position: "absolute", left: "50%", transform: "translateX(-50%)",
                    fontSize: labelFontSize, color: "rgba(255,255,255,0.35)",
                    textTransform: "uppercase", letterSpacing: 5, fontWeight: 700,
                }}>
                    Call-up
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <span style={{ fontSize: 13, color: "rgba(255,255,255,0.3)", fontFamily: "monospace" }}>
                        {formatClock(meosNow)}
                    </span>
                    <button onClick={() => setShowSettings(!showSettings)} style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 6, padding: "4px 10px", color: "rgba(255,255,255,0.5)", cursor: "pointer", fontSize: 12 }}>
                        ⚙ {offsetMinutes}m
                    </button>
                    <button onClick={toggleFullscreen} style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 6, padding: "4px 10px", color: "rgba(255,255,255,0.5)", cursor: "pointer", fontSize: 12 }}>
                        ⛶
                    </button>
                </div>
            </header>

            {/* Settings panel */}
            {showSettings && (
                <div style={{
                    position: "absolute", top: 44, right: 28, zIndex: 50,
                    background: "rgba(30,27,75,0.95)", backdropFilter: "blur(20px)",
                    border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12,
                    padding: 20, minWidth: 220, boxShadow: "0 20px 40px rgba(0,0,0,0.5)",
                }}>
                    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12, color: "rgba(255,255,255,0.8)" }}>
                        Call-up offset
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                        {[1, 2, 3, 4, 5].map((m) => (
                            <button key={m} onClick={() => setOffsetMinutes(m)} style={{
                                flex: 1, padding: "6px 0", borderRadius: 6, fontSize: 13, fontWeight: 600,
                                cursor: "pointer", border: "none",
                                background: offsetMinutes === m ? "rgba(99,102,241,0.5)" : "rgba(255,255,255,0.06)",
                                color: offsetMinutes === m ? "white" : "rgba(255,255,255,0.4)",
                            }}>
                                {m}m
                            </button>
                        ))}
                    </div>
                    <div style={{ marginTop: 10, fontSize: 11, color: "rgba(255,255,255,0.3)" }}>
                        Start time = call-up + {offsetMinutes} min
                    </div>
                </div>
            )}

            {/* ── Call-up clock section (Proportional) ── */}
            <div style={{ flexShrink: 0, textAlign: "center", position: "relative", zIndex: 10 }}>
                <div
                    data-testid="advance-clock"
                    style={{
                        fontSize: clockFontSize, fontWeight: 200,
                        fontFamily: "'Inter', monospace", letterSpacing: -1, lineHeight: 1,
                        color: isBeepZone ? "#f59e0b" : "white",
                        textShadow: isBeepZone
                            ? `0 0 ${clockFontSize * 0.3}px rgba(245,158,11,0.5), 0 0 ${clockFontSize * 0.6}px rgba(245,158,11,0.2)`
                            : `0 0 ${clockFontSize * 0.4}px rgba(99,102,241,0.2)`,
                        animation: isBeepZone ? "ss-beep-pulse 0.5s ease-in-out infinite" : "none",
                        transition: "color 0.3s, text-shadow 0.3s",
                    }}
                >
                    {formatClock(advanceClock)}
                </div>

                {/* Progress bar */}
                <div style={{ width: "min(600px, 60%)", height: Math.max(tileFontSize * 0.08, 3), borderRadius: 2, background: "rgba(255,255,255,0.06)", margin: `${tileFontSize * 0.1}px auto 0`, overflow: "hidden" }}>
                    <div style={{
                        height: "100%", borderRadius: 1, width: `${progressPct}%`, transition: "width 1s linear",
                        background: isBeepZone
                            ? "linear-gradient(90deg, #f59e0b, #ef4444)"
                            : "linear-gradient(90deg, #6366f1, #a855f7)",
                    }} />
                </div>
            </div>

            {/* ── Main content (Fluid space-filler) ── */}
            <main style={{
                flex: "1 1 auto", minHeight: 0,
                display: "flex", flexDirection: "column",
                alignItems: "center", justifyContent: "center",
                padding: `${tileFontSize * 0.15}px 0`, position: "relative", zIndex: 5,
            }}>
                <div
                    style={{
                        width: "96%",
                        display: "flex", flexDirection: "column", justifyContent: "center",
                        transition: "opacity 0.4s ease, transform 0.4s ease",
                        opacity: transitioning ? 0 : 1,
                        transform: transitioning ? "translateY(-20px)" : "translateY(0)",
                    }}
                >
                    {currentGroup && currentGroup.runners.length > 0 ? (
                        <>
                            <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: tileGap }}>
                                <div style={{ flex: 1, height: 1, background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.18), transparent)" }} />
                                <div style={{ fontSize: subHeadingFontSize, fontWeight: 700, color: "rgba(255,255,255,0.6)", letterSpacing: 1.5 }}>
                                    Start {formatMinute(startMinuteShown)}
                                </div>
                                <div style={{ background: "rgba(99,102,241,0.22)", borderRadius: 20, padding: `${tileGap * 0.25}px ${tileGap * 0.8}px`, fontSize: subHeadingFontSize * 0.85, color: "#a5b4fc", fontWeight: 700 }}>
                                    {currentGroup.runners.length} {currentGroup.runners.length === 1 ? "runner" : "runners"}
                                </div>
                                <div style={{ flex: 1, height: 1, background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.18), transparent)" }} />
                            </div>

                            {/* Runner tiles — calculated to fill available space */}
                            <div style={{ display: "flex", flexDirection: "column", gap: tileGap, overflow: "hidden", flexShrink: 1 }}>
                                {currentGroup.runners.map((runner, i) => {
                                    const color = getClassColor(runner.classId);
                                    return (
                                        <div
                                            key={runner.id}
                                            style={{
                                                display: "flex", alignItems: "center", gap: 18,
                                                padding: tilePadding, borderRadius: 12,
                                                background: "rgba(255,255,255,0.035)",
                                                border: "1px solid rgba(255,255,255,0.05)",
                                                animation: `ss-slide-in 0.45s ease-out ${i * 0.06}s both`,
                                            }}
                                        >
                                            {/* Name area */}
                                            <div style={{
                                                flex: "1 1 auto", minWidth: 0,
                                                fontSize: tileFontSize, fontWeight: 700,
                                                color: "rgba(255,255,255,0.98)", lineHeight: 1.1,
                                                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                                                letterSpacing: "-0.02em",
                                            }}>
                                                {runner.name}
                                            </div>

                                            {/* Club logo + name area — grows with screen width */}
                                            <div style={{
                                                display: "flex", alignItems: "center", gap: 12,
                                                flex: "0 1 auto", minWidth: "20%", justifyContent: "flex-end",
                                                marginLeft: "auto",
                                            }}>
                                                <ClubLogo clubId={runner.clubId} eventorId={runner.clubExtId || undefined} size="lg" style={{ height: tileFontSize * 0.85, width: "auto" }} />
                                                {runner.clubName && (
                                                    <span style={{
                                                        fontSize: Math.max(tileFontSize * 0.3, 14), color: "rgba(255,255,255,0.45)",
                                                        maxWidth: "min(500px, 50vw)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                                                        fontWeight: 500,
                                                    }}>
                                                        {runner.clubName}
                                                    </span>
                                                )}
                                            </div>

                                            {/* Class badge */}
                                            <div style={{
                                                padding: `${tileFontSize * 0.1}px ${tileFontSize * 0.25}px`, borderRadius: 10,
                                                fontSize: Math.max(tileFontSize * 0.25, 12), fontWeight: 700,
                                                background: color.bg, color: color.text, border: `1px solid ${color.border}`,
                                                flexShrink: 0,
                                            }}>
                                                {runner.className}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </>
                    ) : (
                        <div style={{ textAlign: "center", padding: "32px 0" }}>
                            <div style={{ fontSize: 40, marginBottom: 12, opacity: 0.25 }}>⏳</div>
                            <div style={{ fontSize: 18, color: "rgba(255,255,255,0.35)", fontWeight: 500 }}>
                                No runners starting at {formatMinute(startMinuteShown)}
                            </div>
                            {nextGroup && (
                                <div style={{ fontSize: 14, color: "rgba(255,255,255,0.2)", marginTop: 8 }}>
                                    Next: {formatMinute(nextStartMinute)} ({nextGroup.runners.length} runners)
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </main>

            {/* ── Bottom: upcoming runners (Proportional) ─ */}
            <div
                data-testid="upcoming-section"
                style={{
                    flexShrink: 0, borderTop: "1px solid rgba(255,255,255,0.06)",
                    background: "rgba(0,0,0,0.18)", padding: `${tileFontSize * 0.3}px 28px`,
                    position: "relative", zIndex: 10,
                }}
            >
                {nextGroup && nextGroup.runners.length > 0 ? (
                    <>
                        <div style={{ fontSize: labelFontSize, color: "rgba(255,255,255,0.45)", textTransform: "uppercase", letterSpacing: 3, marginBottom: labelFontSize * 0.8, fontWeight: 600 }}>
                            Coming up · Start {formatMinute(nextStartMinute)} · {nextGroup.runners.length} runners
                        </div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                            {nextGroup.runners.map((r) => (
                                <div
                                    key={r.id}
                                    style={{
                                        display: "flex", alignItems: "center", gap: 8,
                                        background: "rgba(255,255,255,0.05)", borderRadius: 10,
                                        padding: "8px 16px", border: "1px solid rgba(255,255,255,0.05)",
                                    }}
                                >
                                    <ClubLogo clubId={r.clubId} eventorId={r.clubExtId || undefined} size="sm" style={{ height: upcomingRunnerFontSize * 0.9, width: "auto" }} />
                                    <span style={{ fontSize: upcomingRunnerFontSize, color: "rgba(255,255,255,0.8)", fontWeight: 600 }}>
                                        {r.name}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </>
                ) : (
                    <div style={{ fontSize: 13, color: "rgba(255,255,255,0.2)", textAlign: "center", padding: "4px 0" }}>
                        No more upcoming starts
                    </div>
                )}
            </div>

            {/* CSS */}
            <style>{`
        @keyframes ss-slide-in { from { opacity: 0; transform: translateX(30px); } to { opacity: 1; transform: translateX(0); } }
        @keyframes ss-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
        @keyframes ss-beep-pulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.7; transform: scale(1.02); } }
      `}</style>
        </div>
    );
}
