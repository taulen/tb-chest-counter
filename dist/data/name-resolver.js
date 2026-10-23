"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveNamesToMembers = resolveNamesToMembers;
/**
 * Match names a person pasted (an in-game ranking, a chat log) to clan members.
 *
 * Same order as the might capture's resolveMember, for the same reasons:
 *   1. a player merge rule outranks everything, and matches EXACTLY;
 *   2. every exact pass (name, alias, despaced key) across active AND inactive
 *      members before any distance pass;
 *   3. then the fuzzy tier (utils/fuzzy.ts), active members first.
 * A member is claimed once per batch: exact matches go first, and a fuzzy hit
 * on a member someone else already holds stays unmatched for review rather
 * than handing one player two rows.
 *
 * Never creates a member. Pasted text is not evidence that a player exists the
 * way a scan is; an unknown name stays unknown until an admin says who it is.
 *
 * Shared by the Tin Man standings (tinman-repo.ts) and the chat level import
 * (member-levels-repo.ts).
 */
const member_repo_js_1 = require("./repositories/member-repo.js");
const merge_repo_js_1 = require("./repositories/merge-repo.js");
const fuzzy_js_1 = require("../utils/fuzzy.js");
/**
 * Resolve `names` in one batch. `preset[i]`, when given, is a decision already
 * made for name i (an admin's own pick); it is kept as-is and its member is
 * claimed before anything else is matched.
 */
function resolveNamesToMembers(clanId, names, preset = []) {
    const all = (0, member_repo_js_1.getAllMembers)(false, clanId);
    const active = all.filter((m) => m.isActive);
    const inactive = all.filter((m) => !m.isActive);
    const canonicalise = (0, merge_repo_js_1.loadPlayerNameCanonicaliser)(clanId);
    const out = names.map(() => ({ member: null, kind: 'unmatched' }));
    const decided = names.map((_, i) => preset[i] !== undefined);
    const claimed = new Set();
    // Pass 0: decisions already made.
    names.forEach((_, i) => {
        const d = preset[i];
        if (!d)
            return;
        if (d.member && claimed.has(d.member.id))
            return; // stays unmatched, still decided
        out[i] = d;
        if (d.member)
            claimed.add(d.member.id);
    });
    // Pass 1: merge rules and exact matches, across both pools.
    names.forEach((name, i) => {
        if (decided[i])
            return;
        const canonical = canonicalise(name);
        const member = (0, fuzzy_js_1.exactMatchMember)(canonical, active) ?? (0, fuzzy_js_1.exactMatchMember)(canonical, inactive);
        if (member && !claimed.has(member.id)) {
            out[i] = { member, kind: 'exact' };
            claimed.add(member.id);
        }
    });
    // Pass 2: distance, active members first, never onto a claimed member — and
    // never past a merge rule: the rule is the admin's word, so a rule whose
    // destination isn't a member stays unmatched rather than being guessed past.
    names.forEach((name, i) => {
        if (decided[i] || out[i].member)
            return;
        if (canonicalise(name) !== name)
            return;
        for (const pool of [active, inactive]) {
            const member = (0, fuzzy_js_1.fuzzyMatchMember)(name, pool.filter((m) => !claimed.has(m.id)));
            if (member) {
                out[i] = { member, kind: 'fuzzy' };
                claimed.add(member.id);
                return;
            }
        }
    });
    return out;
}
//# sourceMappingURL=name-resolver.js.map