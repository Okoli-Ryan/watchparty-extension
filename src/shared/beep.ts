/**
 * Short two-tone blip for an incoming message.
 *
 * Synthesised with WebAudio so no audio asset has to ship — which also means no
 * host-page CSP can block it, and the web build has nothing extra to fetch.
 *
 * Shared by the extension's floating widget and the web dashboard so the two
 * sound identical.
 */
export function beep(): void {
  try {
    const w = window as unknown as {
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    const Ctx = w.AudioContext ?? w.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    // A context created before any user gesture starts suspended. Resuming is a
    // no-op once the page has been interacted with, and harmlessly rejected
    // before that — either way it must not throw.
    void ctx.resume?.().catch(() => undefined);

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(660, ctx.currentTime);
    osc.frequency.setValueAtTime(880, ctx.currentTime + 0.09);
    // Quiet, and faded out so it doesn't click.
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.24);
    osc.onended = () => void ctx.close();
  } catch {
    /* audio unavailable (no gesture yet, blocked context) — never fatal */
  }
}
