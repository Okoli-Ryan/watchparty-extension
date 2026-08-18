// Date helpers shared by the popup and the dashboard.

/** "16 Aug 2026" — for a room's creation date. */
export function formatDate(ms: number | null | undefined): string {
  if (!ms) return 'unknown';
  return new Date(ms).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** "16 Aug 2026, 21:04" — for a precise last-attended stamp. */
export function formatDateTime(ms: number | null | undefined): string {
  if (!ms) return 'never';
  return new Date(ms).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "just now" / "12m ago" / "3h ago" / "5d ago" — compact relative time. */
export function timeAgo(ms: number | null | undefined): string {
  if (!ms) return 'never';
  const mins = Math.floor((Date.now() - ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(ms);
}
