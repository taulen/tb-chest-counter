// A code request or a chat command waiting between scans with no game session
// kept (the server restarted since the clan's last scan) asks the scan loop
// for a scan of that clan — once per clan per 10 minutes, never when a
// session is kept.
import { afterEach, describe, expect, it, vi } from 'vitest';

const waiting = vi.fn((_clanId: number) => true);
const commandWaiting = vi.fn((_clanId: number) => false);
const kept = vi.fn((): number[] => []);
vi.mock('../../src/scheduler/chat-invites.js', () => ({
  hasWaitingInviteRequests: (clanId: number) => waiting(clanId),
  processInviteRequests: vi.fn(async () => ''),
  sendWelcomeCodes: vi.fn(async () => ''),
}));
vi.mock('../../src/scheduler/chat-commands.js', () => ({
  hasWaitingChatCommands: (clanId: number) => commandWaiting(clanId),
  processChatCommands: vi.fn(async () => ''),
  commandGroupRead: vi.fn(() => null),
}));
vi.mock('../../src/scheduler/event-poller.js', () => ({
  keptSessionClans: () => kept(),
  withKeptGameSession: vi.fn(async () => undefined),
}));

const { maybeScanForChatReplies, setChatReplyScanTrigger } = await import('../../src/scheduler/chat-capture.js');

describe('a waiting code request or chat command with no game session', () => {
  afterEach(() => {
    setChatReplyScanTrigger(null);
    waiting.mockReturnValue(true);
    commandWaiting.mockReturnValue(false);
    kept.mockReturnValue([]);
  });

  it('asks for a scan of that clan, at most once per 10 minutes', () => {
    const trigger = vi.fn();
    setChatReplyScanTrigger(trigger);
    const t0 = 1_800_000_000_000;
    maybeScanForChatReplies(11, t0);
    maybeScanForChatReplies(11, t0 + 60_000);
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledWith(11);
    maybeScanForChatReplies(11, t0 + 10 * 60_000 + 1);
    expect(trigger).toHaveBeenCalledTimes(2);
  });

  it('a waiting chat command does too (the first one after a deploy sat for a whole scan interval)', () => {
    const trigger = vi.fn();
    setChatReplyScanTrigger(trigger);
    waiting.mockReturnValue(false);
    commandWaiting.mockReturnValue(true);
    maybeScanForChatReplies(14, 2_000_000_000_000);
    expect(trigger).toHaveBeenCalledWith(14);
  });

  it('does nothing while a session is kept (the poller answers within a minute) or nothing waits', () => {
    const trigger = vi.fn();
    setChatReplyScanTrigger(trigger);
    kept.mockReturnValue([12]);
    commandWaiting.mockReturnValue(true);
    maybeScanForChatReplies(12, 1_900_000_000_000);
    kept.mockReturnValue([]);
    waiting.mockReturnValue(false);
    commandWaiting.mockReturnValue(false);
    maybeScanForChatReplies(12, 1_900_000_000_000);
    expect(trigger).not.toHaveBeenCalled();
  });
});
