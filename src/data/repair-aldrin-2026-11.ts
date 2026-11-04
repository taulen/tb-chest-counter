/**
 * One-time data repair for clan #3 (SIK), run by migration v91.
 *
 * "Cauldron" renamed in game to "Aldrin" early on Nov 3 2026 (same player: might
 * 488.2M → 490.4M overnight, the Cauldron series ends the day Aldrin's begins). Two
 * things went wrong:
 *
 *  1. Until the might capture created the Aldrin row at 17:18 UTC, the gift scan
 *     had no "Aldrin" to match, and "Aldrin" is 2 edits from member "Ilrin" — inside
 *     the fuzzy budget. Scans 8002, 8008, 8010 and 8012 filed Aldrin's chests under
 *     Ilrin (138 rows that day against Ilrin's usual ~15). Fixed going forward by the
 *     repeated-reading guard in matchKnownPlayer.
 *  2. Aldrin's history up to the rename sits on the Cauldron row.
 *
 * Raw OCR capture was off, so the rows were identified by aligning each session's
 * inserted rows (they insert in crop order) against the probe OCR text logged per
 * crop: 75 rows were read "From: Aldrin" outright, the rest are cards past the log's
 * truncation point that match Aldrin's crypt profile and sit between Aldrin reads.
 * Left on Ilrin: 743990, 743991, 744302, 744304 (read "From: Ilrin") and 743992
 * (unlogged, directly after two Ilrin reads of the same crypt tier). The three
 * triumphal Bronze Chests in 8002 were logged "From: Aldrin".
 *
 * Guarded on id + name + clan for every member involved, so it is a no-op on any
 * other database (fresh installs, tests, a restore of an unrelated backup) and safe
 * to replay: the row move only touches rows still on Ilrin, and the merge only runs
 * while a Cauldron row exists.
 */
import type Database from 'better-sqlite3';
import { addMergeRule } from './repositories/merge-repo.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('repair-aldrin');

const CLAN_ID = 3;
const ILRIN = { id: 1508, name: 'Ilrin' };
const ALDRIN = { id: 1527, name: 'Aldrin' };
const CAULDRON = { id: 1354, name: 'Cauldron' };

/** chest_records rows filed under Ilrin that were Aldrin's. */
export const MISFILED_CHEST_IDS: readonly number[] = [
  743278, 743280, 743282, 743283, 743284, 743285, 743286, 743298, 743309, 743310,
  743313, 743317, 743318, 743322, 743324, 743326, 743328, 743330, 743334, 743336,
  743339, 743343, 743345, 743347, 743348, 743404, 743406, 743408, 743411, 743414,
  743416, 743419, 743423, 743425, 743427, 743428, 743429, 743430, 743431, 743432,
  743433, 743434, 743435, 743436, 743437, 743438, 743439, 743440, 743441, 743442,
  743443, 743444, 743445, 743446, 743447, 743448, 743449, 743450, 743451, 743452,
  743994, 743995, 743997, 743998, 743999, 744000, 744001, 744002, 744003, 744004,
  744005, 744008, 744009, 744013, 744014, 744103, 744104, 744105, 744106, 744108,
  744111, 744112, 744114, 744115, 744117, 744118, 744119, 744120, 744168, 744169,
  744170, 744171, 744172, 744174, 744176, 744177, 744178, 744179, 744183, 744185,
  744187, 744189, 744193, 744301, 744303, 744315, 744316, 744317, 744324, 744325,
  744327, 744329, 744387, 744388, 744389, 744390, 744392, 744395, 744398, 744401,
  744404, 744407, 744522, 744524, 744528, 744529, 744530, 744531, 744532, 744534,
  744536, 744543, 744545,
];

/** triumphal_chest_records rows filed under Ilrin that were Aldrin's. */
export const MISFILED_TRIUMPHAL_IDS: readonly number[] = [28027, 28028, 28029];

function memberIs(database: Database.Database, m: { id: number; name: string }): boolean {
  return database.prepare('SELECT 1 FROM members WHERE id = ? AND clan_id = ? AND name = ?')
    .get(m.id, CLAN_ID, m.name) !== undefined;
}

export function repairAldrin(database: Database.Database): void {
  if (!memberIs(database, ALDRIN)) return;

  if (memberIs(database, ILRIN)) {
    const placeholders = (ids: readonly number[]) => ids.map(() => '?').join(',');
    const moved = database.prepare(
      `UPDATE chest_records SET member_id = ?
        WHERE clan_id = ? AND member_id = ? AND id IN (${placeholders(MISFILED_CHEST_IDS)})`,
    ).run(ALDRIN.id, CLAN_ID, ILRIN.id, ...MISFILED_CHEST_IDS).changes;
    const movedTriumphal = database.prepare(
      `UPDATE triumphal_chest_records SET member_id = ?
        WHERE clan_id = ? AND member_id = ? AND id IN (${placeholders(MISFILED_TRIUMPHAL_IDS)})`,
    ).run(ALDRIN.id, CLAN_ID, ILRIN.id, ...MISFILED_TRIUMPHAL_IDS).changes;
    if (moved + movedTriumphal > 0) {
      log.info(`Clan #${CLAN_ID}: moved ${moved} chest(s) and ${movedTriumphal} triumphal chest(s) from Ilrin back to Aldrin`);
    }
  }

  if (memberIs(database, CAULDRON)) {
    // Aldrin's row was minted on Nov 3; once Cauldron's history is on it, the player
    // has been here since Cauldron's first sighting. Without this the merged member
    // reads as a brand-new joiner in the New Members queue and on their profile.
    database.prepare(
      `UPDATE members SET first_seen = (SELECT first_seen FROM members WHERE id = ?)
        WHERE id = ? AND first_seen > (SELECT first_seen FROM members WHERE id = ?)`,
    ).run(CAULDRON.id, ALDRIN.id, CAULDRON.id);
    // The same merge the Members page performs: rule + alias so a leftover
    // "From: Cauldron" card still lands on Aldrin, and every table remapped.
    addMergeRule('player', CAULDRON.name, ALDRIN.name, CLAN_ID);
    log.info(`Clan #${CLAN_ID}: merged "Cauldron" into "Aldrin" (in-game rename)`);
  }
}
