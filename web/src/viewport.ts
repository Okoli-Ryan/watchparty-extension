/**
 * Keep the app exactly as tall as the *visible* viewport.
 *
 * `100vh` is the wrong unit on a phone: it measures the layout viewport, which
 * does not shrink when the on-screen keyboard opens. The keyboard then covers
 * the bottom of a full-height flex column — which is exactly where the chat
 * composer lives, so you cannot see what you are typing.
 *
 * Two mechanisms, because no single one covers both platforms:
 *  • `interactive-widget=resizes-content` in the viewport meta (index.html) makes
 *    Chrome/Android shrink the layout viewport for the keyboard.
 *  • `visualViewport` covers iOS Safari, which does not support that and instead
 *    only shrinks the *visual* viewport.
 *
 * Both feed `--app-h`, which `.app` uses instead of a viewport unit.
 */
export function trackViewportHeight(): void {
  const vv = window.visualViewport;

  const sync = () => {
    const h = vv?.height ?? window.innerHeight;
    document.documentElement.style.setProperty('--app-h', `${Math.round(h)}px`);
  };

  vv?.addEventListener('resize', sync);
  // iOS shifts the visual viewport rather than resizing it when the keyboard
  // appears mid-scroll, which surfaces as a scroll event.
  vv?.addEventListener('scroll', sync);
  window.addEventListener('resize', sync);
  window.addEventListener('orientationchange', sync);
  sync();
}
