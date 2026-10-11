export class BusyError extends Error {
  constructor() { super("Voice service is busy. Please try again shortly."); }
}
type Waiter = { resolve: (release: () => void) => void; reject: (error: Error) => void; cleanup: () => void };
export class WorkPool {
  private active = 0;
  private waiting: Waiter[] = [];
  constructor(private concurrency: number, private maxQueue: number, private timeoutMs: number) {}
  get status() { return { active: this.active, queued: this.waiting.length, concurrency: this.concurrency, capacity: this.maxQueue }; }
  async acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.active < this.concurrency) { this.active++; return this.releaseOnce(); }
    if (this.waiting.length >= this.maxQueue) throw new BusyError();
    return new Promise((resolve, reject) => {
      const remove = (error: Error) => {
        const index = this.waiting.indexOf(waiter);
        if (index < 0) return;
        this.waiting.splice(index, 1); waiter.cleanup(); reject(error);
      };
      const onAbort = () => remove(new DOMException("Request cancelled", "AbortError"));
      const timer = setTimeout(() => remove(new BusyError()), this.timeoutMs);
      const waiter: Waiter = { resolve, reject, cleanup: () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); } };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(waiter);
    });
  }
  private releaseOnce() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const waiter = this.waiting.shift();
      if (waiter) { waiter.cleanup(); waiter.resolve(this.releaseOnce()); }
      else this.active--;
    };
  }
  async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try { signal?.throwIfAborted(); return await work(); }
    finally { release(); }
  }
}
