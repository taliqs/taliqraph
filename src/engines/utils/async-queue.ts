/** Unbounded push-based queue consumable as an async iterable (engine streaming input). */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly buffered: T[] = [];
  private waiting: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waiting.shift();
    if (waiter) {
      waiter({ value, done: false });
    } else {
      this.buffered.push(value);
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const waiter of this.waiting.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffered.length > 0) {
          const value = this.buffered.shift() as T;
          return Promise.resolve({ value, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => this.waiting.push(resolve));
      },
    };
  }
}
