import { ext } from './ext';

// User preferences, stored in extension-local storage so they persist across
// browser restarts and are shared by the popup, dashboard and content script.

export interface Settings {
  /** Play a short tone when a chat message arrives from someone else. */
  chatBeep: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  chatBeep: true,
};

const KEY = 'watchparty:settings';

export async function getSettings(): Promise<Settings> {
  const stored = await ext.storage.local.get(KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[KEY] ?? {}) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await ext.storage.local.set({ [KEY]: next });
  return next;
}

// Widget position is stored separately from preferences: it changes on every
// drag, and shouldn't churn the settings object the dashboard subscribes to.
const POS_KEY = 'watchparty:widgetPos';

export async function getWidgetPos(): Promise<{ x: number; y: number } | null> {
  const stored = await ext.storage.local.get(POS_KEY);
  const pos = stored[POS_KEY];
  return pos && typeof pos.x === 'number' && typeof pos.y === 'number' ? pos : null;
}

export async function saveWidgetPos(pos: { x: number; y: number }): Promise<void> {
  await ext.storage.local.set({ [POS_KEY]: pos });
}

/** React to changes made in another context (e.g. the dashboard). */
export function watchSettings(cb: (settings: Settings) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'local' || !changes[KEY]) return;
    cb({ ...DEFAULT_SETTINGS, ...(changes[KEY].newValue ?? {}) });
  };
  ext.storage.onChanged.addListener(listener);
  return () => ext.storage.onChanged.removeListener(listener);
}
