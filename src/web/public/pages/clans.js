// Clans (admin/superadmin) — single-page CRUD for clans. The in-app
// Total Battle login bridge that this page exposes via each clan card
// lives in lib/login-bridge.js (shared with the setup wizard). This
// module imports and re-exports the bridge action functions so the
// central dispatcher in app.js can keep its existing imports working.

import { $, escapeHtml, formatRelativeTime, notify, confirmDialog, promptDialog, contentModal } from '../lib/ui.js';
import { getCurrentUser } from '../lib/state.js';
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
      notify(res?.message || 'Login session saved.', 'Login');
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
    el.innerHTML = '<div class="empty-state"><p>Admin access required.</p></div>';
    return;
  }
  const isSuperAdmin = currentUser.role === 'superadmin';
  let clansData;
  try {
    clansData = await fetch('/api/clans').then((r) => r.json());
  } catch {
    el.innerHTML = '<div class="empty-state"><p>Failed to load clans.</p></div>';
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
  const clans = isSuperAdmin
    ? allClans.filter((c) => c.id === activeClanId)
    : allClans;

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
    <h2 class="page-section-title">Clans</h2>
    <p class="page-section-intro">${isSuperAdmin
      ? "Each clan has its own member roster, chest data, browser session, Discord channel, and ChestTracker share code. The single-instance scanner cycles through every active clan in sequence on each scheduled interval."
      : "Manage your clan's Discord and ChestTracker integrations, refresh the Total Battle login session, and run member capture or first-scan onboarding."}</p>

    <!-- Login bridge panel — shared with the setup wizard via
         lib/login-bridge.js. Rendered as a centered modal over the page
         (modal: true) and hidden until a per-clan "Log in to TB" button
         starts a session. Only one bridge runs at a time, so a single
         shared panel is enough; status text identifies which clan it
         belongs to. -->
    ${loginBridgePanelHTML({ modal: true })}

    ${isSuperAdmin ? `
    <div class="card">
      <div class="card-header"><h2>Add Clan</h2></div>
      <div class="card-body card-body-padded">
        <div class="inline-form-row">
          <div><label>Clan name</label><input id="newClanName" class="input" type="text" placeholder="e.g. Arcane Dawn"></div>
          <button class="btn btn-primary" data-action="clan-create">Create</button>
        </div>
        <p class="muted-copy mt-12">After creating, sign in to TB for the new clan via the in-app login bridge, then run member capture and the first scan from this page. Clan switching happens inside the game's canvas — every clan logs into the same TB domain.</p>
      </div>
    </div>
    ` : ''}

    ${clans.map((c) => renderClanCard(c, isSuperAdmin, defaultScanIntervalMinutes, defaultInactivityDays)).join('')}
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
      if (!name) return notify('Clan name is required.', 'Create clan');
      try {
        const r = await fetch('/api/clans', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        const j = await r.json();
        if (!r.ok) return notify(j.error || 'Create failed', 'Create clan');
        renderClans(el, refreshClanIndicator);
      } catch {
        notify('Create failed.', 'Create clan');
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
        const r = await fetch(`/api/clans/${clanId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const j = await r.json();
        if (!r.ok) return notify(j.error || 'Save failed', 'Save clan');
        renderClans(el, refreshClanIndicator);
        if (typeof refreshClanIndicator === 'function') await refreshClanIndicator();
      } catch {
        notify('Save failed.', 'Save clan');
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
        dailyDigestShareUserId: el.querySelector(`#clan-discord-digest-share-${clanId}`).value.trim(),
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
        if (!r.ok) return notify(j.error || 'Discord save failed', 'Discord');
        // The recipient list is normalised server-side (mentions unwrapped,
        // duplicates and non-IDs dropped). Write it back so a silently
        // discarded entry is visible instead of looking saved.
        if (typeof j.digestShareUserId === 'string') {
          const field = el.querySelector(`#clan-discord-digest-share-${clanId}`);
          const submitted = body.dailyDigestShareUserId;
          if (field) field.value = j.digestShareUserId;
          if (submitted !== j.digestShareUserId) {
            notify(
              j.digestShareUserId
                ? `Saved. DM recipients read as: ${j.digestShareUserId}`
                : 'Saved, but no valid Discord user ID was found — DM recipients are now empty.',
              'Discord',
            );
            return;
          }
        }
        if (j.warning) notify(j.warning, 'Discord');
        else notify('Discord settings saved.', 'Discord');
      } catch {
        notify('Discord save failed.', 'Discord');
      }
    } else if (action === 'clan-discord-test' && clanId) {
      try {
        const r = await fetch(`/api/clans/${clanId}/discord/test`, { method: 'POST' });
        const j = await r.json();
        notify(j.ok ? 'Test message sent.' : `Test failed: ${j.error || 'unknown'}`, 'Discord test');
      } catch {
        notify('Test failed.', 'Discord test');
      }
    } else if (action === 'clan-discord-digest-dm-test' && clanId) {
      try {
        const r = await fetch(`/api/clans/${clanId}/discord/digest-dm-test`, { method: 'POST' });
        const j = await r.json();
        notify(j.ok
          ? (j.message || 'Digest DM sent.')
          : `DM test failed: ${j.error || 'unknown'}`, 'Digest DM test');
      } catch {
        notify('DM test failed.', 'Digest DM test');
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
        if (!r.ok) return notify(j.error || 'ChestTracker save failed', 'ChestTracker');
        notify('ChestTracker settings saved.', 'ChestTracker');
      } catch {
        notify('ChestTracker save failed.', 'ChestTracker');
      }
    } else if (action === 'clan-resources-collect' && clanId) {
      await runClanResourceCollect(clanId, {});
    } else if (action === 'clan-resources-collect-dry' && clanId) {
      await runClanResourceCollect(clanId, { dryRun: true });
    } else if (action === 'clan-resources-collect-full' && clanId) {
      const ok = await confirmDialog(
        'This ignores the saved position and re-reads all 14 days. Rows already recorded will be '
        + 'inserted again, which shows up as duplicates you clean up by deleting the extra batch in '
        + 'Resources → Upload History. Use it after fixing a reading bug, not routinely.',
        { title: 'Re-read all 14 days?', confirmLabel: 'Read everything', danger: true },
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
        if (!r.ok) return notify(j.error || 'Save failed', 'Resource Tracking');
        notify('Resource Tracking settings saved.', 'Resource Tracking');
        if (typeof window.refreshResourcesNavVisibility === 'function') {
          window.refreshResourcesNavVisibility();
        }
      } catch {
        notify('Save failed.', 'Resource Tracking');
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
        if (!r.ok) return notify(j.error || 'Save failed', 'Member management');
        notify('Member management settings saved.', 'Member management');
      } catch {
        notify('Save failed.', 'Member management');
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
        if (!r.ok) return notify(j.error || 'Save failed', 'Leaderboard goal');
        notify('Leaderboard goal saved.', 'Leaderboard goal');
        updateGoalPreview(el, clanId);
      } catch {
        notify('Save failed.', 'Leaderboard goal');
      }
    } else if (action === 'clan-share-generate' && clanId) {
      // Regenerate was removed: to rotate a link, Disable (recoverable) then
      // Generate a fresh one. Generate is only shown when no link is active.
      try {
        const r = await fetch(`/api/clans/${clanId}/share-token`, { method: 'POST' });
        const j = await r.json();
        if (!r.ok) return notify(j.error || 'Failed to generate share link', 'Share link');
        renderClans(el, refreshClanIndicator);
      } catch {
        notify('Failed to generate share link.', 'Share link');
      }
    } else if (action === 'clan-share-disable' && clanId) {
      // Two-step confirm. The first click arms the button ("Click again to
      // confirm") for a few seconds; only a second click opens the dialog.
      // Guards against a stray click wiping a link others may be using.
      if (target.dataset.armed !== '1') {
        armDisableButton(target);
        return;
      }
      disarmButton(target);
      const ok = await confirmDialog(
        'Disable the share link? The URL stops working immediately, but the link keeps its history and can be restored later from “Analytics & history”.',
        { title: 'Disable share link', confirmLabel: 'Disable', danger: true },
      );
      if (!ok) return;
      try {
        const r = await fetch(`/api/clans/${clanId}/share-token`, { method: 'DELETE' });
        const j = await r.json();
        if (!r.ok) return notify(j.error || 'Failed to disable share link', 'Share link');
        renderClans(el, refreshClanIndicator);
      } catch {
        notify('Failed to disable share link.', 'Share link');
      }
    } else if (action === 'clan-share-analytics' && clanId) {
      openShareAnalytics(clanId, el, refreshClanIndicator);
    } else if (action === 'clan-share-copy' && clanId) {
      const field = el.querySelector(`#clan-share-url-${clanId}`);
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
      if (hint) hint.textContent = '✓ Copied!';
      clearTimeout(field._copyTimer);
      field._copyTimer = setTimeout(() => {
        field.classList.remove('is-copied');
        if (hint) hint.textContent = 'Click to copy';
      }, 1400);
    } else if (action === 'clan-delete' && clanId) {
      const clanName = target.getAttribute('data-clan-name') || '';
      const ok = await confirmDialog(
        `Delete clan "${clanName}"? It disappears from the clan picker, the scanner, Discord and its public `
        + 'share link, and its members can no longer sign in to it.\n\n'
        + 'Its data — members, scans, chests, resources, settings — is KEPT, and a superadmin can put the '
        + 'clan back from System → Deleted Clans.',
        {
          title: `Delete clan "${clanName}"`,
          confirmLabel: 'Continue',
          cancelLabel: 'Cancel',
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
        `To confirm, type the clan name exactly: ${clanName}`,
        {
          title: `Delete clan "${clanName}"`,
          confirmLabel: 'Delete clan',
          cancelLabel: 'Cancel',
        },
      );
      if (typed === null) return;
      if (String(typed).trim() !== clanName) {
        return notify('Name did not match — clan was not deleted.', 'Delete clan');
      }
      try {
        const r = await fetch(`/api/clans/${clanId}`, { method: 'DELETE' });
        const j = await r.json();
        if (!r.ok) return notify(j.error || 'Delete failed', 'Delete clan');
        renderClans(el, refreshClanIndicator);
      } catch {
        notify('Delete failed.', 'Delete clan');
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
        if (!r.ok) return notify(j.error || 'Capture failed', 'Capture members');
        pollClanOnboardStatus(clanId, el);
      } catch {
        notify('Capture failed.', 'Capture members');
      }
    } else if (action === 'clan-onboard-firstscan' && clanId) {
      try {
        const r = await fetch(`/api/clans/${clanId}/onboard/first-scan`, { method: 'POST' });
        const j = await r.json();
        if (!r.ok) return notify(j.error || 'Scan failed', 'First scan');
        pollClanOnboardStatus(clanId, el);
      } catch {
        notify('Scan failed.', 'First scan');
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
      const input = el.querySelector(`#clan-discord-digest-share-${clanId}`);
      if (!input) return;
      const ids = input.value.split(/[\s,;]+/).map((v) => v.trim()).filter(Boolean);
      if (!ids.includes(picked)) ids.push(picked);
      input.value = ids.join(', ');
      updateRecipientNames(el, clanId);
    }
  };
  el.addEventListener('change', el._clanChangeHandler);

  // Kick off a status poll for any clan currently mid-onboarding so the
  // status pill ("Capturing members…", "Running first scan…") refreshes
  // automatically without a page reload.
  for (const clan of clans) {
    pollClanOnboardStatus(clan.id, el);
    // Populate the Discord dropdowns without being asked. The lookup is a
    // read of the clan's own bot and is cached server-side for a minute, so
    // the re-render after every mutation on this page costs nothing.
    if (clan.discordTokenSet) void loadDiscordDirectory(el, clan.id);
    const shareInput = el.querySelector(`#clan-discord-digest-share-${clan.id}`);
    if (shareInput) shareInput.addEventListener('input', () => updateRecipientNames(el, clan.id));
  }

  // Show what a weekly target works out to per day / month / year, live as
  // it's typed. The scaling is invisible otherwise — an admin types 25000 and
  // has no way to know whether the Daily tab will judge people against 3,571
  // or something else until they go and look. Listeners are attached to the
  // freshly-rendered inputs, so the re-render replaces them; nothing stacks.
  for (const clan of clans) {
    const input = el.querySelector(`#clan-goal-points-${clan.id}`);
    if (input) input.addEventListener('input', () => updateGoalPreview(el, clan.id));
    updateGoalPreview(el, clan.id);
  }
}

/**
 * Render the derived-goal line under the weekly-goal input.
 *
 * The per-period division is restated here (it's `weekly / 7 * days`, and the
 * page has no period state to feed scaleGoalForPeriod), but the amber cutoff
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
  const per = (days) => Math.round((weekly / 7) * days).toLocaleString();
  out.innerHTML = `Works out to <strong>${per(1)}</strong> / day, `
    + `<strong>${per(30)}</strong> / month, <strong>${per(365)}</strong> / year. `
    + `Amber starts at 66% of each (<strong>${goalWarnThreshold(weekly).toLocaleString()}</strong> for the week).`;
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
  if (!clan.discordEnabled || !clan.discordDailyDigestEnabled) return '';
  if (!clan.lastDigestAt) {
    return `<p class="muted-copy digest-status-line">Last digest: never run yet — fires at the next configured rollover hour.</p>`;
  }
  const when = formatRelativeTime(clan.lastDigestAt);
  const channelOk = !clan.lastDigestChannelError;
  const dmConfigured = !!clan.discordDailyDigestShareUserId;
  const dmOk = !dmConfigured || !clan.lastDigestDmError;
  const allOk = channelOk && dmOk;
  if (allOk) {
    return `<p class="digest-status-line"><span class="chest-type uncommon">Last digest: ✓ ${escapeHtml(when)}</span></p>`;
  }
  const parts = [];
  if (!channelOk) parts.push(`Channel post failed — ${escapeHtml(clan.lastDigestChannelError)}`);
  if (dmConfigured && !dmOk) parts.push(`DM failed — ${escapeHtml(clan.lastDigestDmError)}`);
  return `
    <p class="digest-status-line">
      <span class="chest-type common">Last digest: ⚠ ${escapeHtml(when)}</span>
    </p>
    <ul class="muted-copy digest-status-errors">
      ${parts.map((p) => `<li>${p}</li>`).join('')}
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
      ? `Last scan ${escapeHtml(when)} could not load the Total Battle canvas with the saved session. Click Refresh login.`
      : 'The saved Total Battle session no longer loads the game canvas. Click Refresh login.';
    return `<span class="chest-type common" title="${tip}">Needs re-authentication</span>`;
  }
  if (clan.authenticated) {
    return '<span class="chest-type uncommon" title="A storage-state file exists for this clan and the most recent scan was able to load the game.">Authenticated</span>';
  }
  return '<span class="chest-type common" title="No storage-state file on disk. The scanner will skip this clan until you log in.">Not authenticated</span>';
}

function renderAuthCopy(clan) {
  if (clan.needsReauth) {
    return "The scanner could not load the Total Battle canvas with this clan's saved session on the last run — cookies have likely expired. Re-authenticate below to resume scans.";
  }
  if (clan.authenticated) {
    return 'A previous login was saved for this clan. If scans fail with auth errors, refresh the session below.';
  }
  return 'No login saved yet. Sign in below before activating this clan for scans.';
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
  let options = `<option value=""${value ? '' : ' selected'}>— none —</option>`;
  // A configured id the list doesn't contain still has to be selectable, or
  // opening the page would silently clear it on the next save.
  if (value && !known) {
    options += `<option value="${escapeHtml(value)}" selected>${escapeHtml(value)} (not in this list)</option>`;
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

/**
 * The "add a DM recipient" dropdown. The stored value stays a comma-separated
 * ID list in the existing text field — picking a name appends to it — because
 * that field is also the escape hatch for someone who is in the server but
 * whom the member lookup can't see (no privileged intent).
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
    + `<option value="">+ Add a recipient from ${escapeHtml(dir.guildName || 'the server')}…</option>${options}</select>`;
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
  guildField.innerHTML = renderDiscordPicker(clanId, 'guild', guildValue, dir?.guilds ?? null, 'Server ID');
  // Channels belong to one server. If the loaded directory is for a different
  // server than the one now selected, offer no list rather than a list of
  // channels that cannot receive this clan's messages.
  const channels = dir && dir.guildId && dir.guildId === guildValue ? dir.channels : null;
  channelField.innerHTML = renderDiscordPicker(clanId, 'channel', channelValue, channels, 'Channel ID');
  const memberField = el.querySelector(`#clan-discord-member-field-${clanId}`);
  if (memberField) {
    const forThisGuild = dir && dir.guildId && dir.guildId === guildValue ? dir : null;
    memberField.innerHTML = renderRecipientPicker(clanId, forThisGuild, manual);
  }
  updateRecipientNames(el, clanId);
}

/**
 * Resolve the comma-separated recipient IDs to names under the field. An ID
 * that resolves to nothing is called out rather than left looking configured —
 * a mistyped digit currently costs a silent daily DM.
 */
function updateRecipientNames(el, clanId) {
  const out = el.querySelector(`#clan-discord-recipients-names-${clanId}`);
  if (!out) return;
  const raw = el.querySelector(`#clan-discord-digest-share-${clanId}`)?.value ?? '';
  const ids = raw.split(/[\s,;]+/).map((s) => s.replace(/^<@!?/, '').replace(/>$/, '').trim()).filter(Boolean);
  const dir = discordDirectories.get(clanId);
  if (!ids.length || !dir || !dir.members?.length) {
    out.textContent = '';
    return;
  }
  const byId = new Map(dir.members.map((m) => [m.id, m.name]));
  out.innerHTML = 'Resolves to: ' + ids
    .map((id) => (byId.has(id)
      ? escapeHtml(byId.get(id))
      : `<span class="warning-text">${escapeHtml(id)} (not found in this server)</span>`))
    .join(', ');
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
  setStatus('Reading from Discord…');
  try {
    const r = await fetch(`/api/clans/${clanId}/discord/directory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token || undefined, guildId: guildId || undefined }),
    });
    const j = await r.json();
    if (!r.ok) {
      setStatus(j.error || 'Discord lookup failed.');
      return;
    }
    const guildName = j.guilds?.find((g) => g.id === j.guildId)?.name || '';
    discordDirectories.set(clanId, { ...j, guildName });
    // The server list is pinned for a clan admin (see the directory route).
    // Say so, or a one-entry dropdown reads as "the bot is only in one
    // server" and the next question is why the other one disappeared.
    const pinned = j.scopedToGuildId ? ' Server locked to your clan — a superadmin can move it.' : '';
    if (!j.guilds?.length) {
      setStatus('This bot has not been invited to any server yet — run the OAuth2 invite URL first.');
    } else if (!j.guildId) {
      setStatus(`${j.guilds.length} server${j.guilds.length === 1 ? '' : 's'} — pick one to load its channels.`);
    } else {
      setStatus(`${j.channels.length} channel${j.channels.length === 1 ? '' : 's'} in ${guildName}`
        + (j.membersUnavailable ? '' : `, ${j.members.length} member${j.members.length === 1 ? '' : 's'}`) + '.' + pinned);
    }
    syncDiscordPickers(el, clanId);
  } catch {
    setStatus('Discord lookup failed.');
  }
}

function renderClanCard(clan, isSuperAdmin, defaultScanIntervalMinutes, defaultInactivityDays) {
  const intervalVal = clan.scanIntervalMinutes ?? '';
  const intervalPlaceholder = Number.isFinite(defaultScanIntervalMinutes)
    ? `default: ${defaultScanIntervalMinutes}`
    : 'blank = global default';
  const inactivityPlaceholder = Number.isFinite(defaultInactivityDays)
    ? `blank = global default (${defaultInactivityDays})`
    : 'blank = global default';
  // discordTokenSet: `true` when the server has a token on file. We
  // never round-trip the actual token to the browser; the input is
  // empty by default and only updates the stored token if non-empty.
  const tokenPlaceholder = clan.discordTokenSet ? '••••••••• (leave blank to keep)' : 'Bot token';
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
          <div><label>Name</label><input id="clan-name-${clan.id}" class="input" type="text" value="${escapeHtml(clan.name)}"></div>
          <div>
            <label>Scan interval (minutes; blank = global)</label>
            <input id="clan-interval-${clan.id}" class="input" type="number" min="1" value="${intervalVal}" placeholder="${intervalPlaceholder}">
          </div>
          <button class="btn" data-action="clan-rename" data-clan-id="${clan.id}">Save</button>
        </div>
        <p class="warning-text hint-text mt-8">⚠ Leave the scan interval blank for normal operation — only override for testing.</p>
        ` : ''}

        <hr class="section-divider">
        <h3>Browser session ${renderAuthBadge(clan)}</h3>
        <p class="muted-copy">${renderAuthCopy(clan)} The in-app browser opens in a large window over the page; sign in and click <em>Save session</em> when you're fully in-game.</p>
        <div class="actions">
          <button class="btn btn-primary" data-action="login-session-start" data-clan-id="${clan.id}">${clan.authenticated ? 'Refresh login' : 'Log in to Total Battle'}</button>
        </div>

        <hr class="section-divider">
        <details class="clan-subsection">
        <summary class="clan-subsection-summary"><h3>Discord</h3></summary>
        <div class="mt-12">
        <details class="mb-12">
          <summary class="collapse-toggle">How do I set this up?</summary>
          <ol class="muted-copy help-list">
            <li>Go to <a href="https://discord.com/developers/applications" target="_blank" rel="noopener">discord.com/developers/applications</a> → <strong>New Application</strong>.</li>
            <li>Left sidebar → <strong>Bot</strong> → <strong>Reset Token</strong> → copy it and paste into <em>Bot token</em> below.</li>
            <li>Left sidebar → <strong>OAuth2 → URL Generator</strong>. Scopes: <code>bot</code> and <code>applications.commands</code>. Bot permissions: <code>Send Messages</code> and <code>Embed Links</code>. Open the generated URL, pick this clan's server, authorize.</li>
            <li>Paste the token above and click <strong>Reload from Discord</strong> — the <em>Server</em> and <em>Channel</em> dropdowns fill in with the names the bot can actually see. Pick the server first; its channels load with it. (Nothing here needs Developer Mode or a copied ID; tick <em>Enter IDs manually</em> if you'd rather paste them.)</li>
            <li>Tick <strong>Enabled</strong>, click <strong>Save Discord</strong>, then click <strong>Send test message</strong> to verify. With a Guild ID set, slash commands (<code>/leaderboard</code>, <code>/status</code>) appear in that server instantly. Each clan runs its own bot, so a fresh bot per clan keeps tokens / channels isolated.</li>
          </ol>
        </details>
        <div class="inline-form-row">
          <div><label class="checkbox-row"><input type="checkbox" id="clan-discord-enabled-${clan.id}" ${clan.discordEnabled ? 'checked' : ''}> Enabled</label></div>
          <div><label>Bot token</label><input id="clan-discord-token-${clan.id}" class="input" type="password" placeholder="${tokenPlaceholder}"></div>
          <div class="form-row-grow"><label>Server</label>
            <div id="clan-discord-guild-field-${clan.id}">${renderDiscordPicker(clan.id, 'guild', clan.discordGuildId, cachedDir?.guilds ?? null, 'Server ID')}</div>
          </div>
          <div class="form-row-grow"><label>Channel</label>
            <div id="clan-discord-channel-field-${clan.id}">${renderDiscordPicker(clan.id, 'channel', clan.discordChannelId, cachedChannels, 'Channel ID')}</div>
          </div>
        </div>
        <div class="inline-form-row mt-8">
          <button class="btn" data-action="clan-discord-directory-load" data-clan-id="${clan.id}">Reload from Discord</button>
          <label class="checkbox-row" title="Fall back to pasting raw 18-digit IDs — for a bot that cannot list its own servers, or a channel Discord will not return">
            <input type="checkbox" data-action="clan-discord-manual-toggle" data-clan-id="${clan.id}" ${discordManualMode.has(clan.id) ? 'checked' : ''}> Enter IDs manually
          </label>
          <span class="muted-copy hint-text" id="clan-discord-dir-status-${clan.id}"></span>
        </div>
        <div class="inline-form-row mt-8">
          <label class="checkbox-row"><input type="checkbox" id="clan-discord-reports-${clan.id}" ${clan.discordScanReportsEnabled ? 'checked' : ''}> Post scan reports</label>
          <label class="checkbox-row"><input type="checkbox" id="clan-discord-onlynew-${clan.id}" ${clan.discordOnlyNewChests ? 'checked' : ''}> Only when new chests</label>
          <label class="checkbox-row"><input type="checkbox" id="clan-discord-digest-${clan.id}" ${clan.discordDailyDigestEnabled ? 'checked' : ''}> Daily digest</label>
          <label class="checkbox-row"><input type="checkbox" id="clan-discord-cmds-${clan.id}" ${clan.discordCommandsEnabled ? 'checked' : ''}> Slash commands</label>
        </div>
        <div class="inline-form-row mt-8">
          <div class="form-row-grow">
            <label>Daily digest DM recipients (optional)</label>
            <div id="clan-discord-member-field-${clan.id}">${renderRecipientPicker(clan.id, cachedChannels ? cachedDir : null, discordManualMode.has(clan.id))}</div>
            <input id="clan-discord-digest-share-${clan.id}" class="input mt-4" type="text"
              value="${escapeHtml(clan.discordDailyDigestShareUserId || '')}"
              placeholder="e.g. 123456789012345678, 234567890123456789 — leave blank to disable">
            <p class="muted-copy mt-4 hint-text" id="clan-discord-recipients-names-${clan.id}"></p>
            <p class="muted-copy mt-4 hint-text">When set, the bot also DMs each of these users a plain-text version of the digest that pastes cleanly into in-game chat. Separate IDs with commas (up to 20). Each recipient must share a server with the bot and allow DMs from server members — one who doesn't still gets flagged, and everyone else's DM goes out.</p>
          </div>
        </div>
        <details class="mb-12 mt-8">
          <summary class="collapse-toggle">How do I find a Discord user ID?</summary>
          <ol class="muted-copy help-list">
            <li>Normally you don't: pick them from the <strong>Add a recipient</strong> dropdown above, which lists the selected server's members. It needs <strong>Developer Portal → Bot → Privileged Gateway Intents → SERVER MEMBERS INTENT</strong> switched on; without it the dropdown says so and you can fall back to IDs.</li>
            <li>By hand: <strong>User Settings → Advanced → Developer Mode</strong> = ON, right-click the recipient's name → <strong>Copy User ID</strong>.</li>
            <li>Paste the 17–19 digit ID into the field above and click <strong>Save Discord</strong>. For several recipients, separate the IDs with commas: <code>123…, 234…</code>.</li>
            <li>Each recipient must share at least one server with this clan's bot, and have <strong>Privacy Settings → "Direct messages from server members"</strong> enabled for that server.</li>
            <li>Click <strong>Send test DM</strong> to confirm — they should each get a DM titled with <code>[TEST DM — current game day so far]</code>, and the toast names anyone it couldn't reach.</li>
          </ol>
        </details>
        <div class="actions">
          <button class="btn btn-primary" data-action="clan-discord-save" data-clan-id="${clan.id}">Save Discord</button>
          <button class="btn" data-action="clan-discord-test" data-clan-id="${clan.id}">Send test message</button>
          <button class="btn" data-action="clan-discord-digest-dm-test" data-clan-id="${clan.id}" title="Save first, then send a DM with today's data so far to verify delivery">Send test DM</button>
        </div>
        ${renderDigestStatus(clan)}
        </div>
        </details>

        <hr class="section-divider">
        <details class="clan-subsection">
        <summary class="clan-subsection-summary"><h3>ChestTracker</h3></summary>
        <div class="mt-12">
        <div class="inline-form-row">
          <div><label>Share code</label><input id="clan-ct-code-${clan.id}" class="input" type="text" value="${escapeHtml(clan.ctShareCode)}" placeholder="leave blank to disable"></div>
          <div><label>Poll interval (h)</label><input id="clan-ct-interval-${clan.id}" class="input" type="number" min="0.083" step="0.083" value="${clan.ctPollIntervalHours ?? ''}" placeholder="3"></div>
          <div><label>Backfill weeks</label><input id="clan-ct-backfill-${clan.id}" class="input" type="number" min="0" max="52" value="${clan.ctBackfillWeeks ?? ''}" placeholder="4"></div>
          <button class="btn btn-primary" data-action="clan-ct-save" data-clan-id="${clan.id}">Save</button>
        </div>
        </div>
        </details>

        <hr class="section-divider">
        <details class="clan-subsection">
        <summary class="clan-subsection-summary"><h3>Resource Tracking</h3></summary>
        <div class="mt-12">
        <p class="muted-copy mb-8">Tracks what members send to and take from the Clan Capital. Turning this on adds the <strong>Resources</strong> tab to the navigation for this clan's admins.</p>
        <p class="muted-copy mb-8">Contributions can arrive two ways, and both land in the same place. <strong>Automatically</strong> — the Clan Capital history is read straight off the game once per game day, needing nothing from anyone. Or <strong>by upload</strong> — an admin drops in history screenshots, each of which can list any number of players. Either way every row is matched to its clan member for you.</p>
        <div class="inline-form-row">
          <label class="checkbox-row"><input type="checkbox" id="clan-resources-enabled-${clan.id}" ${clan.resourcesEnabled ? 'checked' : ''}> Track resources for this clan</label>
        </div>
        <div class="inline-form-row">
          <label class="checkbox-row"><input type="checkbox" id="clan-resources-auto-${clan.id}" ${clan.resourceAutoCapture ? 'checked' : ''}> Include in the daily automatic read</label>
        </div>
        <p class="muted-copy mt-4">Untick the second box to keep the tab and uploads for this clan while leaving it out of the nightly read — the one-off buttons below still work either way. The daily read also has to be switched on instance-wide under <strong>System &rarr; Automated Resource Collection</strong>.</p>
        <div class="actions mt-8">
          <button class="btn btn-primary" data-action="clan-resources-save" data-clan-id="${clan.id}">Save</button>
        </div>
        ${clan.resourcesEnabled ? `
        <hr class="section-divider">
        <p class="muted-copy mb-8"><strong>Read from the game now.</strong> These are one-off runs against <strong>this clan only</strong> — for proving the feature works before trusting the schedule, or pulling today's rows in early. They work whether or not the daily read is switched on.</p>
        <p class="muted-copy mb-8"><strong>Collect now</strong> reads whatever is new since the last run — normally a few seconds. <strong>Diagnose</strong> reads the whole list and keeps a screenshot of every page but writes nothing, which is the safe way to check accuracy. <strong>Re-read all 14 days</strong> writes everything it finds, so rows already recorded get inserted a second time; only reach for it after fixing a reading problem.</p>
        <div class="inline-form-row mb-8" data-resource-capture-clan="${clan.id}">
          <button class="btn" data-action="clan-resources-collect" data-clan-id="${clan.id}">Collect now</button>
          <button class="btn" data-action="clan-resources-collect-dry" data-clan-id="${clan.id}"
            title="Reads the whole list and keeps a screenshot of every page, but writes nothing to the database">Diagnose (write nothing)</button>
          <button class="btn" data-action="clan-resources-collect-full" data-clan-id="${clan.id}"
            title="Ignores the saved position and re-reads all 14 days — rows already recorded will be inserted again">Re-read all 14 days</button>
        </div>
        <div id="clanResourceCollectStatus-${clan.id}" class="muted-copy mb-8"></div>
        <details class="clan-subsection" data-section-key="clan-resource-debug-${clan.id}">
          <summary class="clan-subsection-summary"><h3>Debug screenshots</h3></summary>
          <div class="mt-12" id="clanResourceDebugShots-${clan.id}">
            <button class="btn" data-action="clan-resources-debug-shots" data-clan-id="${clan.id}">Load frames from the last run</button>
          </div>
        </details>` : ''}
        </div>
        </details>

        <hr class="section-divider">
        <details class="clan-subsection">
        <summary class="clan-subsection-summary"><h3>Member management</h3></summary>
        <div class="mt-12">
        <p class="muted-copy mb-8">When enabled, members not seen in a scan for the threshold below are automatically marked inactive. This is non-destructive — a member is restored automatically the next time a scan sees them. Leave the threshold blank to use the global default${Number.isFinite(defaultInactivityDays) ? ` of ${defaultInactivityDays} days` : ''}.</p>
        <div class="inline-form-row">
          <label class="checkbox-row"><input type="checkbox" id="clan-inactivity-enabled-${clan.id}" ${clan.inactivitySweepEnabled ? 'checked' : ''}> Auto-mark inactive members</label>
        </div>
        <div class="inline-form-row mt-8">
          <div><label>Inactivity threshold (days; blank = global)</label><input id="clan-inactivity-${clan.id}" class="input" type="number" min="1" step="1" value="${clan.inactivityDays ?? ''}" placeholder="${inactivityPlaceholder}"></div>
          <button class="btn btn-primary" data-action="clan-inactivity-save" data-clan-id="${clan.id}">Save</button>
        </div>
        </div>
        </details>

        <hr class="section-divider">
        <details class="clan-subsection">
        <summary class="clan-subsection-summary"><h3>Leaderboard goal</h3></summary>
        <div class="mt-12">
        <p class="muted-copy mb-8">Colours each member's Points cell on the Leaderboard against a target: <strong>green</strong> at the goal, <strong>amber</strong> from 66% of it, <strong>red</strong> below. Shows on this clan's Leaderboard tab and on its public share link.</p>
        <p class="muted-copy mb-8">Set the <strong>weekly</strong> target only — the Daily, Monthly and Yearly views scale it from that one number (goal &divide; 7 per day), so the timeframes can never state goals that contradict each other. The All&nbsp;Time view has no goal: there's no period length to scale by.</p>
        <div class="inline-form-row">
          <label class="checkbox-row"><input type="checkbox" id="clan-goal-enabled-${clan.id}" ${clan.leaderboardGoalEnabled ? 'checked' : ''}> Show goal colours on the leaderboard</label>
        </div>
        <div class="inline-form-row mt-8">
          <div><label>Weekly points goal per member</label><input id="clan-goal-points-${clan.id}" class="input" type="number" min="1" step="1" value="${clan.leaderboardWeeklyGoalPoints ?? ''}" placeholder="e.g. 25000"></div>
          <button class="btn btn-primary" data-action="clan-goal-save" data-clan-id="${clan.id}">Save</button>
        </div>
        <p class="muted-copy mt-8" id="clan-goal-preview-${clan.id}"></p>
        </div>
        </details>

        <hr class="section-divider">
        <details class="clan-subsection">
        <summary class="clan-subsection-summary"><h3>Public share link</h3></summary>
        <div class="mt-12">
        <p class="muted-copy mb-8">Anyone with this URL can view this clan's leaderboard${clan.ctShareCode ? ' and ChestTracker tab' : ''} — no login required. Disabling stops the URL immediately; you can restore it later from Analytics &amp; history, or generate a fresh one.</p>
        ${clan.publicShareToken ? `
        <div class="inline-form-row share-url-row">
          <div
            id="clan-share-url-${clan.id}"
            class="share-url-pill"
            data-action="clan-share-copy"
            data-clan-id="${clan.id}"
            data-share-url="${escapeHtml(window.location.origin + '/' + clan.publicShareToken)}"
            title="Click to copy"
            role="button"
            tabindex="0"
          >
            <span class="share-url-icon" aria-hidden="true">${COPY_ICON_SVG}</span>
            <span class="share-url-text">${escapeHtml(window.location.origin + '/' + clan.publicShareToken)}</span>
            <span class="share-url-hint" aria-hidden="true">Click to copy</span>
          </div>
          <button class="btn btn-danger" data-action="clan-share-disable" data-clan-id="${clan.id}">Disable</button>
        </div>
        ` : `
        <div class="actions">
          <button class="btn btn-primary" data-action="clan-share-generate" data-clan-id="${clan.id}">Generate share link</button>
        </div>
        `}
        <div class="share-secondary-actions">
          <button class="btn btn-ghost btn-sm" data-action="clan-share-analytics" data-clan-id="${clan.id}">${CHART_ICON_SVG}<span>Analytics &amp; history</span></button>
        </div>
        </div>
        </details>

        ${(clan.memberCount || 0) === 0 || (clan.scanCount || 0) === 0 ? `
        <hr class="section-divider">
        <h3>Onboarding</h3>
        <p class="muted-copy">Use these after signing in to TB for this clan via the admin "Browser Session" panel.</p>
        <div class="actions">
          ${(clan.memberCount || 0) === 0
            ? `<button class="btn" data-action="clan-onboard-capture" data-clan-id="${clan.id}">Capture members</button>`
            : ''}
          ${(clan.scanCount || 0) === 0
            ? `<button class="btn" data-action="clan-onboard-firstscan" data-clan-id="${clan.id}">Run first scan</button>`
            : ''}
          <span id="clan-onboard-status-${clan.id}" class="muted-copy"></span>
        </div>
        ` : ''}

        ${isSuperAdmin ? `
        <hr class="section-divider">
        <div class="actions">
          <button class="btn btn-danger" data-action="clan-delete" data-clan-id="${clan.id}" data-clan-name="${escapeHtml(clan.name)}">Delete clan</button>
        </div>
        ` : ''}
      </div>
    </div>
  `;
}

// ─── Public share link: two-step disable + analytics/recovery modal ───

/**
 * Arm the Disable button as the first step of the two-step confirm. It
 * relabels to "Click again to confirm" and auto-resets after a few seconds
 * so a single stray click can never disable the link on its own.
 */
function armDisableButton(btn) {
  btn.dataset.armed = '1';
  if (!btn.dataset.label) btn.dataset.label = btn.textContent;
  btn.textContent = 'Click again to confirm';
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
      return `<div class="${cls}" style="height:${h}%" title="${escapeHtml(d.day)}: ${d.views} view${d.views === 1 ? '' : 's'}"></div>`;
    })
    .join('');
  return `
    <div class="sa-spark-wrap">
      <div class="sa-spark-head">
        <span class="sa-spark-title">Visits · last 30 days</span>
        <span class="sa-spark-total">${total} total</span>
      </div>
      <div class="sa-spark">${bars}</div>
    </div>`;
}

// Compact human duration for the average-visit stat.
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  if (ms < 1000) return '<1s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function renderShareAnalytics(data, opts = {}) {
  const active = data?.active || null;
  const revoked = Array.isArray(data?.recentRevoked) ? data.recentRevoked : [];
  const origin = window.location.origin;
  const banner = opts.banner
    ? `<div class="sa-banner">${escapeHtml(opts.banner)}</div>`
    : '';

  let activeHtml;
  if (active) {
    const url = origin + '/' + active.token;
    const avgVisit = active.durationSamples > 0
      ? formatDuration(active.durationMsTotal / active.durationSamples)
      : '—';
    activeHtml = `
      <div class="sa-active">
        <div class="sa-url" title="${escapeHtml(url)}">${escapeHtml(url)}</div>
        <div class="sa-stats">
          ${saStat('Visits', String(active.hitCount), 'Total times the page was opened')}
          ${saStat('Unique visitors', String(active.uniqueVisits), 'First-time viewers (best-effort, per browser)')}
          ${saStat('Repeat views', String(active.returnVisits), 'Views from returning viewers')}
          ${saStat('Avg. visit', avgVisit, 'Average time spent on the page')}
          ${saStat('Timeframe switches', String(active.timeframeChanges), 'Visits where the viewer changed day/week/month')}
          ${saStat('Last viewed', active.lastUsedAt ? formatRelativeTime(active.lastUsedAt) : 'never')}
          ${saStat('Created', formatRelativeTime(active.createdAt))}
          ${saStat('Data requests', String(active.apiHitCount), 'Background API calls the page made')}
        </div>
        ${buildSparkline(data.daily)}
        <p class="muted-copy sa-footnote">Unique/repeat, average visit and timeframe switches are best-effort — they need JavaScript and a completed page view, so they under-count vs total Visits.</p>
      </div>`;
  } else {
    activeHtml = `
      <div class="sa-empty">
        <p class="muted-copy">No active share link right now.${revoked.length ? ' Restore a recent one below, or generate a fresh link from the settings panel.' : ' Generate one from the settings panel to start sharing.'}</p>
      </div>`;
  }

  const historyRows = revoked.length
    ? revoked
        .map(
          (r) => `
        <div class="sa-hist-row">
          <div class="sa-hist-main">
            <span class="sa-hist-token">${escapeHtml(maskShareToken(r.token))}</span>
            <span class="sa-hist-meta">${r.hitCount} visit${r.hitCount === 1 ? '' : 's'} · disabled ${escapeHtml(formatRelativeTime(r.revokedAt))}</span>
          </div>
          <button class="btn btn-sm" data-action="share-recover" data-link-id="${r.id}">Recover</button>
        </div>`,
        )
        .join('')
    : '<p class="muted-copy sa-hist-empty">No disabled links to recover.</p>';

  return `
    <div class="share-analytics">
      ${banner}
      ${activeHtml}
      <div class="sa-history">
        <h4 class="sa-history-title">Recently disabled</h4>
        <p class="muted-copy sa-history-sub">Restore an accidentally disabled link — its old URL starts working again. Restoring swaps out the current active link.</p>
        ${historyRows}
      </div>
    </div>`;
}

/**
 * Open the analytics + recovery modal for a clan's share link. Fetches usage
 * stats + recent revoked links, renders them, and wires the Recover buttons
 * (which re-fetch and re-render both the modal and the underlying card).
 */
async function openShareAnalytics(clanId, el, refreshClanIndicator) {
  let data;
  try {
    const r = await fetch(`/api/clans/${clanId}/share-token/analytics`);
    data = await r.json();
    if (!r.ok) return notify(data.error || 'Failed to load analytics', 'Share link');
  } catch {
    return notify('Failed to load share link analytics.', 'Share link');
  }
  const modal = contentModal({
    title: 'Public share link · analytics & history',
    html: renderShareAnalytics(data),
    wide: true,
  });
  if (!modal) return;

  modal.content.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-action="share-recover"]');
    if (!btn) return;
    const linkId = Number.parseInt(btn.getAttribute('data-link-id'), 10);
    if (!Number.isInteger(linkId)) return;
    btn.disabled = true;
    try {
      const r = await fetch(`/api/clans/${clanId}/share-token/recover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ linkId }),
      });
      const j = await r.json();
      if (!r.ok) {
        notify(j.error || 'Recover failed', 'Share link');
        btn.disabled = false;
        return;
      }
      const restoredUrl = j.publicShareToken
        ? `${window.location.origin}/${j.publicShareToken}`
        : '';
      notify(restoredUrl ? `Restored — ${restoredUrl} is live again.` : 'Share link restored.', 'Share link');
      // Re-fetch so the modal shows the restored link as active (with a
      // success banner) and the history reflects the swap; also re-render the
      // page card underneath so its URL pill updates.
      try {
        const fresh = await fetch(`/api/clans/${clanId}/share-token/analytics`).then((rr) => rr.json());
        modal.setHtml(renderShareAnalytics(fresh, { banner: '✓ Restored — this link is live again.' }));
      } catch {
        modal.close();
      }
      renderClans(el, refreshClanIndicator);
    } catch {
      notify('Recover failed.', 'Share link');
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
          statusEl.textContent = `Failed: ${j.error || j.message}`;
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
  if (o?.dryRun) parts.push('DIAGNOSTIC — nothing written');
  else parts.push(o?.rowsInserted ? `${o.rowsInserted} new row(s) recorded` : 'no new rows');
  if (o?.rowsSeen != null) parts.push(`${o.rowsSeen} read`);
  if (o?.pagesScanned != null) parts.push(`${o.pagesScanned} page(s)`);
  if (o?.oldestDateLabel) parts.push(`back to "${String(o.oldestDateLabel).toLowerCase()}"`);
  const STOP = {
    cursor: 'stopped where the last run left off',
    'date-floor': 'STOPPED EARLY — hit the date backstop without finding where the last run left off',
    'end-of-list': 'read to the end of the list',
    'no-new-rows': 'STOPPED EARLY — list scrolling but adding nothing',
    blank: 'STOPPED EARLY — the rows never came back',
    'page-limit': 'STOPPED EARLY — hit the page limit',
    crashed: 'PARTIAL — the browser crashed mid-sweep; rows read so far were kept',
    error: 'stopped on an error',
  };
  if (o?.stopReason) parts.push(STOP[o.stopReason] ?? `stopped: ${o.stopReason}`);
  if (o?.unresolvedRows) {
    const pct = o.rowsSeen ? ` (${Math.round((o.unresolvedRows / o.rowsSeen) * 100)}%)` : '';
    parts.push(`${o.unresolvedRows} unresolved${pct}`);
  }
  if (o?.created?.length) parts.push(`${o.created.length} new member(s)`);
  if (o?.skipped) parts.push(`skipped: ${o.skipped}`);
  // Both of these are normal, not warnings — but a run that reports "no new rows"
  // while having read 600 needs to say where they went, or it reads as a failure.
  if (o?.deferredRows) {
    parts.push(`${o.deferredRows} held back — today is still in progress in-game, so its lines `
      + 'can still grow; the next run records that day complete');
  }
  if (o?.withheldRows) {
    parts.push(o?.dryRun
      ? `${o.withheldRows} already recorded`
      : `${o.withheldRows} already recorded, not written again`);
  }
  // A dry run returns before the marker is ever saved, so it must not claim it moved.
  if (o?.anchorDate) {
    parts.push(o?.dryRun ? `position would move to ${o.anchorDate}` : `position now at ${o.anchorDate}`);
  }
  if (o?.cursorLost) parts.push('previous position not re-found — rows may duplicate earlier ones');
  let out = parts.join(' · ') + '.';
  if (o?.debugDir) out += ` Frames: ${o.debugDir}`;
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
  say('Starting: world map → clan capital → History…');

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
        say(`Lost contact while polling: ${String(err)}. The capture may still be running.`);
        return;
      }
      if (res?.status === 'running') {
        const secs = Math.round((res.elapsedMs ?? 0) / 1000);
        say(res.progress ? `${res.progress} · ${secs}s` : `Reading the history… ${secs}s`);
        continue;
      }
      if (res?.status === 'error') { say(res.error || 'The collection failed.'); return; }
      if (res?.status === 'done') { say(describeClanCollect(res.outcome)); return; }
      say('No capture is running for this clan.');
      return;
    }
    say('Stopped watching after 90 minutes — check the container logs.');
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
  }
}

