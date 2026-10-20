/**
 * Club symbol decisions as an OpenOrienteering Mapper cross-reference
 * table (CRT) and back (06 §5.1, §5.3; 03 §3.2). Pure; the API reads the
 * rows and records what `resolveCrt` returns through `decide`.
 * Normative: docs/map-symbols.md §8.6.
 *
 * Mapper's grammar (`SymbolRuleSet::loadCrt`): per line the first
 * whitespace-delimited token is the *target* symbol number, the rest of
 * the line, trimmed, the *source*; a line whose first token starts with
 * `#` is a comment, and there are no trailing comments.
 */

import type { DocumentColour, DocumentSymbol, SymbolMatch } from "../map-document/header.js";
import { getLibraryEntry, SYMBOL_LIBRARY_VERSION } from "../symbol-library/index.js";
import { documentLibraryId, documentSymbolFingerprints, parseDecisionFingerprint } from "./decisions.js";
import { normaliseCode, type SymbolDecision } from "./matcher.js";
import type { ImportWarning } from "./report.js";

export type CrtWarningCode =
  | "CRT_LINE_INVALID"
  | "CRT_QUERY_UNSUPPORTED"
  | "CRT_SOURCE_UNKNOWN"
  | "CRT_SOURCE_NOT_REVIEWABLE"
  | "CRT_TARGET_UNKNOWN"
  | "CRT_FINGERPRINT_MISMATCH"
  | "CRT_LIBRARY_MISMATCH";

/** A line that does not apply, with the offending text. */
export interface CrtSkip {
  line: number;
  code: CrtWarningCode;
  message: string;
}

export type CrtStatement =
  | { kind: "rule"; line: number; target: string; source: string; fingerprint?: string }
  | { kind: "keep"; line: number; source: string; fingerprint?: string };

export interface CrtFile {
  /** From `# oxygen-crt k=v …`; informative. */
  header: { library?: string; source?: string; document?: string };
  statements: CrtStatement[];
  problems: CrtSkip[];
}

