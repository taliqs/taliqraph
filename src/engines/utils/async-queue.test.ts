import { describe, expect, it } from 'vitest';
import { AsyncQueue } from './async-queue';

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) {
    values.push(value);
  }
  return values;
}

describe('AsyncQueue', () => {
  it('yields buffered values then completes on close', async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.push(2);
    queue.close();
    expect(await collect(queue)).toEqual([1, 2]);
  });

  it('wakes a waiting consumer when a value arrives', async () => {
    const queue = new AsyncQueue<string>();
    const pending = collect(queue);
    queue.push('late');
    queue.close();
    expect(await pending).toEqual(['late']);
  });

  it('ignores pushes after close', async () => {
    const queue = new AsyncQueue<number>();
    queue.close();
    queue.push(1);
    expect(await collect(queue)).toEqual([]);
  });
});
