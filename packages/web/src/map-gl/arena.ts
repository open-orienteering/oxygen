/**
 * WebGL2 backend, arenas (04 §6.8 point 1): one large vertex buffer per
 * primitive kind with sub-allocations per bucket part. Buckets are the
 * unit of preparation and residency, not of drawing — the visible-set
 * index buffers address any part's vertices because they all live in the
 * one buffer.
 *
 * `RangeAllocator` is the pure free list (first fit, coalescing frees,
 * growable); `GpuArena` wraps a GL buffer around it and grows into a
 * larger buffer by re-uploading every live range from the data `put`
 * received, so a part's offset never changes while it is resident.
 * Growth does **not** `copyBufferSubData` the old buffer: ANGLE on
 * Adreno (Galaxy S25, Chrome 155) copies stale zeros from a buffer that
 * has in-flight draws, silently and without a GL error — whole detail
 * parts came back empty (`docs/bugfix-adreno-arena-grow.md`). The caller
 * keeps the uploaded views alive anyway (`ResidentPart.part`), so the
 * registry costs no memory, and the re-upload measured no slower than
 * the copy on that device.
 */

export class RangeAllocator {
  /** Free ranges, sorted by offset, never adjacent (coalesced). */
  private free: { offset: number; size: number }[];
  private usedUnits = 0;
  private cap: number;

  constructor(capacity: number) {
    this.cap = capacity;
    this.free = capacity > 0 ? [{ offset: 0, size: capacity }] : [];
  }

  get capacity(): number {
    return this.cap;
  }

  get used(): number {
    return this.usedUnits;
  }

  /** First-fit allocation; −1 when no free range is large enough. */
  alloc(size: number): number {
    if (size <= 0) return 0;
    for (let i = 0; i < this.free.length; i++) {
      const f = this.free[i];
      if (f.size < size) continue;
      const offset = f.offset;
      if (f.size === size) this.free.splice(i, 1);
      else { f.offset += size; f.size -= size; }
      this.usedUnits += size;
      return offset;
    }
    return -1;
  }

  release(offset: number, size: number): void {
    if (size <= 0) return;
    this.usedUnits -= size;
    let i = 0;
    while (i < this.free.length && this.free[i].offset < offset) i++;
    this.free.splice(i, 0, { offset, size });
    // Coalesce with the next, then with the previous neighbour.
    const cur = this.free[i];
    const next = this.free[i + 1];
    if (next && cur.offset + cur.size === next.offset) {
      cur.size += next.size;
      this.free.splice(i + 1, 1);
    }
    const prev = this.free[i - 1];
    if (prev && prev.offset + prev.size === cur.offset) {
      prev.size += cur.size;
      this.free.splice(i, 1);
    }
  }

  /** Extends the capacity; the new space joins the free list. */
  grow(capacity: number): void {
    if (capacity <= this.cap) return;
    const extra = capacity - this.cap;
    const last = this.free[this.free.length - 1];
    if (last && last.offset + last.size === this.cap) last.size += extra;
    else this.free.push({ offset: this.cap, size: extra });
    this.cap = capacity;
  }

  /** Free ranges, for tests. */
  freeRanges(): { offset: number; size: number }[] {
    return this.free.map((f) => ({ ...f }));
  }
}

/** Capacity growth factor: the slack counts as resident GPU memory, so it stays small. */
export const GROWTH = 1.25;

/** A GL vertex buffer of fixed-stride vertices, sub-allocated in vertices. */
export class GpuArena {
  buffer: WebGLBuffer;
  readonly alloc: RangeAllocator;
  /** Bumped whenever `buffer` is replaced (vertex array objects must be re-pointed). */
  generation = 0;
  readonly stride: number;
  private readonly gl: WebGL2RenderingContext;
  /** Live ranges by first vertex: what a grow re-uploads. */
  private readonly live = new Map<number, ArrayBufferView>();

  constructor(gl: WebGL2RenderingContext, stride: number, initialVertices = 1 << 16) {
    this.gl = gl;
    this.stride = stride;
    this.alloc = new RangeAllocator(initialVertices);
    this.buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.COPY_WRITE_BUFFER, this.buffer);
    gl.bufferData(gl.COPY_WRITE_BUFFER, initialVertices * stride, gl.STATIC_DRAW);
  }

  /** Bytes of the GL buffer (capacity, what the GPU holds). */
  get capacityBytes(): number {
    return this.alloc.capacity * this.stride;
  }

  /** Bytes of live allocations. */
  get usedBytes(): number {
    return this.alloc.used * this.stride;
  }

  /**
   * Uploads `data` (whole vertices) and returns its first vertex. The view
   * is kept until `release`: a grow re-uploads it, so the caller must not
   * mutate or detach it while the range is live.
   */
  put(data: ArrayBuffer | ArrayBufferView): number {
    const view = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    const n = view.byteLength / this.stride;
    let at = this.alloc.alloc(n);
    if (at < 0) {
      this.growTo(Math.ceil(Math.max(this.alloc.capacity * GROWTH, this.alloc.capacity + n)));
      at = this.alloc.alloc(n);
    }
    const gl = this.gl;
    gl.bindBuffer(gl.COPY_WRITE_BUFFER, this.buffer);
    gl.bufferSubData(gl.COPY_WRITE_BUFFER, at * this.stride, view);
    if (n > 0) this.live.set(at, view);
    return at;
  }

  release(first: number, vertices: number): void {
    this.alloc.release(first, vertices);
    if (vertices > 0) this.live.delete(first);
  }

  /** Live ranges as `[firstVertex, vertices]`, for tests. */
  liveRanges(): [number, number][] {
    return [...this.live].map(([at, v]) => [at, v.byteLength / this.stride]);
  }

  private growTo(vertices: number): void {
    const gl = this.gl;
    const next = gl.createBuffer()!;
    gl.bindBuffer(gl.COPY_WRITE_BUFFER, next);
    gl.bufferData(gl.COPY_WRITE_BUFFER, vertices * this.stride, gl.STATIC_DRAW);
    for (const [at, view] of this.live) gl.bufferSubData(gl.COPY_WRITE_BUFFER, at * this.stride, view);
    gl.deleteBuffer(this.buffer);
    this.buffer = next;
    this.alloc.grow(vertices);
    this.generation++;
  }

  dispose(): void {
    this.gl.deleteBuffer(this.buffer);
  }
}
