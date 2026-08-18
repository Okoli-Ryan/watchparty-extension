/**
 * Cross-browser extension API accessor (Chrome, Edge, Firefox).
 *
 * Firefox exposes the promise-based WebExtension API as `browser`. Its `chrome`
 * alias exists for compatibility but is CALLBACK-style, so `await
 * chrome.tabs.query(...)` there resolves to `undefined` rather than the tabs —
 * a silent failure, not a crash. Chrome and Edge expose only `chrome`, which is
 * promise-based under MV3.
 *
 * Preferring `browser` when it exists gives one promise-based surface on all
 * three browsers with no polyfill dependency.
 *
 * Note: this is the *value* namespace. Type-only references (chrome.runtime.Port,
 * chrome.tabs.Tab) still use the `chrome` namespace from @types/chrome, which is
 * erased at compile time and so costs nothing at runtime.
 */
const globals = globalThis as unknown as {
  browser?: typeof chrome;
  chrome?: typeof chrome;
};

export const ext: typeof chrome = globals.browser ?? (globals.chrome as typeof chrome);

/**
 * True on Firefox, where a few APIs behave differently.
 *
 * Tested on `browser` alone. Firefox defines BOTH `browser` and a callback-style
 * `chrome` alias (that alias is the whole reason this module exists), so a
 * `&& !globals.chrome` clause made this permanently false.
 */
export const isFirefox = !!globals.browser;
