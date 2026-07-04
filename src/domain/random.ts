import { sha256 } from "./ids.js";

export interface SeededRandom {
  next(): number;
  pick<T>(items: readonly T[], count: number): T[];
}

export function createSeededRandom(seed: string): SeededRandom {
  const hash = sha256(seed);
  let state = Number.parseInt(hash.slice(0, 8), 16) || 0x9e3779b9;

  function next(): number {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 1_000_000) / 1_000_000;
  }

  function pick<T>(items: readonly T[], count: number): T[] {
    const decorated = items.map((item) => ({ item, sort: next() }));
    decorated.sort((a, b) => a.sort - b.sort);
    return decorated.slice(0, Math.max(0, count)).map((entry) => entry.item);
  }

  return { next, pick };
}
