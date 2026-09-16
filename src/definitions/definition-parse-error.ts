export interface DefinitionParseError {
  readonly message: string;
  readonly issues: readonly string[];
}

export function definitionParseError(
  message: string,
  issues: readonly string[] = [],
): DefinitionParseError {
  return { message, issues };
}
