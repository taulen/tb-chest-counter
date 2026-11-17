/**
 * Listing a user's chat channels: the query must keep LITERAL commas between
 * custom types. URLSearchParams wrote "clanGroup%2Cwhisper", which the chat
 * service read as one type that matches nothing — private chats and named
 * group chats ("CWB • Carter") were never listed (Nov 2026).
 */
import { describe, expect, it } from 'vitest';
import { channelListQuery } from '../../src/game-protocol/chat.js';

describe('channel list query', () => {
  it('keeps the commas between custom types literal, as the game client sends them', () => {
    const q = channelListQuery(['privateSystemGroup', 'privateGroup', 'publicGroup']);
    expect(q).toContain('custom_types=privateSystemGroup,privateGroup,publicGroup');
    expect(q).not.toContain('%2C');
  });

  it('asks like the game client: every super / public mode, members shown, paging token passed', () => {
    const p = new URLSearchParams(channelListQuery(['whisper'], 'abc'));
    expect(p.get('super_mode')).toBe('all');
    expect(p.get('public_mode')).toBe('all');
    expect(p.get('member_state_filter')).toBe('all');
    expect(p.get('show_member')).toBe('true');
    expect(p.get('token')).toBe('abc');
    expect(p.get('custom_types')).toBe('whisper');
  });

  it('still encodes each type name on its own', () => {
    expect(channelListQuery(['a b'])).toContain('custom_types=a%20b');
  });
});
