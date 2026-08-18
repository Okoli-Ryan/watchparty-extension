import { useEffect, useState } from 'react';
import { getSettings, saveSettings, watchSettings, DEFAULT_SETTINGS, type Settings } from '../../shared/settings';

/**
 * User preferences. Owns its own state rather than taking it from the shell:
 * settings live in extension-local storage and nothing else on the dashboard
 * reads them, so there's no reason to subscribe unless this tab is mounted.
 */
export function SettingsTab() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);

  useEffect(() => {
    void getSettings().then(setSettings);
    // Follow changes made elsewhere (another dashboard tab, another window).
    return watchSettings(setSettings);
  }, []);

  return (
    <div className="dash-section">
      <h2>Settings</h2>
      <div className="rcard" style={{ maxWidth: 460 }}>
        <label className="setting">
          <input
            type="checkbox"
            checked={settings.chatBeep}
            onChange={(e) => void saveSettings({ chatBeep: e.target.checked }).then(setSettings)}
          />
          <span>
            <strong>Chat sound</strong>
            <span className="muted" style={{ display: 'block', marginTop: 3 }}>
              Play a short tone when someone else sends a message. Applies immediately,
              including in rooms you already have open.
            </span>
          </span>
        </label>
      </div>
    </div>
  );
}
