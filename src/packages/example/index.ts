import { buildGreeting } from './lib/impl';

export function greetFromExample(name: string): string {
  return buildGreeting(name);
}
