"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.artifactEffectIndex = artifactEffectIndex;
exports.describeArtifact = describeArtifact;
exports.artifactsFromEffects = artifactsFromEffects;
const indexMemo = new WeakMap();
/** Effect id → which artifact type it belongs to and what it is. */
function artifactEffectIndex(artifacts) {
    const memo = indexMemo.get(artifacts);
    if (memo)
        return memo;
    const out = new Map();
    for (const [typeKey, a] of Object.entries(artifacts)) {
        const type = Number(typeKey);
        for (const [id, [n]] of Object.entries(a.levels ?? {}))
            out.set(Number(id), { type, kind: 'level', n });
        for (const [id, [n]] of Object.entries(a.stars ?? {}))
            out.set(Number(id), { type, kind: 'star', n });
        for (const id of Object.keys(a.bonuses ?? {}))
            out.set(Number(id), { type, kind: 'bonus', n: 0 });
    }
    indexMemo.set(artifacts, out);
    return out;
}
/** What the artifact book shows for one artifact at this level / star level / rolls. Pure. */
function describeArtifact(type, level, star, bonuses, artifacts) {
    const a = artifacts?.[String(type)];
    const linesAt = (rows, n) => Object.values(rows ?? {}).find(([at]) => at === n)?.[1] ?? [];
    const bonusLines = bonuses
        .map((id, i) => {
        const b = a?.bonuses?.[String(id)];
        return { text: b?.[0] ?? `#${id}`, value: b?.[1] ?? '', quality: b?.[2] ?? 0, i };
    })
        .sort((x, y) => y.quality - x.quality || x.i - y.i)
        .map(({ text, value, quality }) => ({ text, value, quality }));
    return {
        name: a?.name ?? `#${type}`,
        rarity: a?.rarity ?? 0,
        rarityName: a?.rarityName ?? '',
        icon: a?.icon ?? '',
        maxLevel: a?.maxLevel ?? 0,
        maxStar: a?.maxStar ?? 0,
        levelLines: linesAt(a?.levels, level),
        starLines: linesAt(a?.stars, star),
        bonusLines,
    };
}
/** The artifacts the line-up captains wear, by type ascending. Pure. */
function artifactsFromEffects(effects, artifacts) {
    if (!artifacts || !effects.length)
        return [];
    const index = artifactEffectIndex(artifacts);
    const byType = new Map();
    const get = (type) => {
        let a = byType.get(type);
        if (!a)
            byType.set(type, (a = { type, level: 0, star: 0, bonuses: [] }));
        return a;
    };
    for (const e of effects) {
        const ref = index.get(e.id);
        if (!ref)
            continue;
        const a = get(ref.type);
        if (ref.kind === 'level')
            a.level = Math.max(a.level, ref.n);
        else if (ref.kind === 'star')
            a.star = Math.max(a.star, ref.n);
        else
            for (let i = 0; i < Math.max(1, e.count); i++)
                a.bonuses.push(e.id);
    }
    return [...byType.values()]
        .map((a) => ({ ...a, bonuses: [...a.bonuses].sort((x, y) => x - y) }))
        .sort((x, y) => x.type - y.type);
}
//# sourceMappingURL=artifacts.js.map