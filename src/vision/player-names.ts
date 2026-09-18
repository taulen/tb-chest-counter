/**
 * Player-name OCR cleanup and fuzzy matching against the known-member
 * list. Shared normalizers and edit distance live in ocr-normalize.ts.
 */
import {
  ocrNormalize, normalizeNonLatin, levenshtein, despace, namesDifferByAltSuffix,
} from './ocr-normalize.js';

/**
 * Clean up an OCR player name: strip trailing periods, quotes, pipe
 * chars, and any "Time left" text that leaked through.
 */
export function cleanPlayerName(ocrName: string): string {
  return ocrName
    .replace(/\s*['"]*\s*(?:t(?:ime|ome|iel|imed?)|mel)\s*left.*$/i, '') // Strip "Time left:..." suffix
    .replace(/\s*['"]+\s*:?\s*$/, '') // Trailing ' or ': (OCR artifact from Time left)
    // Strip leading OCR junk FIRST so a single bad leading char doesn't
    // cause the trailing-truncate regex below to wipe the entire name.
    // Players sometimes decorate their name with symbols Tesseract can't
    // read (e.g. "ツ Lucifer ツ"), and those chars come back as (, ), ],
    // ©, etc. Previously "ツ Lucifer ツ" OCR'd as ") Lucifer )" and the
    // truncator matched the leading ")" → empty string.
    .replace(/^[©®)(\[\]{}@#$%^&*<>~?"|'™=]+\s*/, '')
    // Truncate at the first remaining junk char — valid player names
    // only contain letters, digits, spaces, periods, hyphens and
    // apostrophes, so any of these mid-string indicates card-border
    // noise like "Roli girl © a S65) 95.48".
    .replace(/[©®)()\[\]{}@#$%^&*<>~]+.*$/, '')
    .replace(/[.|,'"]+$/, '')     // Trailing punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True when a string is predominantly non-Latin script — a genuinely
 * Arabic / Cyrillic / CJK / Hangul / etc. player name, rather than a
 * Latin name carrying a few stray Cyrillic homoglyphs.
 *
 * Used by the scanner to choose between the two OCR passes: the
 * multi-language worker reads non-Latin names correctly, while the
 * English-only worker transliterates them into garbage Latin
 * ("أوزيريس" → "gs sow"). When this returns true the multi-language
 * reading is authoritative; when false the English-bias logic applies.
 *
 * Counts letters by script and requires non-Latin letters to strictly
 * outnumber Latin ones, so a homoglyph-tainted Latin name ("Аndre" —
 * one leading Cyrillic char among four Latin) still counts as Latin.
 * Accented Latin letters (é, ñ, ü) count as Latin via the Latin script
 * class. Non-letter characters (digits, spaces, punctuation) are ignored.
 */
export function isLikelyNonLatinName(s: string): boolean {
  let latin = 0;
  let nonLatin = 0;
  for (const ch of s) {
    if (/\p{Script=Latin}/u.test(ch)) latin++;
    else if (/\p{L}/u.test(ch)) nonLatin++;
  }
  return nonLatin > latin;
}

/**
 * Find the closest matching known player name from the DB.
 *
 * For Latin names, uses three strategies in order of specificity:
 *   1. Exact normalized match (lowercase + strip non-alnum)
 *   2. OCR-normalized exact match (also maps 0↔o, 5↔S, Cyrillic↔Latin)
 *   3. Levenshtein distance (character-level typos)
 *
 * For non-Latin names (Arabic / Cyrillic / CJK / ...), the Latin
 * normalizers above strip the string to nothing, so a dedicated path
 * matches on the Unicode-aware `normalizeNonLatin` form instead —
 * otherwise a genuinely Arabic member could never be recognised even
 * when they're already in the DB.
 *
 * Returns the DB name if a close match is found, otherwise the input.
 *
 * `exactOnlyNames` are additionally eligible for the two EXACT tiers but never for
 * the Levenshtein one. The caller passes inactive members there, and that asymmetry
 * fixes a real, self-perpetuating misattribution:
 *
 * The scan pool is restricted to ACTIVE members so a brand-new player's name can't
 * round to a departed one by distance. Sound on its own, but it also meant an
 * inactive member's EXACT name was invisible — so when a scan read "Bardin" (a real
 * member, temporarily inactive) the only candidate within reach was active member
 * "Bain", 2 edits away. Every one of Bardin's chests was filed under Bain, and
 * because the name resolved to "Bain" it never reached upsertMember("Bardin") to
 * reactivate him. Once absorbed he could never come back on his own. Confirmed on
 * the live roster after months of it happening.
 *
 * So: exact over everyone, distance over active members only. That keeps the
 * original protection (a new name still can't fuzzy-match a departed member) while
 * making it impossible for a neighbour to steal a name its owner spells exactly.
 */
export function matchKnownPlayer(
  ocrName: string,
  knownNames: string[],
  exactOnlyNames: string[] = [],
): string {
  if (!ocrName || (knownNames.length === 0 && exactOnlyNames.length === 0)) return ocrName;

  /** Every name allowed to win an exact match, owner-of-the-name first. */
  const exactCandidates = exactOnlyNames.length > 0
    ? [...knownNames, ...exactOnlyNames]
    : knownNames;

  // The despaced lookup key — spacing and punctuation removed, so every OCR
  // spacing variant of one name compares equal before any distance is measured.
  // Shared with fuzzy.ts and member-repo so the gift scan, the might capture,
  // the resource reader and the roster all agree on what counts as one name.
  const normInput = despace(ocrName);

  // Non-Latin name: the ASCII normalizers strip it to nothing. Match on
  // the Unicode-aware normalized form (NFKC + diacritics/bidi stripped).
  if (!normInput) {
    const nlInput = normalizeNonLatin(ocrName);
    if (!nlInput) return ocrName;

    // Exact normalized match.
    for (const name of exactCandidates) {
      if (normalizeNonLatin(name) === nlInput) return name;
    }

    // Levenshtein — non-Latin OCR is noisy. Pick the closest match,
    // and scale the budget with length exactly like the Latin path
    // so short names don't collide (≤ 1 edit under 6 chars, ≤ 2 above).
    let bestMatch = '';
    let bestDist = Infinity;
    for (const name of knownNames) {
      const nlKnown = normalizeNonLatin(name);
      // Same alt-suffix rule as the Latin path below: normalizeNonLatin keeps digits,
      // so a name and its "… 2" sit one edit apart here too.
      if (namesDifferByAltSuffix(ocrName, name)) continue;
      if (nlKnown.length >= 3 && nlInput.length >= 3) {
        const maxLen = Math.max(nlInput.length, nlKnown.length);
        const allowedDist = maxLen >= 6 ? 2 : 1;
        const dist = levenshtein(nlInput, nlKnown);
        if (dist <= allowedDist && dist < bestDist) {
          bestDist = dist;
          bestMatch = name;
        }
      }
    }
    return bestMatch || ocrName;
  }

  // 1. Exact normalized match (fast, no false positives)
  for (const name of exactCandidates) {
    if (despace(name) === normInput) return name;
  }

  // 2. OCR-normalized exact match — handles digit↔letter confusions
  // like oSo→050 (o→0, S→5), which basic normalization misses
  // because it only lowercases and strips punctuation.
  //
  // This tier is where "FELI 2" was landing on member "FELI": ocrNormalize maps the
  // digits it treats as letters and then DELETES the rest, so both sides came out as
  // "feli" and the two players matched exactly, one tier above anything that measures
  // a distance. namesDifferByAltSuffix is what tells the two apart — see its comment
  // for why the 2 is identity and the 0/1/5/8 this tier exists for are not.
  const ocrNormInput = ocrNormalize(ocrName);
  if (ocrNormInput) {
    for (const name of exactCandidates) {
      if (ocrNormalize(name) === ocrNormInput && !namesDifferByAltSuffix(ocrName, name)) {
        return name;
      }
    }
  }

  // 3. (Removed) Substring containment was previously used to catch
  // heavy OCR noise that exceeded the Levenshtein budget (e.g. 4+
  // extra chars added to a name). After the OCR pipeline matured to
  // the point where heavy noise is rare, the tier was a net negative:
  // any 3-char substring of a member's name fragment-matched into
  // that member (e.g. "che", "lan", "anc" all silently landed on
  // "Avalanche" because they appear in "avalanche"). Even tightening
  // both bounds still allowed enough fragments through to be unsafe.
  // Levenshtein (≤ 2 edits) covers every realistic clean-OCR typo;
  // a name with 3+ extra chars of noise falls through to upsertMember
  // as a (potentially new) member and surfaces in the review queue
  // instead of being silently misattributed.

  // 4. Levenshtein distance for names ≥ 3 chars. Pick the CLOSEST
  // match (smallest distance), not the first one found — "Babine"
  // should match "Balbine" (distance 1) over "Bain" (distance 2)
  // regardless of member-list order.
  //
  // Threshold scales with name length so short names don't collide
  // with similarly-short unrelated names: distance ≤ 2 collapses
  // "Niien" → "Biin" (4- and 5-char distinct players, edit distance
  // exactly 2). Require ≤ 1 when the longer of the two strings has
  // fewer than 6 chars; ≤ 2 otherwise — that keeps the documented
  // longer-name typo case ("PropofolDok" → "PropofolDoc", 11 chars,
  // dist 1) working while rejecting short-name false positives.
  let bestLevMatch = '';
  let bestLevDist = Infinity;
  for (const name of knownNames) {
    const normKnown = despace(name);
    // An alt suffix is identity, not damage: "FELI 2" is 1 edit from member "FELI"
    // on a 5-character name, which is inside the smallest budget any fuzzy matcher
    // can have. Only the characters can separate them.
    if (namesDifferByAltSuffix(ocrName, name)) continue;
    if (normKnown.length >= 3 && normInput.length >= 3) {
      const maxLen = Math.max(normInput.length, normKnown.length);
      const allowedDist = maxLen >= 6 ? 2 : 1;
      const dist = levenshtein(normInput, normKnown);
      if (dist <= allowedDist && dist < bestLevDist) {
        bestLevDist = dist;
        bestLevMatch = name;
      }
    }
  }
  if (bestLevMatch) return bestLevMatch;

  return ocrName;
}
