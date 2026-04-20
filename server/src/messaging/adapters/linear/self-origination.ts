interface LruEntry {
  expiresAt: number;
}

export class SelfOriginationTracker {
  private lru = new Map<string, LruEntry>();
  private readonly ttlMs: number;
  private readonly maxSize: number;

  constructor(opts?: { ttlMs?: number; maxSize?: number }) {
    this.ttlMs = opts?.ttlMs ?? 120_000;
    this.maxSize = opts?.maxSize ?? 1024;
  }

  /**
   * Record a Paperclip-originated change. Call immediately after a successful
   * Linear mutation so the echoing webhook can be suppressed.
   */
  mark(externalRef: string): void {
    this.evictExpired();
    while (this.lru.size >= this.maxSize) {
      const first = this.lru.keys().next().value as string | undefined;
      if (!first) break;
      this.lru.delete(first);
    }
    this.lru.set(externalRef, { expiresAt: Date.now() + this.ttlMs });
  }

  wasRecentlyMarked(externalRef: string): boolean {
    const hit = this.lru.get(externalRef);
    if (!hit) return false;
    if (hit.expiresAt < Date.now()) {
      this.lru.delete(externalRef);
      return false;
    }
    return true;
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.lru) {
      if (entry.expiresAt < now) this.lru.delete(key);
    }
  }
}

export const selfOriginationTracker = new SelfOriginationTracker();
