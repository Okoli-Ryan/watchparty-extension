import { useCallback, useEffect, useState } from 'react';

/**
 * A nonce to hang live subscriptions off, so they can be rebuilt.
 *
 * Firestore's `onSnapshot` NEVER retries after an error — the listener is dead
 * for good, and the only recovery is to create a new one. On a phone that
 * happens routinely: the socket is dropped when the tab is backgrounded or the
 * network flaps, and from then on the feed silently stops updating. The symptom
 * is "sometimes I have to refresh to see new messages", because a reload is the
 * only thing that rebuilds the listener.
 *
 * Put `nonce` in a subscription effect's dependencies, and call `retry()` from
 * its error handler.
 */
export function useResubscribe(): { nonce: number; retry: () => void } {
  const [nonce, setNonce] = useState(0);
  const retry = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    // Coming back to the tab is exactly when a connection dropped in the
    // background surfaces, and re-listening is cheap — Firestore answers from
    // its local cache first and only then reaches the server.
    const onVisible = () => {
      if (!document.hidden) retry();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', retry);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', retry);
    };
  }, [retry]);

  return { nonce, retry };
}
