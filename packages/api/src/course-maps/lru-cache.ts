export class LruCache<Value> {
  private readonly entries = new Map<string, Value>();
  private totalBytes = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes = Number.POSITIVE_INFINITY,
    private readonly sizeOf: (value: Value) => number = () => 0,
  ) {}

  get(key: string): Value | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: Value): void {
    const previous = this.entries.get(key);
    if (previous !== undefined) this.totalBytes -= this.sizeOf(previous);
    this.entries.delete(key);
    this.entries.set(key, value);
    this.totalBytes += this.sizeOf(value);
    while (
      this.entries.size > this.maxEntries ||
      this.totalBytes > this.maxBytes
    ) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.totalBytes -= this.sizeOf(this.entries.get(oldest)!);
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }
}
