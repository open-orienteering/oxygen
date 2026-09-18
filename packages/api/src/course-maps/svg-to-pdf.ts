import { spawn } from "node:child_process";
import { PDFDocument } from "pdf-lib";

export type ProcessRunner = (
  command: string,
  args: string[],
  input: Buffer,
  timeoutMs: number,
) => Promise<Buffer>;

async function runProcess(
  command: string,
  args: string[],
  input: Buffer,
  timeoutMs: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`${command} timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(Buffer.concat(stdout));
    }

    child.on("error", (error) => {
      const suffix =
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? " (install librsvg2-bin)"
          : "";
      finish(new Error(`Could not start ${command}${suffix}: ${error.message}`));
    });
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("close", (code, signal) => {
      if (code === 0) finish();
      else {
        finish(
          new Error(
            `${command} failed (${signal ?? `exit ${code}`}): ${Buffer.concat(stderr).toString("utf8").trim()}`,
          ),
        );
      }
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      // A converter that rejects its arguments may close stdin before Node
      // finishes writing. Wait for `close` so stderr supplies the useful
      // diagnostic instead of masking it with EPIPE.
      if (error.code !== "EPIPE") finish(error);
    });
    child.stdin.end(input);
  });
}

export interface RsvgConverterOptions {
  command?: string;
  timeoutMs?: number;
  run?: ProcessRunner;
}

export class RsvgConverter {
  readonly command: string;
  readonly timeoutMs: number;
  private readonly run: ProcessRunner;

  constructor(options: RsvgConverterOptions = {}) {
    this.command =
      options.command ?? process.env.RSVG_CONVERT_COMMAND ?? "rsvg-convert";
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.run = options.run ?? runProcess;
  }

  convert(svg: string): Promise<Buffer> {
    return this.run(
      this.command,
      ["--format=pdf"],
      Buffer.from(svg),
      this.timeoutMs,
    );
  }
}

export async function mergePdfPages(
  pagePdfs: Buffer[],
  metadata?: { title?: string; author?: string },
): Promise<Buffer> {
  if (pagePdfs.length === 0) {
    throw new Error("Cannot create a PDF without pages");
  }
  const merged = await PDFDocument.create();
  for (const bytes of pagePdfs) {
    const source = await PDFDocument.load(bytes);
    const pages = await merged.copyPages(source, source.getPageIndices());
    for (const page of pages) merged.addPage(page);
  }
  if (metadata?.title) merged.setTitle(metadata.title);
  if (metadata?.author) merged.setAuthor(metadata.author);
  merged.setCreator("Oxygen");
  return Buffer.from(await merged.save());
}
