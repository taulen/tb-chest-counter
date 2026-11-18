// A code request waiting between scans with no game session kept (the server
// restarted since the clan's last scan) asks the scan loop for a scan of that
// clan — once per clan per 10 minutes, never when a session is kept.
import { afterEach, describe, expect, it, vi } from 'vitest';

const waiting = vi.fn((_clanId: number) => true);
const kept = vi.fn((): number[] => []);
vi.mock('../../src/scheduler/chat-invites.js', () => ({
  hasWaitingInviteRequests: (clanId: number) => waiting(clanId),
  processInviteRequests: vi.fn(async () => ''),
}));
vi.mock('../../src/scheduler/event-poller.js', () => ({
  keptSessionClans: () => kept(),
  withKeptGameSession: vi.fn(async () => undefined),
}));

const { maybeScanForInvites, setInviteScanTrigger } = await import('../../src/scheduler/chat-capture.js');

describe('a waiting code request with no game session', () => {
  afterEach(() => {
    setInviteScanTrigger(null);
    waiting.mockReturnValue(true);
    kept.mockReturnValue([]);
  });

  it('asks for a scan of that clan, at most once per 10 minutes', () => {
    const trigger = vi.fn();
    setInviteScanTrigger(trigger);
    const t0 = 1_800_000_000_000;
    maybeScanForInvites(11, t0);
    maybeScanForInvites(11, t0 + 60_000);
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledWith(11);
    maybeScanForInvites(11, t0 + 10 * 60_000 + 1);
    expect(trigger).toHaveBeenCalledTimes(2);
  });

  it('does nothing while a session is kept (the poller answers within a minute) or nothing waits', () => {
    const trigger = vi.fn();
    setInviteScanTrigger(trigger);
    kept.mockReturnValue([12]);
    maybeScanForInvites(12, 1_900_000_000_000);
    kept.mockReturnValue([]);
    waiting.mockReturnValue(false);
    maybeScanForInvites(12, 1_900_000_000_000);
    expect(trigger).not.toHaveBeenCalled();
  });
});
