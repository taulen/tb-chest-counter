"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveMember = resolveMember;
exports.runMightCapturePhase = runMightCapturePhase;
const logger_js_1 = require("../utils/logger.js");
const calibration_js_1 = require("../config/calibration.js");
const game_day_js_1 = require("../utils/game-day.js");
const fuzzy_js_1 = require("../utils/fuzzy.js");
const memberRepo = __importStar(require("../data/repositories/member-repo.js"));
const mightRepo = __importStar(require("../data/repositories/might-repo.js"));
const merge_repo_js_1 = require("../data/repositories/merge-repo.js");
const user_repo_js_1 = require("../data/repositories/user-repo.js");
const review_queue_repo_js_1 = require("../data/repositories/review-queue-repo.js");
const log = (0, logger_js_1.childLogger)('might-capture');
/** How many names to list in a log line before truncating. */
const NAME_SAMPLE_LIMIT = 10;
/**
 * Resolve a read name to a roster member.
 *
 * Active pool before inactive, and the verbatim name before its tag-stripped and
 * homoglyph-folded variants. Separate passes rather than one merged list so an
 * active member always wins a contested name, and so the fuzzy matcher's
 * candidate pool for the common case stays exactly what it was — a bigger pool
 * means more chances for a garbled read to land on the wrong person, and the edit
 * budget is deliberately tight (see utils/fuzzy.ts).
 *
 * Shared by the capture-time "is this name new?" predicate (which decides whether
 * to keep an evidence crop) and the post-capture resolution, so the two can never
 * disagree about what counts as new.
 *
 * Exported for tests. The one thing this has to get right — a reading an admin has
 * already written a rule for must land on the player they named — is otherwise only
 * reachable through a live browser page, which is why it went wrong unnoticed.
 */
function resolveMember(name, activeMembers, inactiveMembers, candidatesFor, canonicalise) {
    // A player merge rule outranks every heuristic below: the admin has stated who
    // this reading is. So when one fires, match its destination and nothing else —
    // EXACTLY, with no candidate expansion and no distance tier.
    //
    // Not a shortcut, a guard. The destination is a name off the roster, not an OCR
    // reading, so there is no damage for distance to repair — and allowing the tier
    // would let a rule whose destination has since been renamed away land the row on
    // whoever now sits within two edits of it: a member neither the reading nor the
    // rule ever named. Failing to a create instead puts the admin's own spelling in
    // the review queue, where they can see it.
    const canonical = canonicalise(name);
    if (canonical !== name) {
        const member = (0, fuzzy_js_1.exactMatchMember)(canonical, activeMembers)
            ?? (0, fuzzy_js_1.exactMatchMember)(canonical, inactiveMembers);
        return member ? { member, viaInactive: !member.isActive, exact: true } : null;
    }
    const candidates = candidatesFor(name);
    // EVERY exact pass before ANY fuzzy one, across both pools. Ranking the active
    // pool above the inactive one for exact matches too was a real bug: the member
    // list's "Bardin" is exactly (inactive) member #78 Bardin, but active member #74
    // "Bain" sits 2 edits away and claimed the reading first — so Bardin's might was
    // filed under Bain and Bardin looked like he'd left the clan.
    for (const candidate of candidates) {
        const member = (0, fuzzy_js_1.exactMatchMember)(candidate, activeMembers)
            ?? (0, fuzzy_js_1.exactMatchMember)(candidate, inactiveMembers);
        if (member)
            return { member, viaInactive: !member.isActive, exact: true };
    }
    // Only now fall back to distance, active members first — a contested near-miss
    // should land on someone currently in the clan.
    for (const [viaInactive, pool] of [[false, activeMembers], [true, inactiveMembers]]) {
        for (const candidate of candidates) {
            const member = (0, fuzzy_js_1.fuzzyMatchMember)(candidate, pool);
            if (member)
                return { member, viaInactive, exact: false };
        }
    }
    return null;
}
/**
 * Capture this clan's might readings for today, if today needs one.
 *
 * Cheap to call on every scan cycle: the once-a-day gate is a single indexed
 * lookup, so the common case (already captured) costs one query and returns.
 * That's what makes the schedule self-healing across downtime without any
 * persisted catch-up state — whichever cycle first runs after the 17:00 UTC
 * rollover does the capture, and if the container was down for two days, the
 * next cycle captures today and the missing days simply stay missing.
 */
