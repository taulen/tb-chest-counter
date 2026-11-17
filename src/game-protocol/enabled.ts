/**
 * Is the game protocol capture on for this clan? The setting
 * (GAME_PROTOCOL_CAPTURE_CLANS) is comma-separated clan ids, "all", or "" for
 * none. Kept dependency-free so the scan loop can ask without loading the
 * client. See docs/game-protocol.md.
 */
export function captureEnabledFor(setting: string, clanId: number): boolean {
  const s = setting.trim().toLowerCase();
  if (s === 'all') return true;
  return s.split(/[\s,]+/).filter(Boolean).map(Number).includes(clanId);
}
