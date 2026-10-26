// Clans (admin/superadmin) — single-page CRUD for clans. The in-app
// Total Battle login bridge that this page exposes via each clan card
// lives in lib/login-bridge.js (shared with the setup wizard). This
// module imports and re-exports the bridge action functions so the
// central dispatcher in app.js can keep its existing imports working.

import { $, escapeHtml, formatRelativeTime, notify, confirmDialog, promptDialog, contentModal } from '../lib/ui.js';
import { getCurrentUser, setWeekStart } from '../lib/state.js';
// The leaderboard's own threshold function, not a copy of it: the preview here
// and the hint above the board have to name the same integer, and an inlined
// `weekly * 0.66` already got that wrong once (round vs ceil).
import { goalWarnThreshold } from '../lib/leaderboard-render.js';
import {
  loginBridgePanelHTML,
  startLoginSession as _startLoginSession,
  saveLoginSession,
  cancelLoginSession,
  reloadLoginSession,
  pasteIntoLoginSession,
} from '../lib/login-bridge.js';
import { t, tn, tGame } from '../lib/i18n.js';

export { saveLoginSession, cancelLoginSession, reloadLoginSession, pasteIntoLoginSession };

// Inline icons (currentColor, theme-aware). The share pill shows the copy
// icon so the click-to-copy affordance is obvious; the analytics button
// shows a small chart glyph.
const COPY_ICON_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHART_ICON_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3v18h18"/><rect x="7" y="12" width="3" height="6"/><rect x="12" y="8" width="3" height="10"/><rect x="17" y="5" width="3" height="13"/></svg>';

// Handle to the most recent render context so the login-bridge onSaved
// callback can re-render the clan card after a save. startLoginSession is
// invoked from the global app.js dispatcher (which has no `el` reference),
// so without this the badge stayed "Needs re-authentication" until a full
// page reload even though save() had already cleared the flag server-side.
let activeRenderCtx = { el: null, refreshClanIndicator: null };

// clanId → the origin links for that clan are built on. A clan can live on its
// own domain (SIK on sinful.day), so a share link copied while browsing another
// clan's domain must still carry the domain its members actually use.
const clanOrigins = new Map();
function clanOrigin(clanId) {
  return clanOrigins.get(clanId) || window.location.origin;
}

/**
 * Adapter that dispatches the data-action="login-session-start" buttons
 * sitting on each clan card. The bridge renders as a centered modal over
 * the page (see loginBridgePanelHTML({ modal: true }) below), so there's
 * no per-card docking to do — just open the bridge.
 */
export function startLoginSession(clanId) {
  return _startLoginSession(clanId, {
    // Flip the auth badge to "Authenticated" the moment the save lands,
    // and toast the server's readiness message, instead of leaving a stale
    // "Needs re-authentication" card until the operator reloads.
    onSaved: (res) => {
      notify(res?.message || t('Login session saved.'), t('Login'));
      const { el, refreshClanIndicator } = activeRenderCtx;
      if (el) {
        renderClans(el, refreshClanIndicator);
        if (typeof refreshClanIndicator === 'function') refreshClanIndicator();
      }
    },
  });
}

// ─── renderClans ───

