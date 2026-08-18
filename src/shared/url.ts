/**
 * The host part of a page URL, for compact display next to a room name.
 *
 * Falls back to the raw string: a room's `pageUrl` comes from whatever tab the
 * host picked in, and older rooms can hold values that don't parse.
 */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url || 'unknown';
  }
}
