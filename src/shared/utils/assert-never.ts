export function assertNever(value: never, context: string): never {
  throw new Error(`Unreachable ${context}: ${JSON.stringify(value)}`);
}