export async function renderClans(el, refreshClanIndicator) {
  // Remember the render context so a login-bridge save can re-render this
  // page (see startLoginSession's onSaved above).
  activeRenderCtx = { el, refreshClanIndicator };
  const currentUser = getCurrentUser();
  if (currentUser?.role !== 'superadmin' && currentUser?.role !== 'admin') {
    el.innerHTML = `<div class="empty-state"><p>${t('Admin access required.')}</p></div>`;
    return;
  }
  const isSuperAdmin = currentUser.role === 'superadmin';
  let clansData;
  try {
    clansData = await fetch('/api/clans').then((r) => r.json());
  } catch {
    el.innerHTML = `<div class="empty-state"><p>${t('Failed to load clans.')}</p></div>`;
    return;
  }
  const allClans = Array.isArray(clansData.clans) ? clansData.clans : [];
  // Superadmins have global access to every clan, but rendering all of
  // them stacked got unwieldy. Honor the header clan-picker selection
  // instead and show just the active clan's card — switching clans up
  // top swaps the card here, mirroring how every other tab behaves.
  const activeClanId = clansData.activeClanId ?? allClans[0]?.id ?? null;
  const defaultInactivityDays = Number.isFinite(clansData.defaultInactivityDays)
    ? clansData.defaultInactivityDays
    : null;
  const defaultPublicUrl = typeof clansData.defaultPublicUrl === 'string' ? clansData.defaultPublicUrl : '';
  for (const c of allClans) clanOrigins.set(c.id, c.publicUrl || defaultPublicUrl);
  // An admin with extra clans also gets one card — the active clan's, the
  // only one their admin rights currently reach.
  const clans = allClans.filter((c) => c.id === activeClanId);

  // Pull the global default scan interval so the per-clan input can
  // surface it as the placeholder. Superadmin-only — and the input
  // itself is also superadmin-only, so they line up.
  let defaultScanIntervalMinutes = null;
  if (isSuperAdmin) {
    try {
      const settings = await fetch('/api/admin/settings').then((r) => r.json());
      if (Number.isFinite(settings?.scanIntervalMinutes)) {
        defaultScanIntervalMinutes = settings.scanIntervalMinutes;
      }
    } catch {
      // Non-fatal — the input just falls back to a generic placeholder.
    }
  }

  el.innerHTML = `
    <p class="page-section-intro">${isSuperAdmin
      ? t("Each clan has its own member roster, chest data, browser session, Discord channel, and ChestTracker share code. The single-instance scanner cycles through every active clan in sequence on each scheduled interval.")
      : t("Manage your clan's Discord and ChestTracker integrations, refresh the Total Battle login session, and run member capture or first-scan onboarding.")}</p>

    <!-- Login bridge panel — shared with the setup wizard via
         lib/login-bridge.js. Rendered as a centered modal over the page
         (modal: true) and hidden until a per-clan "Log in to TB" button
         starts a session. Only one bridge runs at a time, so a single
         shared panel is enough; status text identifies which clan it
         belongs to. -->
    ${loginBridgePanelHTML({ modal: true, bonusLinks: true })}

    ${isSuperAdmin ? `
    <div class="card">
      <div class="card-header"><h2>${t('Add Clan')}</h2></div>
      <div class="card-body card-body-padded">
        <div class="inline-form-row">
          <div><label>${t('Clan name')}</label><input id="newClanName" class="input" type="text" placeholder="${t('e.g. Arcane Dawn')}"></div>
          <button class="btn btn-primary" data-action="clan-create">${t('Create')}</button>
        </div>
        <p class="muted-copy mt-12">${t("After creating, sign in to TB for the new clan via the in-app login bridge, then run member capture and the first scan from this page. Clan switching happens inside the game's canvas — every clan logs into the same TB domain.")}</p>
      </div>
    </div>
    ` : ''}

    ${clans.map((c) => renderClanCard(c, isSuperAdmin, defaultScanIntervalMinutes, defaultInactivityDays, defaultPublicUrl)).join('')}
  `;

  // Wire up create + per-clan controls. These actions are clan-page-
  // local, not routed through the global app.js dispatcher, since
  // they all need access to the el reference for re-rendering after
  // mutations.
  //
  // renderClans() runs again after every mutation (generate/disable/
  // recover/save…), and `el` (the page container) persists across those
  // re-renders — so a naive addEventListener would STACK a new listener
  // each time. That made a single click fire the handler N times: it
  // opened N analytics modals at once (backdrop darkened N× and needed N
  // outside-clicks to clear) and collapsed the two-step Disable into one
  // click (listener #1 arms it, listener #2 immediately sees it armed).
  // Removing the previous handler before adding the fresh one keeps
  // exactly one listener while still rebinding the current render's
  // closure (el / refreshClanIndicator).
  if (el._clanActionHandler) el.removeEventListener('click', el._clanActionHandler);
  el._clanActionHandler = async (ev) => {
    // Resolve to the nearest [data-action] ancestor, not the raw click
    // target — buttons contain icons/spans (e.g. the analytics button's SVG
    // + label), and clicking a child would otherwise miss the action.
    const clicked = ev.target;
    const target = clicked instanceof Element ? clicked.closest('[data-action]') : null;
    if (!(target instanceof HTMLElement)) return;
    const action = target.getAttribute('data-action');
    const clanIdAttr = target.getAttribute('data-clan-id');
    const clanId = clanIdAttr ? Number.parseInt(clanIdAttr, 10) : null;
    if (action === 'clan-create') {
      const name = $('#newClanName')?.value.trim();
      if (!name) return notify(t('Clan name is required.'), t('Create clan'));
      try {
        const r = await fetch('/api/clans', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        const j = await r.json();
        if (!r.ok) return notify(j.error || t('Create failed'), t('Create clan'));
        renderClans(el, refreshClanIndicator);
      } catch {
        notify(t('Create failed.'), t('Create clan'));
      }
    } else if (action === 'clan-rename' && clanId) {
      const nameInput = el.querySelector(`#clan-name-${clanId}`);
      const intervalInput = el.querySelector(`#clan-interval-${clanId}`);
      try {
        const body = {};
        if (nameInput?.value.trim()) body.name = nameInput.value.trim();
        if (intervalInput) {
          const v = intervalInput.value.trim();
          body.scanIntervalMinutes = v === '' ? null : Number(v);
        }
        const publicUrlInput = el.querySelector(`#clan-public-url-${clanId}`);
        if (publicUrlInput) body.publicUrl = publicUrlInput.value.trim();
        const r = await fetch(`/api/clans/${clanId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const j = await r.json();
        if (!r.ok) return notify(j.error || t('Save failed'), t('Save clan'));
        renderClans(el, refreshClanIndicator);
        if (typeof refreshClanIndicator === 'function') await refreshClanIndicator();
      } catch {
        notify(t('Save failed.'), t('Save clan'));
      }
    } else if (action === 'clan-discord-save' && clanId) {
      const body = {
        enabled: el.querySelector(`#clan-discord-enabled-${clanId}`).checked,
        token: el.querySelector(`#clan-discord-token-${clanId}`).value || undefined,
        channelId: el.querySelector(`#clan-discord-channel-${clanId}`).value,
        guildId: el.querySelector(`#clan-discord-guild-${clanId}`).value,
        scanReportsEnabled: el.querySelector(`#clan-discord-reports-${clanId}`).checked,
        onlyNewChests: el.querySelector(`#clan-discord-onlynew-${clanId}`).checked,
        dailyDigestEnabled: el.querySelector(`#clan-discord-digest-${clanId}`).checked,
        weeklyDigestEnabled: el.querySelector(`#clan-discord-weekly-${clanId}`).checked,
        // One input per recipient on the page; the server still stores (and
        // normalises) a comma-separated list.
        dailyDigestShareUserId: readRecipientIds(el, clanId).join(', '),
        commandsEnabled: el.querySelector(`#clan-discord-cmds-${clanId}`).checked,
      };
      // Strip the token field if blank — keeps the existing token in the DB.
      if (!body.token) delete body.token;
      try {
        const r = await fetch(`/api/clans/${clanId}/discord`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const j = await r.json();
        if (!r.ok) return notify(j.error || t('Discord save failed'), t('Discord'));
        // The recipient list is normalised server-side (mentions unwrapped,
        // duplicates and non-IDs dropped). Write it back so a silently
        // discarded entry is visible instead of looking saved.
        if (typeof j.digestShareUserId === 'string') {
          const submitted = body.dailyDigestShareUserId;
          setRecipientRows(el, clanId, j.digestShareUserId);
          if (submitted !== j.digestShareUserId) {
            notify(
              j.digestShareUserId
                ? t('Saved. DM recipients read as: {ids}', { ids: j.digestShareUserId })
                : t('Saved, but no valid Discord user ID was found — DM recipients are now empty.'),
              t('Discord'),
            );
            return;
          }
        }
        if (j.warning) notify(j.warning, t('Discord'));
        else notify(t('Discord settings saved.'), t('Discord'));
      } catch {
        notify(t('Discord save failed.'), t('Discord'));
      }
    } else if (action === 'clan-discord-add-recipient-row' && clanId) {
      addRecipientRow(el, clanId, '');
    } else if (action === 'clan-discord-remove-recipient' && clanId) {
      target.closest('.digest-recipient-row')?.remove();
    } else if (action === 'clan-discord-test' && clanId) {
      try {
        const r = await fetch(`/api/clans/${clanId}/discord/test`, { method: 'POST' });
        const j = await r.json();
        notify(j.ok ? t('Test message sent.') : t('Test failed: {error}', { error: j.error || t('unknown') }), t('Discord test'));
      } catch {
        notify(t('Test failed.'), t('Discord test'));
      }
    } else if (action === 'clan-discord-digest-dm-test' && clanId) {
      try {
        const r = await fetch(`/api/clans/${clanId}/discord/digest-dm-test`, { method: 'POST' });
        const j = await r.json();
        notify(j.ok
          ? (j.message || t('Digest DM sent.'))
          : t('DM test failed: {error}', { error: j.error || t('unknown') }), t('Digest DM test'));
      } catch {
        notify(t('DM test failed.'), t('Digest DM test'));
      }
    } else if (action === 'clan-ct-save' && clanId) {
      const body = {
        shareCode: el.querySelector(`#clan-ct-code-${clanId}`).value.trim(),
        pollIntervalHours: parseFloat(el.querySelector(`#clan-ct-interval-${clanId}`).value) || null,
        backfillWeeks: parseInt(el.querySelector(`#clan-ct-backfill-${clanId}`).value, 10) || null,
      };
      try {
        const r = await fetch(`/api/clans/${clanId}/chesttracker`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const j = await r.json();
        if (!r.ok) return notify(j.error || t('ChestTracker save failed'), t('ChestTracker'));
        notify(t('ChestTracker settings saved.'), t('ChestTracker'));
      } catch {
        notify(t('ChestTracker save failed.'), t('ChestTracker'));
      }
    } else if (action === 'clan-resources-collect' && clanId) {
      await runClanResourceCollect(clanId, {});
    } else if (action === 'clan-resources-collect-dry' && clanId) {
      await runClanResourceCollect(clanId, { dryRun: true });
    } else if (action === 'clan-resources-collect-full' && clanId) {
      const ok = await confirmDialog(
        t('This ignores the saved position and re-reads all 14 days. Rows already recorded will be inserted again, which shows up as duplicates you clean up by deleting the extra batch in Resources → Upload History. Use it after fixing a reading bug, not routinely.'),
        { title: t('Re-read all 14 days?'), confirmLabel: t('Read everything'), danger: true },
      );
      if (ok) await runClanResourceCollect(clanId, { fullBackfill: true });
    } else if (action === 'clan-resources-debug-shots' && clanId) {
      await loadClanResourceDebugShots(clanId);
    } else if (action === 'clan-resources-save' && clanId) {
      const enabled = !!el.querySelector(`#clan-resources-enabled-${clanId}`)?.checked;
      const autoCapture = !!el.querySelector(`#clan-resources-auto-${clanId}`)?.checked;
      try {
        const r = await fetch(`/api/clans/${clanId}/resources`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled, autoCapture }),
        });
        const j = await r.json();
        if (!r.ok) return notify(j.error || t('Save failed'), t('Resource Tracking'));
        notify(t('Resource Tracking settings saved.'), t('Resource Tracking'));
        if (typeof window.refreshResourcesNavVisibility === 'function') {
          window.refreshResourcesNavVisibility();
        }
      } catch {
        notify(t('Save failed.'), t('Resource Tracking'));
      }
    } else if (action === 'clan-inactivity-save' && clanId) {
      const enabled = !!el.querySelector(`#clan-inactivity-enabled-${clanId}`)?.checked;
      const raw = el.querySelector(`#clan-inactivity-${clanId}`).value.trim();
      const body = { enabled, inactivityDays: raw === '' ? null : Number(raw) };
      try {
        const r = await fetch(`/api/clans/${clanId}/inactivity`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const j = await r.json();
        if (!r.ok) return notify(j.error || t('Save failed'), t('Member management'));
        notify(t('Member management settings saved.'), t('Member management'));
      } catch {
        notify(t('Save failed.'), t('Member management'));
      }
    } else if (action === 'clan-week-start-save' && clanId) {
      const weekStart = el.querySelector(`#clan-week-start-${clanId}`)?.value;
      try {
        const r = await fetch(`/api/clans/${clanId}/week-start`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ weekStart }),
        });
        const j = await r.json();
        if (!r.ok) return notify(j.error || t('Save failed'), t('Week'));
        // Week windows read the shape from lib/state.js on every render, so
        // updating it here makes the next page visited use the new weeks
        // without a reload — when this is the clan being viewed.
        if (getCurrentUser()?.activeClan?.id === clanId) {
          setWeekStart(weekStart);
        }
        notify(t('Week saved.'), t('Week'));
      } catch {
        notify(t('Save failed.'), t('Week'));
      }
    } else if (action === 'clan-goal-save' && clanId) {
      const enabled = !!el.querySelector(`#clan-goal-enabled-${clanId}`)?.checked;
      const raw = el.querySelector(`#clan-goal-points-${clanId}`).value.trim();
      const body = { enabled, weeklyPoints: raw === '' ? null : Number(raw) };
      try {
        const r = await fetch(`/api/clans/${clanId}/leaderboard-goal`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const j = await r.json();
        if (!r.ok) return notify(j.error || t('Save failed'), t('Leaderboard goal'));
        notify(t('Leaderboard goal saved.'), t('Leaderboard goal'));
        updateGoalPreview(el, clanId);
      } catch {
        notify(t('Save failed.'), t('Leaderboard goal'));
      }
    } else if (action === 'clan-share-create' && clanId) {
      // A clan holds as many live links as it wants, so this only ever ADDS
      // one — rotating a link is "add the replacement, disable the old one
      // once it has gone quiet", which never strands anyone mid-flight.
      const keyEl = el.querySelector(`#clan-share-key-${clanId}`);
      const labelEl = el.querySelector(`#clan-share-label-${clanId}`);
      const body = {
        key: keyEl ? keyEl.value.trim() : '',
        label: labelEl ? labelEl.value.trim() : '',
      };
      target.disabled = true;
      try {
        const r = await fetch(`/api/clans/${clanId}/share-links`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const j = await r.json();
        if (!r.ok) {
          target.disabled = false;
          return notify(j.error || t('Failed to create share link'), t('Share link'));
        }
        renderClans(el, refreshClanIndicator);
      } catch {
        target.disabled = false;
        notify(t('Failed to create share link.'), t('Share link'));
      }
    } else if (action === 'clan-share-rename' && clanId) {
      const linkId = Number.parseInt(target.getAttribute('data-link-id'), 10);
      if (!Number.isInteger(linkId)) return;
      const name = await promptDialog(t('Name this link — for your own reference only; visitors never see it.'), {
        title: t('Name share link'),
        defaultValue: target.getAttribute('data-label') || '',
      });
      if (name === null) return;
      try {
        const r = await fetch(`/api/clans/${clanId}/share-links/${linkId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: name }),
        });
        const j = await r.json();
        if (!r.ok) return notify(j.error || t('Rename failed'), t('Share link'));
        renderClans(el, refreshClanIndicator);
      } catch {
        notify(t('Rename failed.'), t('Share link'));
      }
    } else if (action === 'clan-share-disable' && clanId) {
      // Two-step confirm. The first click arms the button ("Click again to
      // confirm") for a few seconds; only a second click opens the dialog.
      // Guards against a stray click wiping a link others may be using.
      const linkId = Number.parseInt(target.getAttribute('data-link-id'), 10);
      if (!Number.isInteger(linkId)) return;
      if (target.dataset.armed !== '1') {
        armDisableButton(target);
        return;
      }
      disarmButton(target);
      const ok = await confirmDialog(
        t('Disable this share link? The URL stops working immediately and the clan’s other links are unaffected. It keeps its history and can be restored later from “Analytics & history”.'),
        { title: t('Disable share link'), confirmLabel: t('Disable'), danger: true },
      );
      if (!ok) return;
      try {
        const r = await fetch(`/api/clans/${clanId}/share-links/${linkId}`, { method: 'DELETE' });
        const j = await r.json();
        if (!r.ok) return notify(j.error || t('Failed to disable share link'), t('Share link'));
        renderClans(el, refreshClanIndicator);
      } catch {
        notify(t('Failed to disable share link.'), t('Share link'));
      }
    } else if (action === 'clan-share-analytics' && clanId) {
      openShareAnalytics(clanId, el, refreshClanIndicator);
    } else if (action === 'clan-share-copy' && clanId) {
      // The pill is per-link now, so copy from the one that was clicked —
      // a per-clan id would always have copied the first link in the list.
      const field = target.closest('.share-url-pill');
      if (!field) return;
      const url = field.getAttribute('data-share-url') || '';
      try {
        await navigator.clipboard.writeText(url);
      } catch {
        // Fallback for browsers/contexts without clipboard API.
        const tmp = document.createElement('textarea');
        tmp.value = url;
        document.body.appendChild(tmp);
        tmp.select();
        try { document.execCommand('copy'); } catch {}
        tmp.remove();
      }
      // Flash the hint label (not the whole pill) so the URL text + copy
      // icon stay put while "Copied!" confirms the action.
      const hint = field.querySelector('.share-url-hint');
      field.classList.add('is-copied');
      if (hint) hint.textContent = t('✓ Copied!');
      clearTimeout(field._copyTimer);
      field._copyTimer = setTimeout(() => {
        field.classList.remove('is-copied');
        if (hint) hint.textContent = t('Click to copy');
      }, 1400);
    } else if (action === 'clan-delete' && clanId) {
      const clanName = target.getAttribute('data-clan-name') || '';
      const ok = await confirmDialog(
        t('Delete clan "{clan}"? It disappears from the clan picker, the scanner, Discord and its public share link, and its members can no longer sign in to it.\n\nIts data — members, scans, chests, resources, settings — is KEPT, and a superadmin can put the clan back from System → Deleted Clans.', { clan: clanName }),
        {
          title: t('Delete clan "{clan}"', { clan: clanName }),
          confirmLabel: t('Continue'),
          cancelLabel: t('Cancel'),
          danger: true,
        },
      );
      if (!ok) return;
      // Second-step confirmation: type the clan name to proceed. Kept even
      // though the delete is now reversible — the disruptive half isn't the
      // data, it's that everyone in the clan is locked out until someone
      // notices, and that still shouldn't happen to the wrong clan by a
      // muscle-memory click.
      const typed = await promptDialog(
        t('To confirm, type the clan name exactly: {clan}', { clan: clanName }),
        {
          title: t('Delete clan "{clan}"', { clan: clanName }),
          confirmLabel: t('Delete clan'),
          cancelLabel: t('Cancel'),
        },
      );
      if (typed === null) return;
      if (String(typed).trim() !== clanName) {
        return notify(t('Name did not match — clan was not deleted.'), t('Delete clan'));
      }
      try {
        const r = await fetch(`/api/clans/${clanId}`, { method: 'DELETE' });
        const j = await r.json();
        if (!r.ok) return notify(j.error || t('Delete failed'), t('Delete clan'));
        renderClans(el, refreshClanIndicator);
      } catch {
        notify(t('Delete failed.'), t('Delete clan'));
      }
    } else if (action === 'clan-discord-directory-load' && clanId) {
      await loadDiscordDirectory(el, clanId, el.querySelector(`#clan-discord-guild-${clanId}`)?.value || undefined);
    } else if (action === 'clan-discord-manual-toggle' && clanId) {
      // The checkbox has already flipped by the time the click lands here.
      if (target.checked) discordManualMode.add(clanId);
      else discordManualMode.delete(clanId);
      syncDiscordPickers(el, clanId);
    } else if (action === 'clan-onboard-capture' && clanId) {
      try {
        const r = await fetch(`/api/clans/${clanId}/onboard/capture-members`, { method: 'POST' });
        const j = await r.json();
        if (!r.ok) return notify(j.error || t('Capture failed'), t('Capture members'));
        pollClanOnboardStatus(clanId, el);
      } catch {
        notify(t('Capture failed.'), t('Capture members'));
      }
    } else if (action === 'clan-onboard-firstscan' && clanId) {
      try {
        const r = await fetch(`/api/clans/${clanId}/onboard/first-scan`, { method: 'POST' });
        const j = await r.json();
        if (!r.ok) return notify(j.error || t('Scan failed'), t('First scan'));
        pollClanOnboardStatus(clanId, el);
      } catch {
        notify(t('Scan failed.'), t('First scan'));
      }
    }
  };
  el.addEventListener('click', el._clanActionHandler);

  // The Discord pickers are <select>s, which never fire a click-with-intent —
  // same single-listener discipline as above, since `el` outlives the render.
  if (el._clanChangeHandler) el.removeEventListener('change', el._clanChangeHandler);
  el._clanChangeHandler = async (ev) => {
    const changed = ev.target;
    const target = changed instanceof Element ? changed.closest('[data-action]') : null;
    if (!(target instanceof HTMLElement)) return;
    const action = target.getAttribute('data-action');
    const clanIdAttr = target.getAttribute('data-clan-id');
    const clanId = clanIdAttr ? Number.parseInt(clanIdAttr, 10) : null;
    if (!clanId) return;
    if (action === 'clan-discord-guild-change') {
      // Channels and members are per-server, so switching server invalidates
      // both. Clear the channel rather than carry a selection that belongs to
      // the old server — that mismatch is precisely the silent misconfiguration
      // the dropdowns exist to prevent.
      const channel = el.querySelector(`#clan-discord-channel-${clanId}`);
      if (channel) channel.value = '';
      await loadDiscordDirectory(el, clanId, target.value || undefined);
    } else if (action === 'clan-discord-add-recipient') {
      const picked = target.value;
      target.value = '';
      if (!picked) return;
      if (readRecipientIds(el, clanId).includes(picked)) return;
      addRecipientRow(el, clanId, picked);
    }
  };
  el.addEventListener('change', el._clanChangeHandler);

  // Recipient rows come and go after render (Add / Remove), so their name
  // lookup listens on `el` rather than on each input.
  if (el._clanInputHandler) el.removeEventListener('input', el._clanInputHandler);
  el._clanInputHandler = (ev) => {
    const input = ev.target;
    if (!(input instanceof HTMLInputElement) || !input.classList.contains('digest-recipient-input')) return;
    const clanId = Number.parseInt(input.getAttribute('data-clan-id') || '', 10);
    if (clanId) updateRecipientNames(el, clanId);
  };
  el.addEventListener('input', el._clanInputHandler);

  // Kick off a status poll for any clan currently mid-onboarding so the
  // status pill ("Capturing members…", "Running first scan…") refreshes
  // automatically without a page reload.
  for (const clan of clans) {
    pollClanOnboardStatus(clan.id, el);
    // Populate the Discord dropdowns without being asked. The lookup is a
    // read of the clan's own bot and is cached server-side for a minute, so
    // the re-render after every mutation on this page costs nothing.
    if (clan.discordTokenSet) void loadDiscordDirectory(el, clan.id);
  }

  // Show what a weekly target works out to per day / month / year, live as
  // it's typed. The scaling is invisible otherwise — an admin types 25000 and
  // has no way to know whether the Daily tab will judge people against 3,571
  // or something else until they go and look. Listeners are attached to the
  // freshly-rendered inputs, so the re-render replaces them; nothing stacks.
  for (const clan of clans) {
    const input = el.querySelector(`#clan-goal-points-${clan.id}`);
    if (input) input.addEventListener('input', () => updateGoalPreview(el, clan.id));
    const week = el.querySelector(`#clan-week-start-${clan.id}`);
    if (week) week.addEventListener('change', () => updateGoalPreview(el, clan.id));
    updateGoalPreview(el, clan.id);
  }
}

/**
 * Render the derived-goal line under the weekly-goal input.
 *
 * The per-period division is restated here (it's `weekly / weekDays * days`,
 * with weekDays 6 or 7 from the Week select, and the page has no period state
 * to feed scaleGoalForPeriod), but the amber cutoff
 * comes from the leaderboard's own goalWarnThreshold — that one is NOT safe to
 * restate, because the naive `weekly * 0.66` this used to do disagreed with the
 * board by one point for about half of all goals.
 */
function updateGoalPreview(el, clanId) {
  const out = el.querySelector(`#clan-goal-preview-${clanId}`);
  if (!out) return;
  const raw = el.querySelector(`#clan-goal-points-${clanId}`)?.value.trim() ?? '';
  const weekly = raw === '' ? null : Number(raw);
  if (weekly === null || !Number.isFinite(weekly) || weekly <= 0) {
    out.textContent = '';
    return;
  }
  // The week shape as currently SELECTED, saved or not, so the preview answers
  // "what would this goal mean" while the admin is still choosing.
  const weekDays = el.querySelector(`#clan-week-start-${clanId}`)?.value === 'ancients' ? 6 : 7;
  const per = (days) => Math.round((weekly / weekDays) * days).toLocaleString();
  out.innerHTML = t('Works out to <strong>{day}</strong> / day ({weekDays}-day week), <strong>{month}</strong> / month, <strong>{year}</strong> / year. Amber starts at 66% of each (<strong>{week}</strong> for the week).', {
    day: per(1),
    weekDays,
    month: per(30),
    year: per(365),
    week: goalWarnThreshold(weekly).toLocaleString(),
  });
}

/**
 * Render the "Last digest" status block under the Discord section.
 * Mirrors the existing chest-type pill style:
 *   - empty (no run yet) → muted "never run" line so admins know
 *     the bar exists but isn't broken
 *   - both errors empty → green pill with relative timestamp
 *   - either step failed → red pill listing each step's error
 *
 * Channel and DM are tracked independently because their failure
 * modes have different remediations (bad channel id / lost
 * permission vs recipient blocking DMs).
 */
function renderDigestStatus(clan) {
  if (!clan.discordEnabled) return '';
  return renderDailyDigestStatus(clan) + renderWeeklyDigestStatus(clan);
}

function renderDailyDigestStatus(clan) {
  if (!clan.discordDailyDigestEnabled) return '';
  if (!clan.lastDigestAt) {
    return `<p class="muted-copy digest-status-line">${t('Last digest: never run yet — sends after the first scan following the next rollover.')}</p>`;
  }
  const when = formatRelativeTime(clan.lastDigestAt);
  const channelOk = !clan.lastDigestChannelError;
  const dmConfigured = !!clan.discordDailyDigestShareUserId;
  const dmOk = !dmConfigured || !clan.lastDigestDmError;
  const allOk = channelOk && dmOk;
  if (allOk) {
    return `<p class="digest-status-line"><span class="chest-type uncommon">${t('Last digest: ✓ {when}', { when: escapeHtml(when) })}</span></p>`;
  }
  const parts = [];
  if (!channelOk) parts.push(t('Channel post failed — {error}', { error: escapeHtml(clan.lastDigestChannelError) }));
  if (dmConfigured && !dmOk) parts.push(t('DM failed — {error}', { error: escapeHtml(clan.lastDigestDmError) }));
  return `
    <p class="digest-status-line">
      <span class="chest-type common">${t('Last digest: ⚠ {when}', { when: escapeHtml(when) })}</span>
    </p>
    <ul class="muted-copy digest-status-errors">
      ${parts.map((p) => `<li>${p}</li>`).join('')}
    </ul>
  `;
}

/** The weekly digest's line: same pills, one combined error string. */
function renderWeeklyDigestStatus(clan) {
  if (!clan.discordWeeklyDigestEnabled) return '';
  if (!clan.lastWeeklyDigestAt) {
    const never = clan.weekStart === 'ancients'
      ? t('Last weekly digest: never run yet — sends after the first scan once the current Tinman week ends.')
      : t('Last weekly digest: never run yet — sends after the first scan once the current week ends.');
    return `<p class="muted-copy digest-status-line">${never}</p>`;
  }
  const when = formatRelativeTime(clan.lastWeeklyDigestAt);
  const label = clan.lastWeeklyDigestWeek ? ` ${t('(week of {week})', { week: escapeHtml(clan.lastWeeklyDigestWeek) })}` : '';
  if (!clan.lastWeeklyDigestError) {
    return `<p class="digest-status-line"><span class="chest-type uncommon">${t('Last weekly digest: ✓ {when}', { when: escapeHtml(when) })}${label}</span></p>`;
  }
  return `
    <p class="digest-status-line">
      <span class="chest-type common">${t('Last weekly digest: ⚠ {when}', { when: escapeHtml(when) })}${label}</span>
    </p>
    <ul class="muted-copy digest-status-errors">
      ${clan.lastWeeklyDigestError.split(' · ').map((p) => `<li>${escapeHtml(p)}</li>`).join('')}
    </ul>
  `;
}

// Three states: never signed in, signed in but cookies expired (needs
// re-auth), and signed in with valid-looking cookies. The middle state
// only flips on when the auth-check phase confirms the canvas wouldn't
// load on the last scan — it's a real "do something" indicator, not a
// "maybe expired" guess.
function renderAuthBadge(clan) {
  if (clan.needsReauth) {
    const when = clan.reauthFailedAt ? formatRelativeTime(clan.reauthFailedAt) : '';
    const tip = when
      ? t('Last scan {when} could not load the Total Battle canvas with the saved session. Click Refresh login.', { when: escapeHtml(when) })
      : t('The saved Total Battle session no longer loads the game canvas. Click Refresh login.');
    return `<span class="chest-type common" title="${tip}">${t('Needs re-authentication')}</span>`;
  }
  if (clan.authenticated) {
    return `<span class="chest-type uncommon" title="${t('A storage-state file exists for this clan and the most recent scan was able to load the game.')}">${t('Authenticated')}</span>`;
  }
  return `<span class="chest-type common" title="${t('No storage-state file on disk. The scanner will skip this clan until you log in.')}">${t('Not authenticated')}</span>`;
}

function renderAuthCopy(clan) {
  if (clan.needsReauth) {
    return t("The scanner could not load the Total Battle canvas with this clan's saved session on the last run — cookies have likely expired. Re-authenticate below to resume scans.");
  }
  if (clan.authenticated) {
    return t('A previous login was saved for this clan. If scans fail with auth errors, refresh the session below.');
  }
  return t('No login saved yet. Sign in below before activating this clan for scans.');
}

// ─── Discord server / channel / member pickers ───
//
// The three Discord fields (guild, channel, digest DM recipients) are all
// snowflakes, and the old form asked the operator to produce them by hand:
// switch Developer Mode on, right-click the server icon, right-click the
// channel, right-click each recipient. Every one of those is an 18-digit
// number with no feedback if it lands in the wrong field — the bot connects
// happily and simply never posts.
//
// So the bot reads its own view of Discord (POST /discord/directory) and the
// fields become dropdowns of names. Two rules hold this together:
//
//  1. The <select> carries the SAME element id the save handler reads
//     (`clan-discord-guild-N` / `clan-discord-channel-N`). A select's .value
//     is a string like an input's, so nothing downstream knows the
//     difference, and manual mode can swap a text input straight back in.
//  2. A stored id that isn't in the fetched list is never silently dropped —
//     it renders as its own selected option. A bot removed from a server, or
//     a lookup that failed, must not quietly blank a working configuration
//     the moment someone opens the page.

/** clanId → last successful directory response. Survives re-renders. */
const discordDirectories = new Map();
/** clanIds where the operator asked for raw ID entry instead of dropdowns. */
const discordManualMode = new Set();

/**
 * One Server/Channel field: a <select> of names, or a plain text input when
 * `entries` is null (manual mode, or nothing loaded from Discord yet).
 */
function renderDiscordPicker(clanId, kind, storedValue, entries, placeholder) {
  const id = `clan-discord-${kind}-${clanId}`;
  const value = storedValue || '';
  if (!entries) {
    return `<input id="${id}" class="input" type="text" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}">`;
  }
  const known = entries.some((e) => e.id === value);
  let options = `<option value=""${value ? '' : ' selected'}>${t('— none —')}</option>`;
  // A configured id the list doesn't contain still has to be selectable, or
  // opening the page would silently clear it on the next save.
  if (value && !known) {
    options += `<option value="${escapeHtml(value)}" selected>${t('{id} (not in this list)', { id: escapeHtml(value) })}</option>`;
  }
  const groups = new Map();
  for (const entry of entries) {
    const group = entry.categoryName || '';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(entry);
  }
  for (const [group, items] of groups) {
    const body = items
      .map((e) => `<option value="${escapeHtml(e.id)}"${e.id === value ? ' selected' : ''}>${escapeHtml(pickerLabel(kind, e))}</option>`)
      .join('');
    options += group ? `<optgroup label="${escapeHtml(group)}">${body}</optgroup>` : body;
  }
  return `<select id="${id}" class="input" data-action="clan-discord-${kind}-change" data-clan-id="${clanId}">${options}</select>`;
}

function pickerLabel(kind, entry) {
  if (kind === 'channel') return `#${entry.name}`;
  return entry.name;
}

// ─── Digest DM recipients: one input per person ───
//
// Stored server-side as one comma-separated string (normalised by
// digest-recipients.ts); on the page each recipient is its own row with its
// own resolved name and Remove button, so twenty IDs are no longer one
// unreadable line to edit by cursor.

function splitRecipientIds(raw) {
  return String(raw || '')
    .split(/[\s,;]+/)
    .map((s) => s.replace(/^<@!?/, '').replace(/>$/, '').trim())
    .filter(Boolean);
}

function renderRecipientRow(clanId, id) {
  return `<div class="digest-recipient-row">
    <input class="input digest-recipient-input" type="text" inputmode="numeric" data-clan-id="${clanId}"
      value="${escapeHtml(id)}" placeholder="${t('Discord user ID, e.g. 123456789012345678')}" aria-label="${t('Discord user ID')}">
    <span class="muted-copy hint-text digest-recipient-name"></span>
    <button type="button" class="btn btn-sm btn-danger" data-action="clan-discord-remove-recipient" data-clan-id="${clanId}">${t('Remove')}</button>
  </div>`;
}

function renderRecipientRows(clanId, raw) {
  return splitRecipientIds(raw).map((id) => renderRecipientRow(clanId, id)).join('');
}

/** Every non-blank recipient input, in order, mentions unwrapped. */
function readRecipientIds(el, clanId) {
  const inputs = el.querySelectorAll(`#clan-discord-recipients-${clanId} .digest-recipient-input`);
  return splitRecipientIds(Array.from(inputs, (i) => i.value).join(','));
}

function setRecipientRows(el, clanId, raw) {
  const list = el.querySelector(`#clan-discord-recipients-${clanId}`);
  if (!list) return;
  list.innerHTML = renderRecipientRows(clanId, raw);
  updateRecipientNames(el, clanId);
}

/** Append a row (filling the first blank one instead, if there is one). */
function addRecipientRow(el, clanId, id) {
  const list = el.querySelector(`#clan-discord-recipients-${clanId}`);
  if (!list) return;
  const blank = id ? Array.from(list.querySelectorAll('.digest-recipient-input')).find((i) => !i.value.trim()) : null;
  if (blank) {
    blank.value = id;
  } else {
    list.insertAdjacentHTML('beforeend', renderRecipientRow(clanId, id));
  }
  updateRecipientNames(el, clanId);
  if (!id) list.querySelector('.digest-recipient-row:last-child .digest-recipient-input')?.focus();
}

/**
 * The "add a DM recipient" dropdown. Picking a name adds a recipient row
 * holding that ID; the rows stay plain inputs because they are also the
 * escape hatch for someone who is in the server but whom the member lookup
 * can't see (no privileged intent).
 */
function renderRecipientPicker(clanId, dir, manual) {
  if (manual || !dir) return '';
  if (dir.membersUnavailable) {
    return `<p class="muted-copy mt-4 hint-text">${escapeHtml(dir.membersUnavailable)}</p>`;
  }
  if (!dir.members || !dir.members.length) return '';
  const options = dir.members
    .map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}${m.username && m.username !== m.name ? ` (@${escapeHtml(m.username)})` : ''}</option>`)
    .join('');
  return `<select class="input mt-4" data-action="clan-discord-add-recipient" data-clan-id="${clanId}">`
    + `<option value="">${t('+ Add a recipient from {server}…', { server: escapeHtml(dir.guildName || t('the server')) })}</option>${options}</select>`;
}

/**
 * Re-render the three pickers in place from the cached directory, keeping
 * whatever the form currently holds. Deliberately NOT a full renderClans():
 * that would blow away a bot token typed but not yet saved, which is exactly
 * the moment the operator is most likely to hit "load from Discord".
 */
function syncDiscordPickers(el, clanId) {
  const manual = discordManualMode.has(clanId);
  const dir = manual ? null : discordDirectories.get(clanId) || null;
  const guildField = el.querySelector(`#clan-discord-guild-field-${clanId}`);
  const channelField = el.querySelector(`#clan-discord-channel-field-${clanId}`);
  if (!guildField || !channelField) return;
  const guildValue = el.querySelector(`#clan-discord-guild-${clanId}`)?.value ?? '';
  const channelValue = el.querySelector(`#clan-discord-channel-${clanId}`)?.value ?? '';
  guildField.innerHTML = renderDiscordPicker(clanId, 'guild', guildValue, dir?.guilds ?? null, t('Server ID'));
  // Channels belong to one server. If the loaded directory is for a different
  // server than the one now selected, offer no list rather than a list of
  // channels that cannot receive this clan's messages.
  const channels = dir && dir.guildId && dir.guildId === guildValue ? dir.channels : null;
  channelField.innerHTML = renderDiscordPicker(clanId, 'channel', channelValue, channels, t('Channel ID'));
  const memberField = el.querySelector(`#clan-discord-member-field-${clanId}`);
  if (memberField) {
    const forThisGuild = dir && dir.guildId && dir.guildId === guildValue ? dir : null;
    memberField.innerHTML = renderRecipientPicker(clanId, forThisGuild, manual);
  }
  updateRecipientNames(el, clanId);
}

/**
 * Resolve each recipient row's ID to a name beside it. An ID that resolves to
 * nothing is called out rather than left looking configured — a mistyped
 * digit otherwise costs a silent daily DM.
 */
function updateRecipientNames(el, clanId) {
  const rows = el.querySelectorAll(`#clan-discord-recipients-${clanId} .digest-recipient-row`);
  const dir = discordDirectories.get(clanId);
  const byId = dir?.members?.length ? new Map(dir.members.map((m) => [m.id, m.name])) : null;
  for (const row of rows) {
    const out = row.querySelector('.digest-recipient-name');
    if (!out) continue;
    const id = splitRecipientIds(row.querySelector('.digest-recipient-input')?.value)[0] || '';
    if (!id || !byId) {
      out.textContent = '';
    } else if (byId.has(id)) {
      out.textContent = byId.get(id);
    } else {
      out.innerHTML = `<span class="warning-text">${t('not found in this server')}</span>`;
    }
  }
}

/**
 * Ask the server to read the bot's Discord. Sends the token currently in the
 * form when there is one, so the lists work before the first save; the server
 * falls back to the stored token and never persists what is sent here.
 */
async function loadDiscordDirectory(el, clanId, guildId) {
  const status = el.querySelector(`#clan-discord-dir-status-${clanId}`);
  const setStatus = (text) => { if (status) status.textContent = text; };
  const token = el.querySelector(`#clan-discord-token-${clanId}`)?.value.trim() || '';
  setStatus(t('Reading from Discord…'));
  try {
    const r = await fetch(`/api/clans/${clanId}/discord/directory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token || undefined, guildId: guildId || undefined }),
    });
    const j = await r.json();
    if (!r.ok) {
      setStatus(j.error || t('Discord lookup failed.'));
      return;
    }
    const guildName = j.guilds?.find((g) => g.id === j.guildId)?.name || '';
    discordDirectories.set(clanId, { ...j, guildName });
    // The server list is pinned for a clan admin (see the directory route).
    // Say so, or a one-entry dropdown reads as "the bot is only in one
    // server" and the next question is why the other one disappeared.
    const pinned = j.scopedToGuildId ? ` ${t('Server locked to your clan — a superadmin can move it.')}` : '';
    if (!j.guilds?.length) {
      setStatus(t('This bot has not been invited to any server yet — run the OAuth2 invite URL first.'));
    } else if (!j.guildId) {
      setStatus(tn(j.guilds.length, '{n} server — pick one to load its channels.', '{n} servers — pick one to load its channels.'));
    } else {
      setStatus(tn(j.channels.length, '{n} channel in {server}', '{n} channels in {server}', { server: guildName })
        + (j.membersUnavailable ? '' : `, ${tn(j.members.length, '{n} member', '{n} members')}`) + '.' + pinned);
    }
    syncDiscordPickers(el, clanId);
  } catch {
    setStatus(t('Discord lookup failed.'));
  }
}

function renderClanCard(clan, isSuperAdmin, defaultScanIntervalMinutes, defaultInactivityDays, defaultPublicUrl) {
  const intervalVal = clan.scanIntervalMinutes ?? '';
  const intervalPlaceholder = Number.isFinite(defaultScanIntervalMinutes)
    ? t('default: {value}', { value: defaultScanIntervalMinutes })
    : t('blank = global default');
  const inactivityPlaceholder = Number.isFinite(defaultInactivityDays)
    ? t('blank = global default ({days})', { days: defaultInactivityDays })
    : t('blank = global default');
  // discordTokenSet: `true` when the server has a token on file. We
  // never round-trip the actual token to the browser; the input is
  // empty by default and only updates the stored token if non-empty.
  const tokenPlaceholder = clan.discordTokenSet ? t('••••••••• (leave blank to keep)') : t('Bot token');
  // Names already read from Discord, so a re-render (every save, every
  // mutation on this page) redraws the dropdowns populated instead of
  // flashing back to bare ID boxes while the refetch is in flight.
  const cachedDir = discordManualMode.has(clan.id) ? null : discordDirectories.get(clan.id) ?? null;
  const cachedChannels = cachedDir && cachedDir.guildId && cachedDir.guildId === clan.discordGuildId
    ? cachedDir.channels
    : null;
  return `
    <div class="card" data-clan-card-id="${clan.id}">
      <div class="card-header">
        <h2>${escapeHtml(clan.name)} <span class="muted-copy clan-card-meta">#${clan.id} · ${escapeHtml(clan.slug)}</span></h2>
      </div>
      <div class="card-body card-body-padded">
        ${isSuperAdmin ? `
        <div class="inline-form-row">
          <div><label>${t('Name')}</label><input id="clan-name-${clan.id}" class="input" type="text" value="${escapeHtml(clan.name)}"></div>
          <div>
            <label>${t('Scan interval (minutes; blank = global)')}</label>
            <input id="clan-interval-${clan.id}" class="input" type="number" min="1" value="${intervalVal}" placeholder="${intervalPlaceholder}">
          </div>
          <div class="form-row-grow">
            <label>${t('Public URL (blank = global)')}</label>
            <input id="clan-public-url-${clan.id}" class="input" type="text" value="${escapeHtml(clan.publicUrl || '')}" placeholder="${escapeHtml(defaultPublicUrl ? t('default: {value}', { value: defaultPublicUrl }) : t('e.g. https://sinful.day'))}" autocomplete="off" spellcheck="false">
          </div>
          <button class="btn" data-action="clan-rename" data-clan-id="${clan.id}">${t('Save')}</button>
        </div>
        <p class="muted-copy hint-text mt-8">${t("Public URL is the domain this clan's members use. The Discord digest link and the share-link URLs below are built on it.")}</p>
        <p class="warning-text hint-text mt-8">⚠ ${t('Leave the scan interval blank for normal operation — only override for testing.')}</p>
        ` : ''}

        <hr class="section-divider">
        <h3>${t('Browser session')} ${renderAuthBadge(clan)}</h3>
        <p class="muted-copy">${renderAuthCopy(clan)} ${t("The in-app browser opens in a large window over the page; sign in and click <em>Save session</em> when you're fully in-game.")}</p>
        <div class="actions">
          <button class="btn btn-primary" data-action="login-session-start" data-clan-id="${clan.id}">${clan.authenticated ? t('Refresh login') : t('Log in to Total Battle')}</button>
        </div>

        <hr class="section-divider">
        <details class="clan-subsection">
        <summary class="clan-subsection-summary"><h3>${t('Discord')}</h3></summary>
        <div class="mt-12">
        <details class="mb-12">
          <summary class="collapse-toggle">${t('How do I set this up?')}</summary>
          <ol class="muted-copy help-list">
            <li>${t('Go to {link} → <strong>New Application</strong>.', { link: '<a href="https://discord.com/developers/applications" target="_blank" rel="noopener">discord.com/developers/applications</a>' })}</li>
            <li>${t('Left sidebar → <strong>Bot</strong> → <strong>Reset Token</strong> → copy it and paste into <em>Bot token</em> below.')}</li>
            <li>${t("Left sidebar → <strong>OAuth2 → URL Generator</strong>. Scopes: <code>bot</code> and <code>applications.commands</code>. Bot permissions: <code>Send Messages</code> and <code>Embed Links</code>. Open the generated URL, pick this clan's server, authorize.")}</li>
            <li>${t("Paste the token above and click <strong>Reload from Discord</strong> — the <em>Server</em> and <em>Channel</em> dropdowns fill in with the names the bot can actually see. Pick the server first; its channels load with it. (Nothing here needs Developer Mode or a copied ID; tick <em>Enter IDs manually</em> if you'd rather paste them.)")}</li>
            <li>${t('Tick <strong>Enabled</strong>, click <strong>Save Discord</strong>, then click <strong>Send test message</strong> to verify. With a Guild ID set, slash commands (<code>/leaderboard</code>, <code>/status</code>) appear in that server instantly. Each clan runs its own bot, so a fresh bot per clan keeps tokens / channels isolated.')}</li>
          </ol>
        </details>
        <div class="inline-form-row">
          <div><label class="checkbox-row"><input type="checkbox" id="clan-discord-enabled-${clan.id}" ${clan.discordEnabled ? 'checked' : ''}> ${t('Enabled')}</label></div>
          <div><label>${t('Bot token')}</label><input id="clan-discord-token-${clan.id}" class="input" type="password" placeholder="${tokenPlaceholder}"></div>
          <div class="form-row-grow"><label>${t('Server')}</label>
            <div id="clan-discord-guild-field-${clan.id}">${renderDiscordPicker(clan.id, 'guild', clan.discordGuildId, cachedDir?.guilds ?? null, t('Server ID'))}</div>
          </div>
          <div class="form-row-grow"><label>${t('Channel')}</label>
            <div id="clan-discord-channel-field-${clan.id}">${renderDiscordPicker(clan.id, 'channel', clan.discordChannelId, cachedChannels, t('Channel ID'))}</div>
          </div>
        </div>
        <div class="inline-form-row mt-8">
          <button class="btn" data-action="clan-discord-directory-load" data-clan-id="${clan.id}">${t('Reload from Discord')}</button>
          <label class="checkbox-row" title="${t('Fall back to pasting raw 18-digit IDs — for a bot that cannot list its own servers, or a channel Discord will not return')}">
            <input type="checkbox" data-action="clan-discord-manual-toggle" data-clan-id="${clan.id}" ${discordManualMode.has(clan.id) ? 'checked' : ''}> ${t('Enter IDs manually')}
          </label>
          <span class="muted-copy hint-text" id="clan-discord-dir-status-${clan.id}"></span>
        </div>
        <div class="inline-form-row mt-8">
          <label class="checkbox-row"><input type="checkbox" id="clan-discord-reports-${clan.id}" ${clan.discordScanReportsEnabled ? 'checked' : ''}> ${t('Post scan reports')}</label>
          <label class="checkbox-row"><input type="checkbox" id="clan-discord-onlynew-${clan.id}" ${clan.discordOnlyNewChests ? 'checked' : ''}> ${t('Only when new chests')}</label>
          <label class="checkbox-row"><input type="checkbox" id="clan-discord-digest-${clan.id}" ${clan.discordDailyDigestEnabled ? 'checked' : ''}> ${t('Daily digest')}</label>
          <label class="checkbox-row" title="${t('Posted after the rollover that ends the week set on the Week card below')}"><input type="checkbox" id="clan-discord-weekly-${clan.id}" ${clan.discordWeeklyDigestEnabled ? 'checked' : ''}> ${t('Weekly digest')}</label>
          <label class="checkbox-row"><input type="checkbox" id="clan-discord-cmds-${clan.id}" ${clan.discordCommandsEnabled ? 'checked' : ''}> ${t('Slash commands')}</label>
        </div>
        <p class="muted-copy mt-4 hint-text">${t("The weekly digest follows this clan's <strong>Week</strong> setting — currently <strong>{week}</strong> — and goes out with the daily one, after the first scan once the week has ended.", { week: clan.weekStart === 'ancients' ? t('Tinman to Tinman (6 days)') : t('Sunday to Sunday (7 days)') })}</p>
        <div class="inline-form-row mt-8">
          <div class="form-row-grow">
            <label>${t('Digest DM recipients (optional)')}</label>
            <div id="clan-discord-recipients-${clan.id}" class="digest-recipient-list">${renderRecipientRows(clan.id, clan.discordDailyDigestShareUserId)}</div>
            <div class="digest-recipient-add">
              <button type="button" class="btn btn-sm" data-action="clan-discord-add-recipient-row" data-clan-id="${clan.id}">${t('+ Add recipient by ID')}</button>
              <div id="clan-discord-member-field-${clan.id}" class="form-row-grow">${renderRecipientPicker(clan.id, cachedChannels ? cachedDir : null, discordManualMode.has(clan.id))}</div>
            </div>
            <p class="muted-copy mt-4 hint-text">${t("The bot DMs each of these users a plain-text version of every digest (daily and weekly) that pastes cleanly into in-game chat — up to 20 recipients, none means no DMs. Each must share a server with the bot and allow DMs from server members — one who doesn't still gets flagged, and everyone else's DM goes out.")}</p>
          </div>
        </div>
        <details class="mb-12 mt-8">
          <summary class="collapse-toggle">${t('How do I find a Discord user ID?')}</summary>
          <ol class="muted-copy help-list">
            <li>${t("Normally you don't: pick them from the <strong>Add a recipient</strong> dropdown above, which lists the selected server's members. It needs <strong>Developer Portal → Bot → Privileged Gateway Intents → SERVER MEMBERS INTENT</strong> switched on; without it the dropdown says so and you can fall back to IDs.")}</li>
            <li>${t("By hand: <strong>User Settings → Advanced → Developer Mode</strong> = ON, right-click the recipient's name → <strong>Copy User ID</strong>.")}</li>
            <li>${t('Click <strong>+ Add recipient by ID</strong>, paste the 17–19 digit ID into the new row and click <strong>Save Discord</strong>. One row per recipient.')}</li>
            <li>${t('Each recipient must share at least one server with this clan\'s bot, and have <strong>Privacy Settings → "Direct messages from server members"</strong> enabled for that server.')}</li>
            <li>${t("Click <strong>Send test DM</strong> to confirm — they should each get a DM titled with <code>[TEST DM — current game day so far]</code>, and the toast names anyone it couldn't reach.")}</li>
          </ol>
        </details>
        <div class="actions">
          <button class="btn btn-primary" data-action="clan-discord-save" data-clan-id="${clan.id}">${t('Save Discord')}</button>
          <button class="btn" data-action="clan-discord-test" data-clan-id="${clan.id}">${t('Send test message')}</button>
          <button class="btn" data-action="clan-discord-digest-dm-test" data-clan-id="${clan.id}" title="${t("Save first, then send a DM with today's data so far to verify delivery")}">${t('Send test DM')}</button>
        </div>
        ${renderDigestStatus(clan)}
        </div>
        </details>

        <hr class="section-divider">
        <details class="clan-subsection">
        <summary class="clan-subsection-summary"><h3>${t('ChestTracker')}</h3></summary>
        <div class="mt-12">
        <div class="inline-form-row">
          <div><label>${t('Share code')}</label><input id="clan-ct-code-${clan.id}" class="input" type="text" value="${escapeHtml(clan.ctShareCode)}" placeholder="${t('leave blank to disable')}"></div>
          <div><label>${t('Poll interval (h)')}</label><input id="clan-ct-interval-${clan.id}" class="input" type="number" min="0.083" step="0.083" value="${clan.ctPollIntervalHours ?? ''}" placeholder="3"></div>
          <div><label>${t('Backfill weeks')}</label><input id="clan-ct-backfill-${clan.id}" class="input" type="number" min="0" max="52" value="${clan.ctBackfillWeeks ?? ''}" placeholder="4"></div>
          <button class="btn btn-primary" data-action="clan-ct-save" data-clan-id="${clan.id}">${t('Save')}</button>
        </div>
        </div>
        </details>

        <hr class="section-divider">
        <details class="clan-subsection">
        <summary class="clan-subsection-summary"><h3>${t('Resource Tracking')}</h3></summary>
        <div class="mt-12">
        <p class="muted-copy mb-8">${t("Tracks what members send to and take from the Clan Capital. Turning this on adds the <strong>Resources</strong> tab to the navigation for this clan's admins.")}</p>
        <p class="muted-copy mb-8">${t('Contributions can arrive two ways, and both land in the same place. <strong>Automatically</strong> — the Clan Capital history is read straight off the game once per game day, needing nothing from anyone. Or <strong>by upload</strong> — an admin drops in history screenshots, each of which can list any number of players. Either way every row is matched to its clan member for you.')}</p>
        <div class="inline-form-row">
          <label class="checkbox-row"><input type="checkbox" id="clan-resources-enabled-${clan.id}" ${clan.resourcesEnabled ? 'checked' : ''}> ${t('Track resources for this clan')}</label>
        </div>
        <div class="inline-form-row">
          <label class="checkbox-row"><input type="checkbox" id="clan-resources-auto-${clan.id}" ${clan.resourceAutoCapture ? 'checked' : ''}> ${t('Include in the daily automatic read')}</label>
        </div>
        <p class="muted-copy mt-4">${t('Untick the second box to keep the tab and uploads for this clan while leaving it out of the nightly read — the one-off buttons below still work either way. The daily read also has to be switched on instance-wide under <strong>System &rarr; Automated Resource Collection</strong>.')}</p>
        <div class="actions mt-8">
          <button class="btn btn-primary" data-action="clan-resources-save" data-clan-id="${clan.id}">${t('Save')}</button>
        </div>
        ${clan.resourcesEnabled ? `
        <hr class="section-divider">
        <p class="muted-copy mb-8">${t("<strong>Read from the game now.</strong> These are one-off runs against <strong>this clan only</strong> — for proving the feature works before trusting the schedule, or pulling today's rows in early. They work whether or not the daily read is switched on.")}</p>
        <p class="muted-copy mb-8">${t('<strong>Collect now</strong> reads whatever is new since the last run — normally a few seconds. <strong>Diagnose</strong> reads the whole list and keeps a screenshot of every page but writes nothing, which is the safe way to check accuracy. <strong>Re-read all 14 days</strong> writes everything it finds, so rows already recorded get inserted a second time; only reach for it after fixing a reading problem.')}</p>
        <div class="inline-form-row mb-8" data-resource-capture-clan="${clan.id}">
          <button class="btn" data-action="clan-resources-collect" data-clan-id="${clan.id}">${t('Collect now')}</button>
          <button class="btn" data-action="clan-resources-collect-dry" data-clan-id="${clan.id}"
            title="${t('Reads the whole list and keeps a screenshot of every page, but writes nothing to the database')}">${t('Diagnose (write nothing)')}</button>
          <button class="btn" data-action="clan-resources-collect-full" data-clan-id="${clan.id}"
            title="${t('Ignores the saved position and re-reads all 14 days — rows already recorded will be inserted again')}">${t('Re-read all 14 days')}</button>
        </div>
        <div id="clanResourceCollectStatus-${clan.id}" class="muted-copy mb-8"></div>
        <details class="clan-subsection" data-section-key="clan-resource-debug-${clan.id}">
          <summary class="clan-subsection-summary"><h3>${t('Debug screenshots')}</h3></summary>
          <div class="mt-12" id="clanResourceDebugShots-${clan.id}">
            <button class="btn" data-action="clan-resources-debug-shots" data-clan-id="${clan.id}">${t('Load frames from the last run')}</button>
          </div>
        </details>` : ''}
        </div>
        </details>

        <hr class="section-divider">
        <details class="clan-subsection">
        <summary class="clan-subsection-summary"><h3>${t('Member management')}</h3></summary>
        <div class="mt-12">
        <p class="muted-copy mb-8">${t('When enabled, members not seen in a scan for the threshold below are automatically marked inactive. This is non-destructive — a member is restored automatically the next time a scan sees them.')} ${Number.isFinite(defaultInactivityDays) ? tn(defaultInactivityDays, 'Leave the threshold blank to use the global default of {n} day.', 'Leave the threshold blank to use the global default of {n} days.') : t('Leave the threshold blank to use the global default.')}</p>
        <div class="inline-form-row">
          <label class="checkbox-row"><input type="checkbox" id="clan-inactivity-enabled-${clan.id}" ${clan.inactivitySweepEnabled ? 'checked' : ''}> ${t('Auto-mark inactive members')}</label>
        </div>
        <div class="inline-form-row mt-8">
          <div><label>${t('Inactivity threshold (days; blank = global)')}</label><input id="clan-inactivity-${clan.id}" class="input" type="number" min="1" step="1" value="${clan.inactivityDays ?? ''}" placeholder="${inactivityPlaceholder}"></div>
          <button class="btn btn-primary" data-action="clan-inactivity-save" data-clan-id="${clan.id}">${t('Save')}</button>
        </div>
        </div>
        </details>

        <hr class="section-divider">
        <details class="clan-subsection">
        <summary class="clan-subsection-summary"><h3>${t('Week')}</h3></summary>
        <div class="mt-12">
        <p class="muted-copy mb-8">${t("What <strong>Weekly</strong> means for this clan, everywhere: Leaderboard, Dashboard, Members, Analytics, the public share link and the Discord bot. The ChestTracker tab keeps ChestTracker's own Sunday weeks.")}</p>
        <div class="inline-form-row">
          <div><label for="clan-week-start-${clan.id}">${t('Week runs')}</label>
            <select id="clan-week-start-${clan.id}" class="input">
              <option value="sunday" ${clan.weekStart !== 'ancients' ? 'selected' : ''}>${t('Sunday to Sunday (7 days)')}</option>
              <option value="ancients" ${clan.weekStart === 'ancients' ? 'selected' : ''}>${t('Tinman to Tinman (6 days)')}</option>
            </select>
          </div>
          <button class="btn btn-primary" data-action="clan-week-start-save" data-clan-id="${clan.id}">${t('Save')}</button>
        </div>
        <p class="muted-copy mt-8">${t('Tinman to Tinman opens when {event} ({ancients} day 2) begins at 17:00 UTC and runs until the next one begins, six days later.', { event: tGame('Rise of the Ancients'), ancients: tGame('Ancients') })}</p>
        </div>
        </details>

        <hr class="section-divider">
        <details class="clan-subsection">
        <summary class="clan-subsection-summary"><h3>${t('Leaderboard goal')}</h3></summary>
        <div class="mt-12">
        <p class="muted-copy mb-8">${t("Colours each member's Points cell on the Leaderboard against a target: <strong>green</strong> at the goal, <strong>amber</strong> from 66% of it, <strong>red</strong> below. Shows on this clan's Leaderboard tab and on its public share link.")}</p>
        <p class="muted-copy mb-8">${t("Set the <strong>weekly</strong> target only — the Daily, Monthly and Yearly views scale it from that one number (goal &divide; the week's length in days, set under Week), so the timeframes can never state goals that contradict each other. The All&nbsp;Time view has no goal: there's no period length to scale by.")}</p>
        <div class="inline-form-row">
          <label class="checkbox-row"><input type="checkbox" id="clan-goal-enabled-${clan.id}" ${clan.leaderboardGoalEnabled ? 'checked' : ''}> ${t('Show goal colours on the leaderboard')}</label>
        </div>
        <div class="inline-form-row mt-8">
          <div><label>${t('Weekly points goal per member')}</label><input id="clan-goal-points-${clan.id}" class="input" type="number" min="1" step="1" value="${clan.leaderboardWeeklyGoalPoints ?? ''}" placeholder="${t('e.g. 25000')}"></div>
          <button class="btn btn-primary" data-action="clan-goal-save" data-clan-id="${clan.id}">${t('Save')}</button>
        </div>
        <p class="muted-copy mt-8" id="clan-goal-preview-${clan.id}"></p>
        </div>
        </details>

        <hr class="section-divider">
        <details class="clan-subsection">
        <summary class="clan-subsection-summary"><h3>${t('Public share link')}</h3></summary>
        <div class="mt-12">
        <p class="muted-copy mb-8">${clan.ctShareCode ? t("Anyone with one of these URLs can view this clan's leaderboard and ChestTracker tab — no login required.") : t("Anyone with one of these URLs can view this clan's leaderboard — no login required.")} ${t('Each link counts its own visits, so give every place you post one its own link and Analytics will tell you which is actually being used. Disabling a link stops that URL immediately and leaves the others alone; you can restore it later from Analytics &amp; history.')}</p>
        ${(clan.shareLinks || []).length ? `
        <div class="share-link-list">
          ${(clan.shareLinks || []).map((link) => shareLinkRowHtml(clan.id, link)).join('')}
        </div>
        ` : `
        <p class="muted-copy share-link-empty">${t('No share links yet.')}</p>
        `}
        <div class="inline-form-row share-add-row mt-8">
          <div>
            <label for="clan-share-key-${clan.id}">${t('Custom key (optional)')}</label>
            <input id="clan-share-key-${clan.id}" class="input" type="text" maxlength="10" placeholder="${t('e.g. family')}" autocomplete="off" spellcheck="false">
          </div>
          <div>
            <label for="clan-share-label-${clan.id}">${t('Name (optional)')}</label>
            <input id="clan-share-label-${clan.id}" class="input" type="text" maxlength="60" placeholder="${t('e.g. Discord')}" autocomplete="off">
          </div>
          <button class="btn btn-primary" data-action="clan-share-create" data-clan-id="${clan.id}">${t('Add link')}</button>
        </div>
        <p class="muted-copy mt-8">${t("Leave the key blank for a random one. A custom key is 3&ndash;10 characters, letters a&ndash;z and digits 0&ndash;9 only, and can't be changed once created &mdash; people already hold the URL.")}</p>
        <div class="share-secondary-actions">
          <button class="btn btn-ghost btn-sm" data-action="clan-share-analytics" data-clan-id="${clan.id}">${CHART_ICON_SVG}<span>${t('Analytics &amp; history')}</span></button>
        </div>
        </div>
        </details>

        ${(clan.memberCount || 0) === 0 || (clan.scanCount || 0) === 0 ? `
        <hr class="section-divider">
        <h3>${t('Onboarding')}</h3>
        <p class="muted-copy">${t('Use these after signing in to TB for this clan via the admin "Browser Session" panel.')}</p>
        <div class="actions">
          ${(clan.memberCount || 0) === 0
            ? `<button class="btn" data-action="clan-onboard-capture" data-clan-id="${clan.id}">${t('Capture members')}</button>`
            : ''}
          ${(clan.scanCount || 0) === 0
            ? `<button class="btn" data-action="clan-onboard-firstscan" data-clan-id="${clan.id}">${t('Run first scan')}</button>`
            : ''}
          <span id="clan-onboard-status-${clan.id}" class="muted-copy"></span>
        </div>
        ` : ''}

        ${isSuperAdmin ? `
        <hr class="section-divider">
        <div class="actions">
          <button class="btn btn-danger" data-action="clan-delete" data-clan-id="${clan.id}" data-clan-name="${escapeHtml(clan.name)}">${t('Delete clan')}</button>
        </div>
        ` : ''}
      </div>
    </div>
  `;
}

// ─── Public share links: per-link rows, two-step disable, analytics modal ───

/**
 * One live link on the clan card: a click-to-copy URL pill, its name and
 * visit count, and per-link rename/disable buttons.
 *
 * The visit count rides along here rather than living only in the analytics
 * modal because it is the reason several links exist at all — seeing "0
 * visits" next to the link you pasted somewhere is the signal you wanted.
 */
function shareLinkRowHtml(clanId, link) {
  const url = clanOrigin(clanId) + '/' + link.token;
  return `
    <div class="share-link-row">
      <div
        class="share-url-pill"
        data-action="clan-share-copy"
        data-clan-id="${clanId}"
        data-share-url="${escapeHtml(url)}"
        title="${t('Click to copy')}"
        role="button"
        tabindex="0"
      >
        <span class="share-url-icon" aria-hidden="true">${COPY_ICON_SVG}</span>
        <span class="share-url-text">${escapeHtml(url)}</span>
        <span class="share-url-hint" aria-hidden="true">${t('Click to copy')}</span>
      </div>
      <div class="share-link-side">
        <span class="share-link-name">${link.label ? escapeHtml(link.label) : `<span class="muted-copy">${t('Unnamed')}</span>`}</span>
        <span class="share-link-count muted-copy">${tn(link.hitCount, '{n} visit', '{n} visits', { n: link.hitCount })}</span>
      </div>
      <div class="share-link-actions">
        <button class="btn btn-sm" data-action="clan-share-rename" data-clan-id="${clanId}" data-link-id="${link.id}" data-label="${escapeHtml(link.label || '')}">${t('Name')}</button>
        <button class="btn btn-danger btn-sm" data-action="clan-share-disable" data-clan-id="${clanId}" data-link-id="${link.id}">${t('Disable')}</button>
      </div>
    </div>`;
}


/**
 * Arm the Disable button as the first step of the two-step confirm. It
 * relabels to "Click again to confirm" and auto-resets after a few seconds
 * so a single stray click can never disable the link on its own.
 */
function armDisableButton(btn) {
  btn.dataset.armed = '1';
  if (!btn.dataset.label) btn.dataset.label = btn.textContent;
  btn.textContent = t('Click again to confirm');
  btn.classList.add('btn-armed');
  clearTimeout(btn._armTimer);
  btn._armTimer = setTimeout(() => {
    if (btn.isConnected) disarmButton(btn);
  }, 3500);
}

function disarmButton(btn) {
  clearTimeout(btn._armTimer);
  btn.dataset.armed = '';
  btn.classList.remove('btn-armed');
  if (btn.dataset.label) btn.textContent = btn.dataset.label;
}

// Revoked tokens no longer resolve, but they can be recovered (made live
// again), so we don't print them in full — first two chars + dots is enough
// for an admin to tell the recovery rows apart by shape.
function maskShareToken(token) {
  if (!token || token.length < 4) return '••••••';
  return token.slice(0, 2) + '••••';
}

function saStat(label, value, tip = '') {
  return `
    <div class="sa-stat"${tip ? ` title="${escapeHtml(tip)}"` : ''}>
      <div class="sa-stat-value">${escapeHtml(value)}</div>
      <div class="sa-stat-label">${escapeHtml(label)}</div>
    </div>`;
}

/**
 * 30-day visits sparkline. `daily` is the sparse server series (missing days
 * = zero); we expand it to a fixed 30 UTC-day window so the bar count is
 * stable regardless of how many days actually had traffic.
 */
function buildSparkline(daily) {
  const map = new Map((daily || []).map((d) => [d.day, d.views]));
  const now = new Date();
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    const key = d.toISOString().slice(0, 10);
    days.push({ day: key, views: map.get(key) || 0 });
  }
  const total = days.reduce((s, d) => s + d.views, 0);
  const max = Math.max(1, ...days.map((d) => d.views));
  const bars = days
    .map((d) => {
      const pct = Math.round((d.views / max) * 100);
      const h = d.views > 0 ? Math.max(pct, 8) : 2;
      const cls = d.views > 0 ? 'sa-spark-bar has-views' : 'sa-spark-bar';
      return `<div class="${cls}" style="height:${h}%" title="${tn(d.views, '{day}: {n} view', '{day}: {n} views', { day: escapeHtml(d.day), n: d.views })}"></div>`;
    })
    .join('');
  return `
    <div class="sa-spark-wrap">
      <div class="sa-spark-head">
        <span class="sa-spark-title">${t('Visits · last 30 days')}</span>
        <span class="sa-spark-total">${t('{total} total', { total })}</span>
      </div>
      <div class="sa-spark">${bars}</div>
    </div>`;
}

// Compact human duration for the average-visit stat.
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return t('{s}s', { s: 0 });
  if (ms < 1000) return t('<1s');
  const s = Math.round(ms / 1000);
  if (s < 60) return t('{s}s', { s });
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem ? t('{m}m {s}s', { m, s: rem }) : t('{m}m', { m });
  const h = Math.floor(m / 60);
  return t('{h}h {m}m', { h, m: m % 60 });
}

function renderShareAnalytics(clanId, data, opts = {}) {
  const links = Array.isArray(data?.links) ? data.links : [];
  const revoked = Array.isArray(data?.recentRevoked) ? data.recentRevoked : [];
  const origin = clanOrigin(clanId);
  const banner = opts.banner
    ? `<div class="sa-banner">${escapeHtml(opts.banner)}</div>`
    : '';

  // One card per live link. Splitting the stats per link is the whole point of
  // allowing several: a merged total can't tell you which posting works.
  const activeHtml = links.length
    ? links.map((link) => {
        const url = origin + '/' + link.token;
        const avgVisit = link.durationSamples > 0
          ? formatDuration(link.durationMsTotal / link.durationSamples)
          : '—';
        return `
      <div class="sa-active">
        <div class="sa-head">
          <div class="sa-url" title="${escapeHtml(url)}">${escapeHtml(url)}</div>
          ${link.label ? `<span class="sa-tag">${escapeHtml(link.label)}</span>` : ''}
          ${link.isVanity ? `<span class="sa-tag sa-tag-muted">${t('custom key')}</span>` : ''}
        </div>
        <div class="sa-stats">
          ${saStat(t('Visits'), String(link.hitCount), t('Total times this link was opened'))}
          ${saStat(t('Unique visitors'), String(link.uniqueVisits), t('First-time viewers (best-effort, per browser)'))}
          ${saStat(t('Repeat views'), String(link.returnVisits), t('Views from returning viewers'))}
          ${saStat(t('Avg. visit'), avgVisit, t('Average time spent on the page'))}
          ${saStat(t('Timeframe switches'), String(link.timeframeChanges), t('Visits where the viewer changed day/week/month'))}
          ${saStat(t('Last viewed'), link.lastUsedAt ? formatRelativeTime(link.lastUsedAt) : t('never'))}
          ${saStat(t('Created'), formatRelativeTime(link.createdAt))}
          ${saStat(t('Data requests'), String(link.apiHitCount), t('Background API calls the page made'))}
        </div>
        ${buildSparkline(link.daily)}
      </div>`;
      }).join('')
    : `
      <div class="sa-empty">
        <p class="muted-copy">${revoked.length ? t('No active share links right now. Restore a recent one below, or add a fresh link from the settings panel.') : t('No active share links right now. Add one from the settings panel to start sharing.')}</p>
      </div>`;

  const footnote = links.length
    ? `<p class="muted-copy sa-footnote">${t('Unique/repeat, average visit and timeframe switches are best-effort — they need JavaScript and a completed page view, so they under-count vs total Visits.')}</p>`
    : '';

  const historyRows = revoked.length
    ? revoked
        .map(
          (r) => `
        <div class="sa-hist-row">
          <div class="sa-hist-main">
            <span class="sa-hist-token">${escapeHtml(r.isVanity ? r.token : maskShareToken(r.token))}</span>
            <span class="sa-hist-meta">${r.label ? escapeHtml(r.label) + ' · ' : ''}${tn(r.hitCount, '{n} visit', '{n} visits', { n: r.hitCount })} · ${t('disabled {when}', { when: escapeHtml(formatRelativeTime(r.revokedAt)) })}</span>
          </div>
          <div class="sa-hist-actions">
            <button class="btn btn-sm" data-action="share-recover" data-link-id="${r.id}">${t('Restore')}</button>
            <button class="btn btn-danger btn-sm" data-action="share-forget" data-link-id="${r.id}">${t('Delete')}</button>
          </div>
        </div>`,
        )
        .join('')
    : `<p class="muted-copy sa-hist-empty">${t('No disabled links.')}</p>`;

  return `
    <div class="share-analytics">
      ${banner}
      ${activeHtml}
      ${footnote}
      <div class="sa-history">
        <h4 class="sa-history-title">${t('Disabled links')}</h4>
        <p class="muted-copy sa-history-sub">${t('Restore an accidentally disabled link — its old URL starts working again, alongside whatever links are already live. Deleting one discards its history and frees its key for reuse; until then the key stays claimed so an old URL can never be repointed at someone else.')}</p>
        ${historyRows}
      </div>
    </div>`;
}

/**
 * Open the analytics + recovery modal for a clan's share links. Fetches every
 * live link with its own 30-day series plus the recently disabled ones, then
 * wires the Restore / Delete buttons (which re-fetch and re-render both the
 * modal and the underlying card).
 */
async function openShareAnalytics(clanId, el, refreshClanIndicator) {
  const load = () =>
    fetch(`/api/clans/${clanId}/share-links`).then((r) => r.json().then((j) => ({ ok: r.ok, j })));

  let first;
  try {
    first = await load();
    if (!first.ok) return notify(first.j.error || t('Failed to load analytics'), t('Share link'));
  } catch {
    return notify(t('Failed to load share link analytics.'), t('Share link'));
  }
  const modal = contentModal({
    title: t('Public share links · analytics & history'),
    html: renderShareAnalytics(clanId, first.j),
    wide: true,
  });
  if (!modal) return;

  modal.content.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-action="share-recover"], [data-action="share-forget"]');
    if (!btn) return;
    const linkId = Number.parseInt(btn.getAttribute('data-link-id'), 10);
    if (!Number.isInteger(linkId)) return;
    const forget = btn.getAttribute('data-action') === 'share-forget';

    if (forget) {
      const ok = await confirmDialog(
        t('Delete this link permanently? Its visit history is discarded and its key becomes available again — including to another clan.'),
        { title: t('Delete share link'), confirmLabel: t('Delete'), danger: true },
      );
      if (!ok) return;
    }

    btn.disabled = true;
    const url = forget
      ? `/api/clans/${clanId}/share-links/${linkId}/permanent`
      : `/api/clans/${clanId}/share-links/${linkId}/restore`;
    try {
      const r = await fetch(url, { method: forget ? 'DELETE' : 'POST' });
      const j = await r.json();
      if (!r.ok) {
        notify(j.error || (forget ? t('Delete failed') : t('Restore failed')), t('Share link'));
        btn.disabled = false;
        return;
      }
      const restoredUrl = !forget && j.token ? `${clanOrigin(clanId)}/${j.token}` : '';
      notify(
        forget
          ? t('Link deleted — its key is free again.')
          : restoredUrl
            ? t('Restored — {url} is live again.', { url: restoredUrl })
            : t('Share link restored.'),
        t('Share link'),
      );
      // Re-fetch so the modal shows the restored link among the active ones
      // (with a success banner) and the history reflects the change; also
      // re-render the page card underneath so its link list updates.
      try {
        const fresh = await load();
        modal.setHtml(
          renderShareAnalytics(clanId, fresh.j, {
            banner: forget
              ? t('✓ Deleted — that key is available again.')
              : t('✓ Restored — this link is live again.'),
          }),
        );
      } catch {
        modal.close();
      }
      renderClans(el, refreshClanIndicator);
    } catch {
      notify(forget ? t('Delete failed.') : t('Restore failed.'), t('Share link'));
      btn.disabled = false;
    }
  });
}

const clanOnboardPollers = new Map();
async function pollClanOnboardStatus(clanId, rootEl) {
  // Single shared poller per clan. Cancel any previous one to avoid
  // accumulating timers when the page is re-rendered.
  if (clanOnboardPollers.has(clanId)) {
    clearTimeout(clanOnboardPollers.get(clanId));
  }
  const tick = async () => {
    try {
      const r = await fetch(`/api/clans/${clanId}/onboard/status`);
      if (!r.ok) return;
      const j = await r.json();
      const statusEl = rootEl.querySelector(`#clan-onboard-status-${clanId}`);
      if (statusEl) {
        if (j.status === 'idle') {
          statusEl.textContent = '';
        } else if (j.status === 'failed') {
          statusEl.textContent = t('Failed: {error}', { error: j.error || j.message });
        } else {
          statusEl.textContent = j.message || j.status;
        }
      }
      // Re-arm if work is still in progress.
      if (j.status === 'capturing-members' || j.status === 'first-scan') {
        clanOnboardPollers.set(clanId, setTimeout(tick, 2000));
      } else {
        clanOnboardPollers.delete(clanId);
      }
    } catch {
      // Network blip — don't lose the poller, retry shortly.
      clanOnboardPollers.set(clanId, setTimeout(tick, 4000));
    }
  };
  void tick();
}

// ─── Per-clan resource capture (manual controls) ──────────────────────────────
//
// These act on ONE clan, named in the URL, which is the whole reason they live on
// this page rather than the Resources tab: the Resources endpoints resolve the clan
// from the operator's active session, so a button beside clan #3 would have driven a
// capture against whichever clan happened to be active. The instance-wide daily
// schedule is a separate switch on the System page.

/** Human-readable summary of a finished capture. */
function describeClanCollect(o) {
  const parts = [];
  if (o?.dryRun) parts.push(t('DIAGNOSTIC — nothing written'));
  else parts.push(o?.rowsInserted ? tn(o.rowsInserted, '{n} new row(s) recorded', '{n} new row(s) recorded', { n: o.rowsInserted }) : t('no new rows'));
  if (o?.rowsSeen != null) parts.push(tn(o.rowsSeen, '{n} read', '{n} read', { n: o.rowsSeen }));
  if (o?.pagesScanned != null) parts.push(tn(o.pagesScanned, '{n} page(s)', '{n} page(s)', { n: o.pagesScanned }));
  if (o?.oldestDateLabel) parts.push(t('back to "{date}"', { date: String(o.oldestDateLabel).toLowerCase() }));
  const STOP = {
    cursor: t('stopped where the last run left off'),
    'date-floor': t('STOPPED EARLY — hit the date backstop without finding where the last run left off'),
    'end-of-list': t('read to the end of the list'),
    'no-new-rows': t('STOPPED EARLY — list scrolling but adding nothing'),
    blank: t('STOPPED EARLY — the rows never came back'),
    'page-limit': t('STOPPED EARLY — hit the page limit'),
    crashed: t('PARTIAL — the browser crashed mid-sweep; rows read so far were kept'),
    error: t('stopped on an error'),
  };
  if (o?.stopReason) parts.push(STOP[o.stopReason] ?? t('stopped: {reason}', { reason: o.stopReason }));
  if (o?.unresolvedRows) {
    const pct = o.rowsSeen ? ` (${Math.round((o.unresolvedRows / o.rowsSeen) * 100)}%)` : '';
    parts.push(`${tn(o.unresolvedRows, '{n} unresolved', '{n} unresolved', { n: o.unresolvedRows })}${pct}`);
  }
  if (o?.created?.length) parts.push(tn(o.created.length, '{n} new member(s)', '{n} new member(s)', { n: o.created.length }));
  if (o?.skipped) parts.push(t('skipped: {reason}', { reason: o.skipped }));
  // Both of these are normal, not warnings — but a run that reports "no new rows"
  // while having read 600 needs to say where they went, or it reads as a failure.
  if (o?.deferredRows) {
    parts.push(tn(o.deferredRows, '{n} held back — today is still in progress in-game, so its lines can still grow; the next run records that day complete', '{n} held back — today is still in progress in-game, so its lines can still grow; the next run records that day complete', { n: o.deferredRows }));
  }
  if (o?.withheldRows) {
    parts.push(o?.dryRun
      ? tn(o.withheldRows, '{n} already recorded', '{n} already recorded', { n: o.withheldRows })
      : tn(o.withheldRows, '{n} already recorded, not written again', '{n} already recorded, not written again', { n: o.withheldRows }));
  }
  // A dry run returns before the marker is ever saved, so it must not claim it moved.
  if (o?.anchorDate) {
    parts.push(o?.dryRun ? t('position would move to {date}', { date: o.anchorDate }) : t('position now at {date}', { date: o.anchorDate }));
  }
  if (o?.cursorLost) parts.push(t('previous position not re-found — rows may duplicate earlier ones'));
  let out = parts.join(' · ') + '.';
  if (o?.debugDir) out += ` ${t('Frames: {dir}', { dir: o.debugDir })}`;
  return out;
}

/**
 * Start a capture for one clan and poll until it finishes.
 *
 * Polling rather than awaiting the request: a sweep runs for minutes and a full
 * backfill for the better part of an hour, while the Cloudflare proxy in front of
 * this app gives up at ~100s and would hand back a 504 over a capture that is
 * working perfectly well.
 */
async function runClanResourceCollect(clanId, body) {
  const statusEl = document.getElementById(`clanResourceCollectStatus-${clanId}`);
  const buttons = document.querySelectorAll(`[data-resource-capture-clan="${clanId}"] button`);
  buttons.forEach((b) => { b.disabled = true; });
  const say = (text) => { if (statusEl) statusEl.textContent = text; };
  say(t('Starting: world map → clan capital → History…'));

  try {
    const started = await fetch(`/api/clans/${clanId}/resources/collect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json());
    if (started?.error) { say(started.error); return; }

    const deadline = Date.now() + 90 * 60_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2500));
      let res;
      try {
        res = await fetch(`/api/clans/${clanId}/resources/collect/status`).then((r) => r.json());
      } catch (err) {
        say(t('Lost contact while polling: {error}. The capture may still be running.', { error: String(err) }));
        return;
      }
      if (res?.status === 'running') {
        const secs = Math.round((res.elapsedMs ?? 0) / 1000);
        say(res.progress ? `${res.progress} · ${t('{s}s', { s: secs })}` : t('Reading the history… {s}s', { s: secs }));
        continue;
      }
      if (res?.status === 'error') { say(res.error || t('The collection failed.')); return; }
      if (res?.status === 'done') { say(describeClanCollect(res.outcome)); return; }
      say(t('No capture is running for this clan.'));
      return;
    }
    say(t('Stopped watching after 90 minutes — check the container logs.'));
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
  }
}

/** List and show the frames the last manual run saved for this clan. */
async function loadClanResourceDebugShots(clanId) {
  const host = document.getElementById(`clanResourceDebugShots-${clanId}`);
  if (!host) return;
  host.innerHTML = `<p class="muted-copy">${t('Loading…')}</p>`;
  let data;
  try {
    data = await fetch(`/api/clans/${clanId}/resources/debug-shots`).then((r) => r.json());
  } catch (err) {
    host.innerHTML = `<p class="muted-copy">${t('Could not list frames: {error}', { error: escapeHtml(String(err)) })}</p>`;
    return;
  }
  const shots = Array.isArray(data?.shots) ? data.shots : [];
  if (!data?.run || shots.length === 0) {
    host.innerHTML = `<p class="muted-copy">${t('No frames on disk. Run <em>Diagnose</em> — every scroll page is saved, and they age out with the normal screenshot retention.')}</p>`;
    return;
  }
  const total = shots.reduce((n, sh) => n + (sh.bytes || 0), 0);
  host.innerHTML = `
    <p class="muted-copy mb-8">${tn(shots.length, '{n} frame(s) · {size} MB from {run}. Copy the run off the box with {command}', '{n} frame(s) · {size} MB from {run}. Copy the run off the box with {command}', {
      n: shots.length,
      size: (total / 1024 / 1024).toFixed(1),
      run: `<code>${escapeHtml(data.run)}</code>`,
      command: `<code>scp -r &lt;host&gt;:&lt;app-dir&gt;/${escapeHtml(data.scpPath ?? '')} .</code>`,
    })}</p>
    <p class="muted-copy mb-8">${t('<code>pNNN-crop</code> is exactly what the reader saw for that page — the frame to judge accuracy from. <code>pNNN-full</code> is the whole screen, for checking the rectangle sits where it should. <code>blank-pNNN</code> is a page where the list went empty and the sweep waited; <code>final-page</code> is where it stopped.')}</p>
    <div class="resources-debug-grid">
      ${shots.map((sh) => {
        const url = `/api/clans/${clanId}/resources/debug-shots/${encodeURIComponent(data.run)}/${encodeURIComponent(sh.name)}`;
        const label = sh.name.replace(/_\d{4}-[\dT-]+Z?\.png$/, '').replace(/\.png$/, '');
        return `<figure class="resources-debug-shot">
          <a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="${escapeHtml(sh.name)}" loading="lazy"></a>
          <figcaption>${escapeHtml(label)} <span class="muted-copy">${t('{size} KB', { size: Math.round((sh.bytes || 0) / 1024) })}</span></figcaption>
        </figure>`;
      }).join('')}
    </div>`;
}