async function runMightCapturePhase(ctx, page) {
    const { config, clanId, reportProgress, force } = ctx;
    if (!config.mightTrackingEnabled)
        return { ran: false, skipped: 'disabled' };
    // Shares the Stage 4 rectangle with member capture. An uncalibrated crop
    // means there is nothing sensible to read, and requireMemberListCrop would
    // throw deeper in — check up front so the skip is explicit.
    if (!(0, calibration_js_1.isMemberListCropSet)()) {
        log.info(`Might capture skipped for clan #${clanId} — the member-list crop is not calibrated.`);
        return { ran: false, skipped: 'not-calibrated' };
    }
    // Hard gate on a POST-might-tracking Stage 4 calibration.
    //
    // Any rectangle saved before this feature existed was drawn to the old
    // instruction — "exclude the power/icons on the right" — so it physically
    // cannot contain a might number. Driving the browser to the Members panel and
    // OCR'ing ~20 pages to discover that every single time is pure waste, and it
    // would put a daily warning in the log for something the operator hasn't been
    // asked to do yet. The revision only advances when Stage 4 is re-saved, so
    // this stays shut until the operator has genuinely re-calibrated.
    //
    // Read through the accessor, NOT ctx.config: ScanLoop's AppConfig is a
    // construction-time snapshot that the Stage 4 save route can't reach, so
    // ctx.config would still say 0 after a genuine re-calibration and keep the
    // gate shut until the container restarted.
    if (!(0, calibration_js_1.isMemberListCropRecalibrated)()) {
        log.info('Might capture skipped — the member-list rectangle predates might tracking ' +
            `(Stage 4 save count: ${(0, calibration_js_1.getMemberListCropRevision)()}). Re-run Admin → Scanner Mode → ` +
            'Calibrate, Stage 4, and drag the rectangle right so it includes the might number beside ' +
            'the shield icon. Saving the stage is what opens this — the screenshot it was drawn on ' +
            'can be an old one. Capture starts on the next cycle after the save.');
        return { ran: false, skipped: 'stale-calibration' };
    }
    if (page.isClosed()) {
        log.info(`Might capture skipped for clan #${clanId} — the browser page is closed.`);
        return { ran: false, skipped: 'page-closed' };
    }
    const gameDate = (0, game_day_js_1.currentGameDate)(config.gameDayRolloverUtcHour);
    if (mightRepo.hasSnapshotForGameDate(clanId, gameDate)) {
        if (!force) {
            // At info, not debug. This is the single most likely reason an operator
            // watching a scan sees nothing happen — a second scan on the same game day
            // is the normal case — and a silent skip is indistinguishable from a
            // broken feature. Costs one line per clan per cycle.
            log.info(`Might capture skipped for clan #${clanId} — already captured for game day ${gameDate}. ` +
                `The next one is due after the ${config.gameDayRolloverUtcHour}:00 UTC rollover; use ` +
                'System → Might Tracking → "Re-capture now" to refresh today instead of waiting.');
            return { ran: false, skipped: 'already-captured-today', gameDate };
        }
        log.info(`Might re-capture forced for clan #${clanId} — overwriting today's readings (game day ${gameDate}).`);
    }
    // Matching is against the existing roster only, so with an empty roster there
    // is nothing a reading could attach to.
    //
    // Both pools, deliberately. The in-game member list is the authoritative clan
    // roster; our `is_active` flag is a much stricter thing — the inactivity sweep
    // soft-removes anyone not SEEN IN A SCAN for their clan's threshold (7 days by
    // default), and a player can easily go that long without earning a chest while
    // still being very much in the clan. Matching against active members only
    // therefore threw away the readings for exactly those people: 13 names on clan
    // #1 and 6 on clan #2 in the first production run, including several whose
    // values had been read perfectly.
    const activeMembers = memberRepo.getAllMembers(true, clanId);
    const inactiveMembers = memberRepo.getAllMembers(false, clanId).filter((m) => !m.isActive);
    if (activeMembers.length + inactiveMembers.length === 0) {
        log.info(`Might capture skipped for clan #${clanId} — no members on the roster to match against.`);
        return { ran: false, skipped: 'no-roster', gameDate };
    }
    log.info(`Capturing member might for clan #${clanId} (game day ${gameDate})...`);
    reportProgress?.('Reading member might...');
    const { captureMemberMight, nameMatchCandidates, sameOcrSkeleton, } = await import('../browser/might-capture.js');
    // Player merge rules first, before any matching and before anything is created.
    //
    // A rule is the admin saying "this reading IS that player", which outranks every
    // heuristic here — and until now this phase never consulted them, so a name an
    // admin had already merged away was re-created as a fresh member on the very next
    // capture. That is not a corner case: none of the four names it did it to on the
    // live roster is reachable by distance ("Ma Chaosraven" → "Mikam Chaosraven" is 3
    // edits against a budget of 2, "185/ taulen302" → "taulen302" is 3, and
    // "FENRØTH Øf CHAOS" is 1 but lands on a member another reading has already
    // claimed, so it took the promoted-as-a-separate-player branch below). The rules
    // were correct the whole time; nothing was reading them.
    //
    // Deliberately the SAME matcher the gift scan uses, substring tier included — a
    // rule whose normalized `from` is 4+ characters also catches any reading that
    // contains it. That tier can in principle collapse two real players ("Mama from
    // Chaos" contains "Ma from Chaos"), and the alternative was exact-only rule
    // matching here, which would still have fixed all four production cases. Rejected,
    // because one rule table behaving two different ways depending on which path read
    // the name is the exact shape of the bug being fixed. What makes it safe to accept
    // is that this path SEES a wrong collapse: two readings landing on one member is
    // already reported by name in the collapsed-reading warning below, and a rule
    // rewrite is now shown in it. The gift scan has no such check and has run this way
    // for months.
    const canonicalisePlayerName = (0, merge_repo_js_1.loadPlayerNameCanonicaliser)(clanId);
    const resolve = (name) => resolveMember(name, activeMembers, inactiveMembers, nameMatchCandidates, canonicalisePlayerName);
    const capture = await captureMemberMight(page, {
        onProgress: reportProgress,
        // Keep an evidence crop only for names the roster doesn't know — those are
        // the rows that will become new members and need acknowledging. Same
        // resolution used after the capture, so the two can't disagree.
        keepCropFor: (name) => resolve(name) === null,
    });
    if (capture.navigationFailed) {
        log.warn(`Might capture for clan #${clanId}: could not open the Members panel — skipping today. ` +
            'The chest scan was unaffected.');
        return { ran: false, skipped: 'navigation-failed', gameDate };
    }
    // The diagnostic that matters most on first rollout: the panel was read fine,
    // every member row was found, and not one of them yielded a number. That is
    // exactly what a Stage 4 rectangle drawn around the names column looks like —
    // the might column sits to the right of it and never enters the crop.
    if (capture.coordRowsSeen > 0 && capture.rowsWithoutMight === capture.coordRowsSeen) {
        log.warn(`Might capture for clan #${clanId}: read ${capture.coordRowsSeen} member row(s) but found no ` +
            'power number in any of them. The Stage 4 "member list" rectangle is almost certainly cutting ' +
            'off the might column — re-run Admin → Scanner Mode → Calibrate, Stage 4, and drag the ' +
            'rectangle far enough right to include the number beside the shield icon.');
        return { ran: false, skipped: 'no-rows', gameDate };
    }
    if (capture.rows.length === 0) {
        log.warn(`Might capture for clan #${clanId}: no member rows were read at all ` +
            `(${capture.pagesScanned} page(s) scanned). Skipping today.`);
        return { ran: false, skipped: 'no-rows', gameDate };
    }
    // Resolve to members with the same fuzzy matcher the gift scan and the
    // resource import use, so a name behaves identically whichever path reads it.
    const snapshots = [];
    const created = [];
    const failed = [];
    const seenMemberIds = new Set();
    /** memberId → the reading that claimed it, so a later near-miss can be judged
     *  against the actual text rather than only against the member. */
    const claimedBy = new Map();
    let matchedInactive = 0;
    /** Readings that exactly matched a member another reading had already claimed —
     *  the same player twice (via an alias), so the first reading stands. */
    const collapsedPairs = [];
    /** Readings whose only match was a fuzzy hit on an already-claimed member, so they
     *  were treated as a distinct player instead of being dropped. */
    const promoted = [];
    // Resolve every reading up front, then claim members in TWO passes: exact matches
    // first, fuzzy ones after.
    //
    // An exact match has to outrank a fuzzy one no matter which row is read first.
    // Resolving and claiming in one pass made the outcome depend on list order: "Fain"
    // (a new player, 1 edit from member "Bain") is read 14 pages before "Bain", so it
    // claimed Bain's row by distance and the real "Bain" — an exact match — was then
    // the one dropped. Two passes make precedence a property of the match quality
    // rather than of where a player happens to sit in the list.
    const resolvedByRow = new Map();
    for (const row of capture.rows)
        resolvedByRow.set(row, resolve(row.name));
    const exactRows = capture.rows.filter((r) => resolvedByRow.get(r)?.exact === true);
    const otherRows = capture.rows.filter((r) => resolvedByRow.get(r)?.exact !== true);
    for (const row of [...exactRows, ...otherRows]) {
        const hit = resolvedByRow.get(row) ?? null;
        let member = hit?.member ?? null;
        // The name this reading is treated as from here on: the rule's destination when
        // one fired, otherwise the reading itself. Everything that stores or compares a
        // name below uses this, so a rule can't be honoured by the match and then undone
        // by an upsert of the raw misread.
        const readName = canonicalisePlayerName(row.name);
        /** For the log lines, so a rule rewrite is visible rather than silent. */
        const shownName = readName === row.name
            ? `"${row.name}"`
            : `"${row.name}" (merge rule → "${readName}")`;
        // A FUZZY match onto a member some other reading already claimed means this row
        // is somebody else. The member list has exactly one row per player, so if that
        // member is already accounted for, the best available reading of THIS row can't
        // be them — and dropping it silently loses a real player. Measured: "Fain" is a
        // new player 1 edit from existing member "Bain" on a 4-character name, which is
        // the floor any fuzzy matcher has to allow, so distance alone can never separate
        // them. Treated as new instead, which surfaces them in the review queue with a
        // crop rather than vanishing.
        if (member && hit && !hit.exact && seenMemberIds.has(member.id)) {
            // ...unless it's the SAME row read twice with homoglyph damage. Scroll overlap
            // shows each row on 2-3 pages, and a capital-I read as a lowercase-l produces a
            // second string for one player ("mikl" then "mikI"). That is one edit either
            // way, so distance can't separate it from a genuinely different player — but the
            // characters can: only OCR-confusable ones differ. Without this check every such
            // wobble created a duplicate member, which is what production did with "mikI".
            const claimant = claimedBy.get(member.id) ?? '';
            if (sameOcrSkeleton(readName, claimant)) {
                collapsedPairs.push(`${shownName} → ${member.name}`);
                continue;
            }
            promoted.push(`${shownName} (would have merged into ${member.name})`);
            member = null;
        }
        if (!member) {
            // A name the roster doesn't know is a real new player often enough to be
            // worth importing: the in-game member list IS the clan roster, so a name on
            // it is better evidence of membership than a chest. Someone who joins
            // between the roster build and their first chest would otherwise be
            // invisible until they earned one.
            //
            // Created, not silently trusted. A fresh member row has first_seen = now,
            // which puts it straight into the New Members review queue, and the crop
            // saved during capture rides along as the evidence an admin needs to tell a
            // genuine new player from an OCR-mangled version of someone already listed.
            try {
                member = memberRepo.upsertMember(readName, clanId);
                created.push(readName);
                // Add to the ACTIVE pool immediately so a second, differently-garbled read
                // of the same player later in this same capture matches this row instead
                // of creating a second one — the live roster showed "RebelTurk" and
                // "RebenTurk" as two reads of one member.
                activeMembers.push(member);
            }
            catch (err) {
                failed.push(`${shownName} (${err instanceof Error ? err.message : String(err)})`);
                continue;
            }
        }
        else if (hit?.viaInactive) {
            matchedInactive++;
        }
        // Only reachable now for an EXACT collision — two readings both matching one
        // member exactly, which means one player under two names they own (a name and an
        // alias). The first reading stands. Counted rather than only debug-logged
        // because it's a reason "N readings" and "N members recorded" can differ, and an
        // unexplained gap between those two numbers reads like lost data.
        if (seenMemberIds.has(member.id)) {
            collapsedPairs.push(`${shownName} → ${member.name}`);
            continue;
        }
        seenMemberIds.add(member.id);
        claimedBy.set(member.id, readName);
        snapshots.push({
            memberId: member.id, might: row.might, level: row.level, cropPath: row.cropPath,
        });
    }
    // Members whose row was read but whose number was clipped off the crop edge were
    // still SIGHTED — being in the member list is what proves clan membership, and a
    // missing power number doesn't change that. Resolve them too so the sweep below
    // counts them, but deliberately don't create anything for a name in this state:
    // there's no snapshot to hang it on, no evidence crop, and it's usually the same
    // transient clipping that the next page resolves anyway.
    for (const name of capture.unresolvedNames) {
        const hit = resolve(name);
        if (hit)
            seenMemberIds.add(hit.member.id);
    }
    // Feed the sighting back into the inactivity sweep.
    //
    // The sweep soft-removes anyone not seen for their clan's threshold, and "seen"
    // used to mean only "turned up in a chest or gift scan" — so a player who went a
    // week without earning a chest was removed while the game still listed them in
    // the clan. Appearing on the member list is now a sighting in its own right,
    // which also reactivates anyone the sweep had already removed on that basis.
    const seen = memberRepo.markMembersSeen(clanId, [...seenMemberIds], new Date().toISOString());
    const heroLevelsRead = snapshots.filter((s) => (s.level ?? 0) > 0).length;
    const rowsWritten = mightRepo.saveSnapshots(clanId, gameDate, new Date().toISOString(), snapshots);
    // The full resolved set at debug. The per-page lines from might-capture.ts
    // already sample the raw readings at info; this is the post-matching view —
    // what actually got attributed to whom — for when a value looks wrong and the
    // question is "did OCR misread it, or did it land on the wrong member?".
    if (snapshots.length > 0) {
        log.debug(`Might recorded for clan #${clanId} (${gameDate}): `
            + snapshots.map((s) => `#${s.memberId}=${s.might.toLocaleString('en-US')}`).join(', '));
    }
    log.info(`Might capture for clan #${clanId} (${gameDate}): ${rowsWritten} member(s) recorded from ` +
        `${capture.rows.length} reading(s) across ${capture.pagesScanned} page(s)` +
        // Every term below explains a gap between those first two numbers, so a
        // discrepancy never has to be guessed at.
        (collapsedPairs.length > 0
            ? `, ${collapsedPairs.length} reading(s) collapsed onto a member already read`
            : '') +
        (promoted.length > 0
            ? `, ${promoted.length} near-miss reading(s) treated as separate players`
            : '') +
        (created.length > 0 ? `, ${created.length} new member(s) created` : '') +
        (failed.length > 0 ? `, ${failed.length} member(s) failed to create` : '') +
        (matchedInactive > 0 ? `, ${matchedInactive} matched a previously-inactive member` : '') +
        (seen.reactivated > 0 ? `, ${seen.reactivated} reactivated by being on the list` : '') +
        (capture.disagreements > 0 ? `, ${capture.disagreements} re-read disagreement(s)` : '') +
        (capture.unresolvedNames.length > 0
            ? `, ${capture.unresolvedNames.length} member(s) never yielded a number`
            : '') +
        // Only mentioned when some came through, so a deployment whose crop stops right
        // of the avatars isn't told daily about a field it isn't collecting.
        (heroLevelsRead > 0 ? `, ${heroLevelsRead} hero level(s)` : ''));
    // Two readings landing on one member means the OTHER player is missing, so say
    // which pairs did it. Almost always one player read twice with a wobble on one
    // pass (the sweep dedupes by text and overlaps rows 2–3 times, so a single
    // character difference makes two entries) — but the same line would expose the
    // dangerous case, two DIFFERENT players collapsing, which would mean the fuzzy
    // matcher is too loose for that pair. An admin can tell those apart at a glance;
    // a bare count cannot.
    if (collapsedPairs.length > 0) {
        log.warn({ noAlert: true }, `Might capture for clan #${clanId}: ${collapsedPairs.length} reading(s) matched a member ` +
            `another reading had already claimed exactly — ${collapsedPairs.join(', ')}. That means one ` +
            'player was read under two names they both own (a name and an alias), so the first reading ' +
            'stands and only the count is affected.');
    }
    if (promoted.length > 0) {
        // The interesting one: distance said "existing member", but that member was
        // already accounted for by another row, so this row is someone else.
        log.warn({ noAlert: true }, `Might capture for clan #${clanId}: ${promoted.length} reading(s) were close to an existing ` +
            `member who had already been read, so they were treated as separate players — ` +
            `${promoted.join(', ')}. Check them in the New Members review queue: if one really is the ` +
            'same player under a mangled name, merge it, and consider adding an alias so the next capture ' +
            'resolves it directly.');
    }
    // Coverage check, against MEMBERS RECORDED rather than readings taken.
    //
    // Comparing readings was wrong and hid exactly the case that prompted this: 87
    // readings against an 87-strong roster looks like full coverage, while only 85 of
    // them became members. Naming the members who got nothing today is the version of
    // this an operator can act on.
    const missed = activeMembers.filter((m) => !seenMemberIds.has(m.id));
    if (missed.length > 0) {
        log.warn({ noAlert: true }, `Might capture for clan #${clanId}: ${missed.length} active member(s) got no reading today — ` +
            `${missed.slice(0, NAME_SAMPLE_LIMIT).map((m) => m.name).join(', ')}` +
            `${missed.length > NAME_SAMPLE_LIMIT ? ', …' : ''}. ` +
            'Either the sweep never reached their row, or their name was read differently enough to land ' +
            'on someone else (see any collapsed-reading warning above). They keep yesterday\'s value; the ' +
            'chart simply has no point for them today.');
    }
    if (created.length > 0) {
        // Informational: meeting a new player is normal, not a fault, so this must not
        // light the System nav dot. The review queue is where it gets acted on.
        log.warn({ noAlert: true }, `Might capture for clan #${clanId}: created ${created.length} member(s) seen on the in-game ` +
            `list but not on our roster — ${created.slice(0, NAME_SAMPLE_LIMIT).join(', ')}` +
            `${created.length > NAME_SAMPLE_LIMIT ? ', …' : ''}. ` +
            'They are in the New Members review queue with a screenshot crop of their row; acknowledge ' +
            'or merge them there if any is an OCR-mangled duplicate of an existing member.');
    }
    if (failed.length > 0) {
        // A member row that wouldn't insert means that player is missing from the
        // roster and their might is unrecorded — worth a real alert.
        log.warn(`Might capture for clan #${clanId}: failed to create ${failed.length} member(s) — ` +
            `${failed.slice(0, NAME_SAMPLE_LIMIT).join('; ')}`);
    }
    // One audit row per clan per day: this feature can only be exercised against
    // the live game, so a durable record of what each capture actually did is
    // worth more than a clean audit log.
    (0, user_repo_js_1.logSystemAction)(clanId, 'member.might_capture', {
        clanId,
        gameDate,
        recorded: rowsWritten,
        read: capture.rows.length,
        collapsed: collapsedPairs.length,
        missedMembers: activeMembers.filter((m) => !seenMemberIds.has(m.id)).map((m) => m.name),
        matchedInactive,
        reactivated: seen.reactivated,
        markedSeen: seen.updated,
        createdMembers: created,
        failedMembers: failed.length,
        pages: capture.pagesScanned,
    });
    // A new member changes the review-queue badge, and its count is memoized —
    // drop it so the nav dot appears on the next poll rather than up to a minute
    // later.
    if (created.length > 0)
        (0, review_queue_repo_js_1.invalidateReviewQueueCount)(clanId);
    reportProgress?.(`Might captured for ${rowsWritten} member(s).`);
    return { ran: true, gameDate, matched: rowsWritten, created, rowsWritten };
}
//# sourceMappingURL=might-capture-phase.js.map