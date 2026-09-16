import type { ZodError } from 'zod';

/** zod's own phrasing, as a person would say it. */
function readable(message: string): string {
  const options = /^Invalid option: expected one of (.+)$/.exec(message);
  if (options) {
    const list = options[1]?.split('|').map((option) => option.trim()) ?? [];
    return list.length > 1
      ? `use ${list.slice(0, -1).join(', ')} or ${list.at(-1)}`
      : `use ${list.join('')}`;
  }
  const received = /^Invalid input: expected (\w+), received (\w+)$/.exec(message);
  if (received) {
    return `expected ${received[1]}, not ${received[2]}`;
  }
  return message.replace(/^Invalid input: /, '');
}

export function formatZodIssues(error: ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join('.');
    const message = readable(issue.message);
    return path.length > 0 ? `${path}: ${message}` : message;
  });
}
