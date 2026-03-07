export function formatTime(milliseconds: number | null): string | null {
  if (!milliseconds || milliseconds <= 0) return null;

  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor((milliseconds % 3600000) / 60000);
  const seconds = Math.floor((milliseconds % 60000) / 1000);

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  if (seconds > 30) {
    return '1m';
  }
  return 'Less than 1m';
}