/** A source that is not a symbol number: a Mapper object query (`natural = wood`, `"x"`, `(…)`). */
const QUERY = /[\s="()]/;

/** Skip messages carry the offending text, bounded so a large bad file does not echo itself back. */
const MESSAGE_CHARS = 120;
const clip = (s: string) => (s.length > MESSAGE_CHARS ? `${s.slice(0, MESSAGE_CHARS)}…` : s);

export function parseCrt(text: string): CrtFile {
  const file: CrtFile = { header: {}, statements: [], problems: [] };
  let fingerprint: string | undefined;
  const statement = (s: CrtStatement) => {
    file.statements.push(fingerprint ? { ...s, fingerprint } : s);
    fingerprint = undefined;
  };
  text.replace(/^﻿/, "").split(/\r\n|\r|\n/).forEach((raw, i) => {
    const line = i + 1;
    const s = raw.trim();
    if (!s) return;
    if (s.startsWith("#")) {
      const [word, ...rest] = s.slice(1).trim().split(/\s+/);
      if (word === "oxygen-crt") {
        for (const kv of rest) {
          const m = /^(library|source|document)=(\S+)$/.exec(kv);
          if (m && file.header[m[1] as keyof CrtFile["header"]] === undefined) file.header[m[1] as keyof CrtFile["header"]] = m[2];
        }
      } else if (word === "fp") {
        // A malformed `# fp` unbinds rather than leaving an earlier one in force.
        fingerprint = rest[0] && parseDecisionFingerprint(rest[0]) ? rest[0] : undefined;
      } else if (word === "keep") {
        if (rest.length === 1 && rest[0]) statement({ kind: "keep", line, source: rest[0] });
        else {
          file.problems.push({ line, code: "CRT_LINE_INVALID", message: clip(s) });
          fingerprint = undefined;
        }
      }
      return;
    }
    const m = /^(\S+)\s*(.*)$/.exec(s)!;
    const [target, source] = [m[1], m[2].trim()];
    if (!source) file.problems.push({ line, code: "CRT_LINE_INVALID", message: clip(s) });
    else if (QUERY.test(source)) file.problems.push({ line, code: "CRT_QUERY_UNSUPPORTED", message: clip(source) });
    else return statement({ kind: "rule", line, target, source });
    fingerprint = undefined;
  });
  return file;
}

// ---- the document side --------------------------------------------------------

/** What the codec needs of a stored header (or an encoder input). */
export interface CrtDocumentLike {
  source: { kind: string };
  colours: readonly Pick<DocumentColour, "name" | "cmyk">[];
  mapScale: number;
  library?: { id: string } | null;
  symbols: readonly {
    code: string;
    name: string;
    origin?: DocumentSymbol["origin"];
    render: unknown;
    match?: Pick<SymbolMatch, "method" | "state" | "canonicalId">;
  }[];
}

/** The match the document draws without a decision: `auto`, not `explicit`. */
const automatic = (m: Pick<SymbolMatch, "method" | "state" | "canonicalId"> | undefined): string | null =>
  m && m.state === "auto" && m.method !== "explicit" && m.canonicalId ? m.canonicalId : null;

// ---- export -------------------------------------------------------------------

export interface CrtExport {
  text: string;
  /** Rule lines, `# keep` lines, and the rule lines that are automatic matches. */
  rules: number;
  kept: number;
  auto: number;
}

const TARGET_WIDTH = 10; // Mapper's writeCrt pads the target to ten columns.

/**
 * The document's club decisions as a CRT (docs/map-symbols.md §8.6):
 * `decisions` are the club's, as stage 6 reads them; only those of the
 * document's library and for its fingerprints are written.
 * `includeMatches` adds the document's automatic matches.
 */
export function formatCrt(header: CrtDocumentLike, opts: { decisions: readonly SymbolDecision[]; documentHash: string; includeMatches?: boolean }): CrtExport {
  const libraryId = documentLibraryId(header);
  const prefix = `${libraryId}:`;
  const byFingerprint = new Map<string, SymbolDecision>();
  for (const d of opts.decisions) {
    if (d.libraryId !== undefined && d.libraryId !== libraryId) continue;
    if (d.irHash) byFingerprint.set(`${normaliseCode(d.code)}:${d.irHash}`, d);
  }
  const lines = [
    `# oxygen-crt library=${libraryId}@${SYMBOL_LIBRARY_VERSION} source=${header.source.kind} document=${opts.documentHash}`,
    "# OpenOrienteering Mapper cross-reference table: <target> <source> per rule. Exported by Oxygen; '# fp' carries the club symbol fingerprint, '# keep' keeps the source drawing.",
  ];
  const out = { rules: 0, kept: 0, auto: 0 };
  const rule = (canonicalId: string, code: string) => {
    const target = canonicalId.startsWith(prefix) ? canonicalId.slice(prefix.length) : canonicalId;
    lines.push(`${target}${" ".repeat(Math.max(1, TARGET_WIDTH - target.length))}${code}`);
    out.rules++;
  };
  documentSymbolFingerprints(header).forEach((fp, i) => {
    if (!fp) return;
    const s = header.symbols[i];
    const parsed = parseDecisionFingerprint(fp)!;
    const d = byFingerprint.get(`${parsed.code}:${parsed.irHash}`);
    const auto = d ? null : opts.includeMatches ? automatic(s.match) : null;
    if (!d && !auto) return;
    const name = s.name.replace(/\s+/g, " ").trim();
    lines.push(`# fp ${fp} ${d ? "decision" : "auto"} ${s.code}${name ? ` ${name}` : ""}`);
    if (d && d.canonicalId === null) {
      lines.push(`# keep ${s.code}`);
      out.kept++;
    } else {
      rule(d ? d.canonicalId! : auto!, s.code);
      if (!d) out.auto++;
    }
  });
  return { text: `${lines.join("\n")}\n`, ...out };
}

// ---- import -------------------------------------------------------------------

export type CrtDecision = { symbolIdx: number; accept: string } | { symbolIdx: number; unmatch: true };

export interface CrtResolution {
  /** For `decide`, by `symbolIdx`. */
  decisions: CrtDecision[];
  /** Rules that restate what the document draws automatically; not recorded. */
  unchanged: { line: number; symbolIdx: number }[];
  skipped: CrtSkip[];
  /** Counted per code, the import report's shape. */
  warnings: ImportWarning[];
}

const MESSAGE_LINES = 5;

/**
 * Resolve a parsed CRT against a stored document (docs/map-symbols.md
 * §8.6): sources by fingerprint, else by normalised code; targets in the
 * document's library; the later line for a symbol wins.
 */
export function resolveCrt(file: CrtFile, header: CrtDocumentLike): CrtResolution {
  const libraryId = documentLibraryId(header);
  const fps = documentSymbolFingerprints(header);
  const skipped: CrtSkip[] = [...file.problems];
  const notes: CrtSkip[] = [];
  const headerLibrary = file.header.library?.split("@")[0];
  if (headerLibrary && headerLibrary !== libraryId) notes.push({ line: 0, code: "CRT_LIBRARY_MISMATCH", message: `${headerLibrary}, the document's is ${libraryId}` });

  const byCode = new Map<string, number[]>();
  header.symbols.forEach((s, i) => {
    if ((s.origin ?? "source") !== "source") return;
    const c = normaliseCode(s.code);
    byCode.set(c, [...(byCode.get(c) ?? []), i]);
  });

  const outcome = new Map<number, { line: number; decision: CrtDecision | null }>();
  for (const st of file.statements) {
    const code = normaliseCode(st.source);
    let symbols: number[] | undefined;
    // Reported only when the line then applies by code; a skipped line carries its own code alone.
    let mismatch: CrtSkip | undefined;
    if (st.fingerprint) {
      const fp = parseDecisionFingerprint(st.fingerprint)!;
      const hit = fp.code === code ? fps.flatMap((f, i) => (f === st.fingerprint ? [i] : [])) : [];
      if (hit.length) symbols = hit;
      else mismatch = { line: st.line, code: "CRT_FINGERPRINT_MISMATCH", message: st.fingerprint };
    }
    if (!symbols) {
      const all = byCode.get(code) ?? [];
      if (!all.length) {
        skipped.push({ line: st.line, code: "CRT_SOURCE_UNKNOWN", message: clip(st.source) });
        continue;
      }
      symbols = all.filter((i) => fps[i]);
      if (!symbols.length) {
        skipped.push({ line: st.line, code: "CRT_SOURCE_NOT_REVIEWABLE", message: clip(st.source) });
        continue;
      }
    }
    let canonicalId: string | null = null;
    if (st.kind === "rule") {
      canonicalId = st.target.includes(":") ? st.target : `${libraryId}:${st.target}`;
      if (!canonicalId.startsWith(`${libraryId}:`) || !getLibraryEntry(canonicalId)) {
        skipped.push({ line: st.line, code: "CRT_TARGET_UNKNOWN", message: clip(st.target) });
        continue;
      }
    }
    if (mismatch) notes.push(mismatch);
    for (const symbolIdx of symbols) {
      const decision: CrtDecision | null =
        canonicalId === null ? { symbolIdx, unmatch: true } : automatic(header.symbols[symbolIdx].match) === canonicalId ? null : { symbolIdx, accept: canonicalId };
      outcome.set(symbolIdx, { line: st.line, decision });
    }
  }

  const ordered = [...outcome.entries()].sort(([a], [b]) => a - b);
  skipped.sort((a, b) => a.line - b.line);
  const counted = new Map<CrtWarningCode, CrtSkip[]>();
  for (const s of [...notes, ...skipped].sort((a, b) => a.line - b.line)) counted.set(s.code, [...(counted.get(s.code) ?? []), s]);
  const warnings: ImportWarning[] = [...counted.entries()].map(([code, list]) => ({
    code,
    count: list.length,
    message: list.slice(0, MESSAGE_LINES).map((s) => (s.line ? `line ${s.line}: ${s.message}` : s.message)).join("; ") + (list.length > MESSAGE_LINES ? "; …" : ""),
  }));
  return {
    decisions: ordered.flatMap(([, o]) => (o.decision ? [o.decision] : [])),
    unchanged: ordered.flatMap(([symbolIdx, o]) => (o.decision ? [] : [{ line: o.line, symbolIdx }])),
    skipped,
    warnings,
  };
}
