export function buildGreeting(name: string): string {
  const normalized = name.trim().replace(/\s+/g, ' ');
  return normalized === '' ? 'Hello!' : `Hello, ${normalized}!`;
}
