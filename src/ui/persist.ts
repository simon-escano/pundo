/**
 * Ask the browser to treat our IndexedDB as persistent. Without this, Safari (and Chrome under storage
 * pressure) may evict script-written data after ~7 days without a visit; installed PWAs are exempt.
 * Best effort: a refusal or an unsupported browser must never affect the app.
 */
export async function requestPersistentStorage(): Promise<boolean | null> {
  try {
    if (typeof navigator === "undefined" || !navigator.storage?.persist) return null;
    return await navigator.storage.persist();
  } catch {
    return null;
  }
}
