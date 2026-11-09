/**
 * The UI key (spec §3.9 access): kept in `sessionStorage` so it
 * survives reloads but not the browser session. Storage can throw —
 * private modes, disabled cookies, a full quota — so a module-level
 * fallback keeps the key for the rest of the session either way.
 */

const STORAGE_KEY = "babelgate-key";

let memoryKey: string | null = null;

export function getKey(): string | null {
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (stored !== null) return stored;
  } catch {
    // storage unavailable — memory still holds the session key
  }
  return memoryKey;
}

export function setKey(key: string | null): void {
  memoryKey = key;
  try {
    if (key === null) sessionStorage.removeItem(STORAGE_KEY);
    else sessionStorage.setItem(STORAGE_KEY, key);
  } catch {
    // stays in memory for the session
  }
}
