// ── Semaphore ──

class Semaphore {
  private permits: number;
  private queue: Array<() => void> = [];

  constructor(private maxPermits: number) {
    this.permits = maxPermits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    } else {
      this.permits++;
    }
  }
}

// ── Concurrency limiter ──

export class ConcurrencyLimiter {
  private semaphore: Semaphore;

  constructor(maxConcurrent: number) {
    this.semaphore = new Semaphore(maxConcurrent);
  }

  async acquire(): Promise<() => void> {
    await this.semaphore.acquire();
    return () => this.semaphore.release();
  }
}
