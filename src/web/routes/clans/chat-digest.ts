import type { Router } from 'express';
import { getClanById } from '../../../data/repositories/clan-repo.js';
import {
  DIGEST_ENTRIES_MAX,
  DIGEST_ENTRIES_MIN,
  getChatDigestSettings,
  getPostableChannels,
  recentDigestPosts,
  requestTestPost,
  saveChatDigestSettings,
} from '../../../data/repositories/chat-digest-repo.js';
import { logAction } from '../../../data/repositories/user-repo.js';
import { assertPostableChannel, chatSendingDisabled } from '../../../game-protocol/chat-send.js';
import { previewChatDigest, resolveTargetChannel } from '../../../scheduler/chat-digest.js';
import { loadConfig } from '../../../config/index.js';
import { requireClanAdmin } from '../../middleware/auth.js';
import { createClanSubRouter } from './_shared.js';

/** Only named group chats the scanner account is in — never the clan, kingdom or private chats. */
function pickableChannels(clanId: number) {
  return getPostableChannels(clanId).filter((c) => {
    try {
      assertPostableChannel(c);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * The in-game chat digest (scheduler/chat-digest.ts): the daily digest posted
 * into one of the clan's group chats by its scanner account. Clan admins only
 * (requireClanAdmin — a plain member must not be able to make the account post).
 * Saving never posts; the test post is queued for the clan's next scan and
 * shares the one-message-a-day allowance with the scheduled post.
 */
export function createChatDigestRouter(): Router {
  const router = createClanSubRouter();

  router.get('/:clanId/chat-digest', requireClanAdmin, (req, res) => {
    const id = req.parsedClanId!;
    if (!getClanById(id)) {
      res.status(404).json({ error: 'Clan not found' });
      return;
    }
    const settings = getChatDigestSettings(id);
    const channels = pickableChannels(id);
    const target = resolveTargetChannel(settings, channels);
    res.json({
      settings,
      channels: channels.map((c) => ({ url: c.url, name: c.name, memberCount: c.memberCount })),
      // The chosen chat is one the account is in (null: not yet checked, or not a member).
      targetFound: target !== null,
      sendingDisabled: chatSendingDisabled(),
      limits: { entriesMin: DIGEST_ENTRIES_MIN, entriesMax: DIGEST_ENTRIES_MAX },
      preview: previewChatDigest(id, loadConfig().gameDayRolloverUtcHour),
      recent: recentDigestPosts(id, 7).map((p) => ({
        gameDate: p.gameDate, channelName: p.channelName, status: p.status, attempts: p.attempts,
        trigger: p.trigger, error: p.error, updatedAt: p.updatedAt,
      })),
    });
  });

  router.put('/:clanId/chat-digest', requireClanAdmin, (req, res) => {
    const id = req.parsedClanId!;
    if (!getClanById(id)) {
      res.status(404).json({ error: 'Clan not found' });
      return;
    }
    const body = req.body ?? {};
    const current = getChatDigestSettings(id);
    const entries = Number(body.entries ?? current.entries);
    const postUtcMinute = Number(body.postUtcMinute ?? current.postUtcMinute);
    if (!Number.isInteger(entries) || entries < DIGEST_ENTRIES_MIN || entries > DIGEST_ENTRIES_MAX) {
      res.status(400).json({ error: `entries must be ${DIGEST_ENTRIES_MIN}–${DIGEST_ENTRIES_MAX}` });
      return;
    }
    if (!Number.isInteger(postUtcMinute) || postUtcMinute < 0 || postUtcMinute > 1439) {
      res.status(400).json({ error: 'postUtcMinute must be 0–1439' });
      return;
    }
    // The chat must be one of the account's named group chats; the clan,
    // kingdom and private chats are never offered and never accepted.
    let channelUrl = current.channelUrl;
    let channelName = current.channelName;
    if (body.channelUrl !== undefined) {
      if (body.channelUrl === null || body.channelUrl === '') {
        channelUrl = null;
        channelName = '';
      } else {
        const chosen = pickableChannels(id).find((c) => c.url === body.channelUrl);
        if (!chosen) {
          res.status(400).json({ error: 'Pick one of the group chats the scanner account is in' });
          return;
        }
        channelUrl = chosen.url;
        channelName = chosen.name;
      }
    }
    const saved = saveChatDigestSettings(id, { enabled: !!(body.enabled ?? current.enabled), channelUrl, channelName, entries, postUtcMinute });
    logAction(req.user!.id, 'clan.chat_digest.update', { clanId: id, enabled: saved.enabled, channel: saved.channelName, entries, postUtcMinute });
    res.json({ ok: true, settings: saved });
  });

  /** Queue a test post of the latest closed day — it goes out with the clan's next scan. */
  router.post('/:clanId/chat-digest/test', requireClanAdmin, (req, res) => {
    const id = req.parsedClanId!;
    if (!getClanById(id)) {
      res.status(404).json({ error: 'Clan not found' });
      return;
    }
    if (chatSendingDisabled()) {
      res.status(409).json({ error: 'Chat sending is switched off on this server (CHAT_SEND_DISABLED)' });
      return;
    }
    const settings = getChatDigestSettings(id);
    if (!resolveTargetChannel(settings, pickableChannels(id))) {
      res.status(409).json({ error: 'Pick a group chat the scanner account is in first' });
      return;
    }
    const preview = previewChatDigest(id, loadConfig().gameDayRolloverUtcHour);
    if (preview.blocked) {
      res.status(409).json({ error: `Today's message is used up: ${preview.blocked.message}`, code: preview.blocked.code });
      return;
    }
    requestTestPost(id, req.user!.id);
    logAction(req.user!.id, 'clan.chat_digest.test', { clanId: id, gameDate: preview.gameDate });
    res.status(202).json({ ok: true, queued: true, gameDate: preview.gameDate });
  });

  return router;
}