/** List and show the frames the last manual run saved for this clan. */
async function loadClanResourceDebugShots(clanId) {
  const host = document.getElementById(`clanResourceDebugShots-${clanId}`);
  if (!host) return;
  host.innerHTML = '<p class="muted-copy">Loading…</p>';
  let data;
  try {
    data = await fetch(`/api/clans/${clanId}/resources/debug-shots`).then((r) => r.json());
  } catch (err) {
    host.innerHTML = `<p class="muted-copy">Could not list frames: ${escapeHtml(String(err))}</p>`;
    return;
  }
  const shots = Array.isArray(data?.shots) ? data.shots : [];
  if (!data?.run || shots.length === 0) {
    host.innerHTML = '<p class="muted-copy">No frames on disk. Run <em>Diagnose</em> — every scroll '
      + 'page is saved, and they age out with the normal screenshot retention.</p>';
    return;
  }
  const total = shots.reduce((n, sh) => n + (sh.bytes || 0), 0);
  host.innerHTML = `
    <p class="muted-copy mb-8">${shots.length} frame(s) · ${(total / 1024 / 1024).toFixed(1)} MB
      from <code>${escapeHtml(data.run)}</code>. Copy the run off the box with
      <code>scp -r &lt;host&gt;:&lt;app-dir&gt;/${escapeHtml(data.scpPath ?? '')} .</code></p>
    <p class="muted-copy mb-8"><code>pNNN-crop</code> is exactly what the reader saw for that page —
      the frame to judge accuracy from. <code>pNNN-full</code> is the whole screen, for checking the
      rectangle sits where it should. <code>blank-pNNN</code> is a page where the list went empty and
      the sweep waited; <code>final-page</code> is where it stopped.</p>
    <div class="resources-debug-grid">
      ${shots.map((sh) => {
        const url = `/api/clans/${clanId}/resources/debug-shots/${encodeURIComponent(data.run)}/${encodeURIComponent(sh.name)}`;
        const label = sh.name.replace(/_\d{4}-[\dT-]+Z?\.png$/, '').replace(/\.png$/, '');
        return `<figure class="resources-debug-shot">
          <a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="${escapeHtml(sh.name)}" loading="lazy"></a>
          <figcaption>${escapeHtml(label)} <span class="muted-copy">${Math.round((sh.bytes || 0) / 1024)} KB</span></figcaption>
        </figure>`;
      }).join('')}
    </div>`;
}
