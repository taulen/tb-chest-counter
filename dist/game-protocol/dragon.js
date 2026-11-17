"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.dragonBonusText = void 0;
exports.dragonView = dragonView;
/** A bonus value as the game shows it: a percent with its sign. */
const dragonBonusText = (v) => `${v >= 0 ? '+' : ''}${v}%`;
exports.dragonBonusText = dragonBonusText;
/**
 * Bonus lines for `now`, and the `next` values of the lines that change: a
 * line shows when either side gives anything (ten zeros at level 1 say
 * nothing), and a next value only where it moves — one level up changes one
 * or two of the ten lines, and "+114% › +114%" eight times over hides them.
 */
function linesOf(d, now, next) {
    const out = { now: [], next: [] };
    d.bonusNames.forEach((name, i) => {
        const a = now[i] ?? 0;
        const b = next ? next[i] ?? 0 : 0;
        if (!a && !b)
            return;
        out.now.push([name, (0, exports.dragonBonusText)(a)]);
        if (next && b !== a)
            out.next.push([name, (0, exports.dragonBonusText)(b)]);
    });
    return out;
}
/**
 * The view of a stored dragon, or null when there is none (no dragon yet, or
 * the static data has no T73 — a names.json from before format 9).
 */
function dragonView(names, stored, artUrl) {
    const d = names?.dragon;
    const level = Number(stored?.level);
    if (!d || !Number.isInteger(level) || level < 1 || level > d.xp.length)
        return null;
    const maxLevel = d.xp.length;
    const stageNums = Object.keys(d.stages).map(Number).filter(Number.isInteger);
    const maxStage = stageNums.length ? Math.max(...stageNums) : 0;
    const stageNum = Number(stored?.stage);
    const stage = Number.isInteger(stageNum) && d.stages[String(stageNum)] ? stageNum : null;
    const st = stage !== null ? d.stages[String(stage)] : null;
    const nextSt = stage !== null ? d.stages[String(stage + 1)] ?? null : null;
    const xp = typeof stored?.xp === 'number' && Number.isFinite(stored.xp) ? stored.xp : null;
    const atTop = level >= maxLevel;
    const lv = linesOf(d, d.levelBonuses[level - 1] ?? [], atTop ? null : d.levelBonuses[level] ?? null);
    const sv = st ? linesOf(d, st.bonuses, nextSt ? nextSt.bonuses : null) : { now: [], next: [] };
    const url = (n) => (n ? artUrl(n) : null);
    return {
        name: typeof stored?.name === 'string' && stored.name.trim() ? stored.name.trim() : null,
        title: d.name,
        level,
        maxLevel,
        stage,
        maxStage,
        levelCap: st?.levelCap ?? null,
        xp,
        xpFloor: d.xp[level - 1] ?? null,
        xpNext: atTop ? null : d.xp[level] ?? null,
        atCap: !!st && !atTop && level >= st.levelCap,
        levelLines: lv.now,
        nextLevel: atTop ? null : { level: level + 1, lines: lv.next },
        stageLines: sv.now,
        nextStage: st && nextSt && stage !== null ? { stage: stage + 1, levelCap: nextSt.levelCap, lines: sv.next } : null,
        iconUrl: url(st?.icon ?? ''),
        frameUrl: url(d.art.frame),
        artUrl: url(st?.art ?? ''),
        backUrl: url(d.art.back),
    };
}
//# sourceMappingURL=dragon.js.map