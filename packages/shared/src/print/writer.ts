/**
 * `PdfWriter` — the only file that knows the PDF library (research 05
 * §6 B; docs/course-print.md §1). `@cantoo/pdf-lib` serves as object
 * model, Flate and cross-reference writer; content streams come from
 * `operators.ts`, font programs from `fonts.ts`. Replacing the library
 * (05 §6 C) means rewriting this file only.
 *
 * Per document: one font object per bundled face (subset at `save()`
 * to the glyphs every page used), one form XObject per distinct glyph
 * part, shared by all pages (05 §5.10). `deterministic` = fixed dates and
 * a fixed `/ID`, so equal input gives equal bytes (05 §5.8).
 */

import { PDFDocument, PDFHexString, PDFName, type PDFPage, type PDFRef, PDFString } from "@cantoo/pdf-lib";
import type { FontFamily, FontRef, GlyphMesh } from "../render/pass-stream.js";
import { type TrueTypeFont, parseTrueType } from "../render/truetype.js";
import { cidWidths, fontDescriptorValues, subsetTag, subsetTrueType, toUnicodeCMap } from "./fonts.js";
import { type OperatorResources, glyphFormBBox, glyphFormContent } from "./operators.js";

/** A font file the writer may embed (`packages/shared/fonts/`). */
export interface PdfFontFace {
  family: FontFamily;
  data: ArrayBuffer | Uint8Array;
}

export interface PdfWriterOptions {
  faces?: PdfFontFace[];
  /** Fixed dates and `/ID`: equal input → equal bytes (test fixtures, golden files). */
  deterministic?: boolean;
  /** Creation date when not deterministic; default now. */
  now?: Date;
  info?: { title?: string; author?: string; subject?: string; keywords?: string[] };
  /** `outline` draws text as glyph outlines instead of embedding fonts (the 05 §5.6 fallback). */
  text?: "font" | "outline";
}

export interface PdfPageInit {
  widthPt: number;
  heightPt: number;
  /** `[llx lly urx ury]` in points; default the MediaBox (the paper, 05 §5.8). */
  trimBox?: [number, number, number, number];
}

/** The fixed timestamp of deterministic output. */
export const DETERMINISTIC_DATE = new Date("2000-01-01T00:00:00Z");

const POSTSCRIPT_NAMES: Record<FontFamily, string> = {
  "liberation-sans": "LiberationSans",
  "liberation-sans-narrow": "LiberationSansNarrow",
  "liberation-serif": "LiberationSerif",
  "liberation-mono": "LiberationMono",
};

interface Face {
  family: FontFamily;
  metrics: TrueTypeFont;
  data: Uint8Array;
  /** Subsetting works for this file (checked once at load); otherwise outlines. */
  embeddable: boolean;
  name?: string;
  ref?: PDFRef;
  glyphs: Set<number>;
}

const toArrayBuffer = (d: ArrayBuffer | Uint8Array): ArrayBuffer =>
  d instanceof Uint8Array ? (d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) as ArrayBuffer) : d;

export class PdfWriter {
  private readonly faces: Face[] = [];
  private readonly forms = new Map<string, { name: string; ref: PDFRef }>();
  private readonly formsByMesh = new WeakMap<GlyphMesh, { name: string; ref: PDFRef }>();
  private fontCount = 0;
  private saved = false;
  /** Why a face falls back to outlines (unreadable file); for the caller to log. */
  readonly warnings: string[] = [];

