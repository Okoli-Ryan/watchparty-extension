// Diagnostic logging for the playback-sync path.
//
// Flip DEBUG to false (or delete the log() calls) once sync is verified.
// Where the output lands:
//   • [WP:owner] / [WP:viewer] / [WP:content]  → the PAGE's devtools console
//   • [WP:bg]                                  → the service-worker console
//     (chrome://extensions → your extension → "service worker")
//
// Every line is timestamped HH:MM:SS.mmm so you can line up the owner's action
// with the viewer's reaction across two browsers and read off the real latency.

// Off for store builds — leave it false in anything you publish, or every user's
// console shows room/playback internals. Flip to true while developing.
export const DEBUG = false;

function stamp(): string {
  return new Date().toISOString().slice(11, 23);
}

export function log(scope: string, ...args: unknown[]): void {
  if (!DEBUG) return;
  console.log(`%c[WP:${scope}]%c ${stamp()}`, 'color:#6c5ce7;font-weight:700', 'color:#888', ...args);
}

export function warn(scope: string, ...args: unknown[]): void {
  if (!DEBUG) return;
  console.warn(`[WP:${scope}] ${stamp()}`, ...args);
}

/** Errors always log, even with DEBUG off — these are real failures. */
export function fail(scope: string, ...args: unknown[]): void {
  console.error(`[WP:${scope}] ${stamp()}`, ...args);
}
