import type { AdapterFactory } from "./types";

const adapters = new Map<string, AdapterFactory>();

export function register(sha8: string, factory: AdapterFactory): void {
  adapters.set(sha8, factory);
}

export function lookup(sha256hex: string): AdapterFactory | undefined {
  return adapters.get(sha256hex.slice(0, 8));
}