  private constructor(
    private readonly doc: PDFDocument,
    private readonly opts: PdfWriterOptions,
  ) {
    for (const f of opts.faces ?? []) {
      const data = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data);
      const metrics = parseTrueType(toArrayBuffer(data), f.family);
      let embeddable = opts.text !== "outline";
      try {
        if (embeddable) subsetTrueType(data, [metrics.glyphId(0x30)]);
      } catch (err) {
        embeddable = false;
        this.warnings.push(`PDF_FONT_OUTLINES: ${f.family} cannot be subset, text drawn as outlines (${err instanceof Error ? err.message : String(err)})`);
      }
      this.faces.push({ family: f.family, metrics, data, embeddable, glyphs: new Set() });
    }
  }

  static async create(opts: PdfWriterOptions = {}): Promise<PdfWriter> {
    const doc = await PDFDocument.create({ updateMetadata: false });
    return new PdfWriter(doc, opts);
  }

  private face(ref: FontRef): Face | undefined {
    return (
      this.faces.find((f) => f.family === ref.family && f.metrics.bold === ref.bold && f.metrics.italic === ref.italic) ??
      this.faces.find((f) => f.family === ref.family)
    );
  }

  /** A new page; draw on it with `PdfWriterPage.addContent` and its `resources`. */
  addPage(init: PdfPageInit): PdfWriterPage {
    if (this.saved) throw new Error("PdfWriter: page added after save()");
    const page = this.doc.addPage([init.widthPt, init.heightPt]);
    const [x0, y0, x1, y1] = init.trimBox ?? [0, 0, init.widthPt, init.heightPt];
    page.node.set(PDFName.of("TrimBox"), this.doc.context.obj([x0, y0, x1, y1]));
    return new PdfWriterPage(this, page);
  }

  /** @internal */ fontFor(page: PDFPage, ref: FontRef, glyphIds: ArrayLike<number>): string | undefined {
    const face = this.face(ref);
    if (!face || !face.embeddable) return undefined;
    if (!face.ref) {
      face.ref = this.doc.context.nextRef();
      face.name = `F${this.fontCount++}`;
    }
    for (let i = 0; i < glyphIds.length; i++) face.glyphs.add(glyphIds[i]);
    page.node.setFontDictionary(PDFName.of(face.name!), face.ref);
    return face.name;
  }

  /** @internal */ outlineFor(ref: FontRef, glyphId: number) {
    const face = this.face(ref);
    const path = face?.metrics.outline(glyphId);
    return face && path ? { path, unitsPerEm: face.metrics.unitsPerEm } : undefined;
  }

  /** @internal */ glyphFor(page: PDFPage, mesh: GlyphMesh): string {
    let form = this.formsByMesh.get(mesh);
    if (!form) {
      const content = glyphFormContent(mesh);
      const bbox = glyphFormBBox(mesh);
      // Equal parts share one XObject even when two streams number them differently.
      const key = `${bbox.join(" ")}\n${content}`;
      form = this.forms.get(key);
      if (!form) {
        const stream = this.doc.context.flateStream(content, { Type: "XObject", Subtype: "Form", BBox: bbox });
        form = { name: `G${this.forms.size}`, ref: this.doc.context.register(stream) };
        this.forms.set(key, form);
      }
      this.formsByMesh.set(mesh, form);
    }
    page.node.setXObject(PDFName.of(form.name), form.ref);
    return form.name;
  }

  /** @internal */ content(page: PDFPage, ops: string): void {
    page.node.addContentStream(this.doc.context.register(this.doc.context.flateStream(ops)));
  }

  private writeFonts(): void {
    const ctx = this.doc.context;
    for (const face of this.faces) {
      if (!face.ref) continue;
      const glyphs = [...face.glyphs];
      const program = subsetTrueType(face.data, glyphs);
      const d = fontDescriptorValues(face.data);
      const style = face.metrics.bold ? (face.metrics.italic ? "-BoldItalic" : "-Bold") : face.metrics.italic ? "-Italic" : "";
      const baseFont = `${subsetTag(face.family + style, glyphs)}+${POSTSCRIPT_NAMES[face.family]}${style}`;
      const fontFile = ctx.register(ctx.flateStream(program, { Length1: program.length }));
      const descriptor = ctx.register(
        ctx.obj({
          Type: "FontDescriptor",
          FontName: baseFont,
          Flags: d.flags,
          FontBBox: d.bbox,
          ItalicAngle: d.italicAngle,
          Ascent: d.ascent,
          Descent: d.descent,
          CapHeight: d.capHeight,
          StemV: d.stemV,
          FontFile2: fontFile,
        }),
      );
      const cidFont = ctx.register(
        ctx.obj({
          Type: "Font",
          Subtype: "CIDFontType2",
          BaseFont: baseFont,
          CIDSystemInfo: { Registry: PDFString.of("Adobe"), Ordering: PDFString.of("Identity"), Supplement: 0 },
          FontDescriptor: descriptor,
          W: cidWidths(face.metrics, glyphs),
          CIDToGIDMap: "Identity",
        }),
      );
      const toUnicode = ctx.register(ctx.flateStream(toUnicodeCMap(face.metrics, glyphs)));
      ctx.assign(
        face.ref,
        ctx.obj({
          Type: "Font",
          Subtype: "Type0",
          BaseFont: baseFont,
          Encoding: "Identity-H",
          DescendantFonts: [cidFont],
          ToUnicode: toUnicode,
        }),
      );
    }
  }

  private fileId(): string {
    const bytes = new Uint8Array(16);
    if (this.opts.deterministic) {
      // A fixed identifier: FNV-1a of the title, repeated — no randomness, still per document kind.
      let h = 0x811c9dc5;
      for (const ch of this.opts.info?.title ?? "") h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
      for (let i = 0; i < 16; i++) bytes[i] = (h >>> ((i % 4) * 8)) & 0xff;
    } else {
      globalThis.crypto.getRandomValues(bytes);
    }
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  /** Finishes fonts, metadata and the file. The writer cannot be used afterwards. */
  async save(): Promise<Uint8Array> {
    if (this.saved) throw new Error("PdfWriter: save() called twice");
    this.saved = true;
    this.writeFonts();
    const { info } = this.opts;
    if (info?.title) this.doc.setTitle(info.title);
    if (info?.author) this.doc.setAuthor(info.author);
    if (info?.subject) this.doc.setSubject(info.subject);
    if (info?.keywords) this.doc.setKeywords(info.keywords);
    this.doc.setCreator("Oxygen");
    this.doc.setProducer("Oxygen (@oxygen/shared/print)");
    const date = this.opts.deterministic ? DETERMINISTIC_DATE : (this.opts.now ?? new Date());
    this.doc.setCreationDate(date);
    this.doc.setModificationDate(date);
    const id = PDFHexString.of(this.fileId());
    this.doc.context.trailerInfo.ID = this.doc.context.obj([id, id]);
    return this.doc.save({ useObjectStreams: true });
  }
}

/** One page of a `PdfWriter`: its resources for `operators.ts` and its content. */
export class PdfWriterPage {
  readonly resources: OperatorResources;

  constructor(
    private readonly writer: PdfWriter,
    private readonly page: PDFPage,
  ) {
    this.resources = {
      font: (ref, glyphIds) => writer.fontFor(page, ref, glyphIds),
      glyphOutline: (ref, glyphId) => writer.outlineFor(ref, glyphId),
      glyph: (mesh) => writer.glyphFor(page, mesh),
    };
  }

  /** Appends a content stream (operators from `operators.ts`, in page points). */
  addContent(ops: string): void {
    this.writer.content(this.page, ops);
  }
}
