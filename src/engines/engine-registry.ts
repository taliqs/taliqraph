import type { EngineAdapter } from './engine-adapter';

export class EngineRegistry {
  private readonly adapters = new Map<string, EngineAdapter>();

  register(adapter: EngineAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`Engine '${adapter.id}' is already registered`);
    }
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): EngineAdapter | undefined {
    return this.adapters.get(id);
  }

  list(): readonly EngineAdapter[] {
    return [...this.adapters.values()];
  }
}
