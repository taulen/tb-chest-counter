/**
 * The words of the chat command replies (scheduler/chat-commands.ts), per
 * language: en / es / fr / ru / de, the site's languages. The words for the
 * board's figures are the site's own (Might, Guards, Gold Pass, On pace,
 * Behind pace … in lib/i18n/*.js), so a reply and the page say the same.
 * The command words themselves stay English in every language (they always
 * work); localized ones are accepted too (chat-commands.ts ALIASES).
 *
 * Replies are plain text: no link (the game blocks them), glyph AND words for
 * every state (✓ reached, ◐ on pace, ↓ behind).
 */
import type { UserLanguage } from '../data/repositories/user-repo.js';

export type ReplyLanguage = UserLanguage;

/** Plural forms, picked by Intl.PluralRules (Russian has few/many). */
export interface Forms { one: string; few?: string; many?: string; other: string }

export interface CommandTexts {
  locale: string;
  points: Forms;
  chests: Forms;
  /** "this week (day 3 of 7)", lower case, mid-sentence. */
  thisWeek: (day: number, days: number) => string;
  rankOf: (rank: number, total: number) => string;
  today: (what: string) => string;
  goalReached: (goal: string) => string;
  goalOnPace: (goal: string, pace: string) => string;
  goalBehind: (goal: string, pace: string, toGo: string) => string;
  lastWeek: (what: string) => string;
  might: string;
  guards: string;
  goldPass: string;
  goldPassPrevious: string;
  topHead: (n: number, week: string) => string;
  pointsChests: string;
  you: string;
  progressHead: (name: string, weeks: number) => string;
  goalWord: string;
  notInClanYet: string;
  thisWeekSoFar: string;
  eventsHead: string;
  /** A running event; `left` null when its end isn't known. */
  liveNow: (name: string, left: string | null) => string;
  nextUp: (name: string, until: string) => string;
  noEvents: string;
  calendarDown: string;
  units: { d: string; h: string; m: string; space: boolean };
  missingHead: (week: string, n: number, total: number) => string;
  missingPace: (pace: string, goal: string) => string;
  nobodyBehind: (week: string) => string;
  noGoal: string;
  andMore: (n: number) => string;
  leadersOnly: string;
  notOnBoard: string;
  helpHead: string;
  helpCode: string;
  /** The same in the group chat: the code never goes there. */
  helpCodePrivate: string;
  helpLeaders: string;
}

const RU_WEEKS: Forms = { one: 'неделя', few: 'недели', many: 'недель', other: 'недели' };

export const COMMAND_TEXTS: Record<ReplyLanguage, CommandTexts> = {
  en: {
    locale: 'en-US',
    points: { one: 'point', other: 'points' },
    chests: { one: 'chest', other: 'chests' },
    thisWeek: (d, n) => `this week (day ${d} of ${n})`,
    rankOf: (r, t) => `#${r} of ${t}`,
    today: (w) => `Today: ${w}`,
    goalReached: (g) => `Weekly goal ${g}: reached ✓`,
    goalOnPace: (g, p) => `Weekly goal ${g}: on pace ◐ (${p} by now)`,
    goalBehind: (g, p, r) => `Weekly goal ${g}: behind pace ↓ (${p} by now) · ${r} to go`,
    lastWeek: (w) => `Last week: ${w}`,
    might: 'Might',
    guards: 'Guards',
    goldPass: 'Gold Pass',
    goldPassPrevious: 'Gold Pass (last cycle)',
    topHead: (n, week) => `Top ${n} ${week}`,
    pointsChests: 'points (chests)',
    you: 'You',
    progressHead: (name, n) => `${name} — last ${n} weeks (points · rank)`,
    goalWord: 'goal',
    notInClanYet: 'not in the clan yet',
    thisWeekSoFar: 'This week so far',
    eventsHead: 'Events',
    liveNow: (name, left) => (left ? `Now: ${name} — ends in ${left}` : `Now: ${name}`),
    nextUp: (name, until) => `Next: ${name} — in ${until}`,
    noEvents: 'No events in the calendar right now.',
    calendarDown: "The event calendar can't be read right now. Try again later.",
    units: { d: 'd', h: 'h', m: 'm', space: false },
    missingHead: (week, n, total) => `Behind pace ${week}: ${n} of ${total}`,
    missingPace: (p, g) => `Pace by now: ${p} of ${g}`,
    nobodyBehind: (week) => `Nobody is behind pace ${week} ✓`,
    noGoal: 'The clan has no weekly goal set, so nobody is behind.',
    andMore: (n) => `… and ${n} more`,
    leadersOnly: 'Only clan leaders can use “missing”.',
    notOnBoard: "I can't find you on the clan's board yet. Try again after the next scan.",
    helpHead: 'TB Chest Counter (the clan tracker by taulen). Message me one word:',
    helpCode: 'code: your code for the site',
    helpCodePrivate: 'code: your code for the site, sent to you privately',
    helpLeaders: 'Leaders: missing',
  },
  es: {
    locale: 'es-ES',
    points: { one: 'punto', other: 'puntos' },
    chests: { one: 'cofre', other: 'cofres' },
    thisWeek: (d, n) => `esta semana (día ${d} de ${n})`,
    rankOf: (r, t) => `#${r} de ${t}`,
    today: (w) => `Hoy: ${w}`,
    goalReached: (g) => `Objetivo semanal ${g}: alcanzado ✓`,
    goalOnPace: (g, p) => `Objetivo semanal ${g}: a buen ritmo ◐ (${p} a estas alturas)`,
    goalBehind: (g, p, r) => `Objetivo semanal ${g}: por detrás del ritmo ↓ (${p} a estas alturas) · faltan ${r}`,
    lastWeek: (w) => `Semana pasada: ${w}`,
    might: 'Poder',
    guards: 'Guardias',
    goldPass: 'Pase de oro',
    goldPassPrevious: 'Pase de oro (ciclo anterior)',
    topHead: (n, week) => `Top ${n} ${week}`,
    pointsChests: 'puntos (cofres)',
    you: 'Tú',
    progressHead: (name, n) => `${name} — últimas ${n} semanas (puntos · puesto)`,
    goalWord: 'objetivo',
    notInClanYet: 'aún no estabas en el clan',
    thisWeekSoFar: 'Esta semana hasta ahora',
    eventsHead: 'Eventos',
    liveNow: (name, left) => (left ? `Ahora: ${name} — termina en ${left}` : `Ahora: ${name}`),
    nextUp: (name, until) => `Próximo: ${name} — en ${until}`,
    noEvents: 'No hay eventos en el calendario ahora mismo.',
    calendarDown: 'No se puede leer el calendario de eventos ahora mismo. Prueba más tarde.',
    units: { d: 'd', h: 'h', m: 'min', space: true },
    missingHead: (week, n, total) => `Por detrás del ritmo ${week}: ${n} de ${total}`,
    missingPace: (p, g) => `Ritmo a estas alturas: ${p} de ${g}`,
    nobodyBehind: (week) => `Nadie va por detrás del ritmo ${week} ✓`,
    noGoal: 'El clan no tiene objetivo semanal, así que nadie va por detrás.',
    andMore: (n) => `… y ${n} más`,
    leadersOnly: 'Solo los líderes del clan pueden usar «missing».',
    notOnBoard: 'Todavía no te encuentro en la clasificación del clan. Prueba de nuevo tras el próximo escaneo.',
    helpHead: 'TB Chest Counter (el tracker del clan de taulen). Escríbeme una palabra:',
    helpCode: 'code: tu código para la web',
    helpCodePrivate: 'code: tu código para la web, te llega en privado',
    helpLeaders: 'Líderes: missing',
  },
  fr: {
    locale: 'fr-FR',
    points: { one: 'point', other: 'points' },
    chests: { one: 'coffre', other: 'coffres' },
    thisWeek: (d, n) => `cette semaine (jour ${d} sur ${n})`,
    rankOf: (r, t) => `#${r} sur ${t}`,
    today: (w) => `Aujourd’hui : ${w}`,
    goalReached: (g) => `Objectif hebdo ${g} : atteint ✓`,
    goalOnPace: (g, p) => `Objectif hebdo ${g} : dans le rythme ◐ (${p} à ce stade)`,
    goalBehind: (g, p, r) => `Objectif hebdo ${g} : en retard sur le rythme ↓ (${p} à ce stade) · encore ${r}`,
    lastWeek: (w) => `Semaine dernière : ${w}`,
    might: 'Puissance',
    guards: 'Gardes',
    goldPass: 'Passe Doré',
    goldPassPrevious: 'Passe Doré (cycle précédent)',
    topHead: (n, week) => `Top ${n} ${week}`,
    pointsChests: 'points (coffres)',
    you: 'Vous',
    progressHead: (name, n) => `${name} — ${n} dernières semaines (points · rang)`,
    goalWord: 'objectif',
    notInClanYet: 'pas encore dans le clan',
    thisWeekSoFar: 'Cette semaine jusqu’ici',
    eventsHead: 'Événements',
    liveNow: (name, left) => (left ? `En cours : ${name} — se termine dans ${left}` : `En cours : ${name}`),
    nextUp: (name, until) => `À venir : ${name} — dans ${until}`,
    noEvents: 'Aucun événement au calendrier pour le moment.',
    calendarDown: 'Le calendrier des événements est illisible pour le moment. Réessayez plus tard.',
    units: { d: 'j', h: 'h', m: 'min', space: true },
    missingHead: (week, n, total) => `En retard sur le rythme ${week} : ${n} sur ${total}`,
    missingPace: (p, g) => `Rythme à ce stade : ${p} sur ${g}`,
    nobodyBehind: (week) => `Personne n’est en retard sur le rythme ${week} ✓`,
    noGoal: 'Le clan n’a pas d’objectif hebdo : personne n’est en retard.',
    andMore: (n) => `… et ${n} de plus`,
    leadersOnly: 'Seuls les chefs du clan peuvent utiliser « missing ».',
    notOnBoard: 'Je ne vous trouve pas encore au classement du clan. Réessayez après le prochain scan.',
    helpHead: 'TB Chest Counter (le tracker de clan de taulen). Écrivez-moi un mot :',
    helpCode: 'code : votre code pour le site',
    helpCodePrivate: 'code : votre code pour le site, envoyé en privé',
    helpLeaders: 'Chefs : missing',
  },
  ru: {
    locale: 'ru-RU',
    points: { one: 'очко', few: 'очка', many: 'очков', other: 'очка' },
    chests: { one: 'сундук', few: 'сундука', many: 'сундуков', other: 'сундука' },
    thisWeek: (d, n) => `на этой неделе (день ${d} из ${n})`,
    rankOf: (r, t) => `#${r} из ${t}`,
    today: (w) => `Сегодня: ${w}`,
    goalReached: (g) => `Недельная цель ${g}: достигнута ✓`,
    goalOnPace: (g, p) => `Недельная цель ${g}: в темпе ◐ (${p} к этому моменту)`,
    goalBehind: (g, p, r) => `Недельная цель ${g}: отставание от темпа ↓ (${p} к этому моменту) · осталось ${r}`,
    lastWeek: (w) => `Прошлая неделя: ${w}`,
    might: 'Могущество',
    guards: 'Гвардия',
    goldPass: 'Золотой пропуск',
    goldPassPrevious: 'Золотой пропуск (прошлый цикл)',
    topHead: (n, week) => `Топ-${n} ${week}`,
    pointsChests: 'очки (сундуки)',
    you: 'Вы',
    progressHead: (name, n) => `${name} — последние ${n} ${pluralWord('ru-RU', n, RU_WEEKS)} (очки · место)`,
    goalWord: 'цель',
    notInClanYet: 'ещё не в клане',
    thisWeekSoFar: 'Эта неделя пока',
    eventsHead: 'События',
    liveNow: (name, left) => (left ? `Сейчас: ${name} — до конца ${left}` : `Сейчас: ${name}`),
    nextUp: (name, until) => `Далее: ${name} — через ${until}`,
    noEvents: 'Сейчас в календаре нет событий.',
    calendarDown: 'Календарь событий сейчас недоступен. Попробуйте позже.',
    units: { d: 'д', h: 'ч', m: 'мин', space: true },
    missingHead: (week, n, total) => `Отстают от темпа ${week}: ${n} из ${total}`,
    missingPace: (p, g) => `Темп к этому моменту: ${p} из ${g}`,
    nobodyBehind: (week) => `Никто не отстаёт от темпа ${week} ✓`,
    noGoal: 'У клана не задана недельная цель, поэтому отстающих нет.',
    andMore: (n) => `… и ещё ${n}`,
    leadersOnly: 'Команда «missing» только для руководства клана.',
    notOnBoard: 'Пока не нахожу вас в рейтинге клана. Попробуйте после следующего сканирования.',
    helpHead: 'TB Chest Counter (трекер клана от taulen). Напишите мне одно слово:',
    helpCode: 'code: ваш код для сайта',
    helpCodePrivate: 'code: ваш код для сайта, придёт в личные сообщения',
    helpLeaders: 'Руководство: missing',
  },
  de: {
    locale: 'de-DE',
    points: { one: 'Punkt', other: 'Punkte' },
    chests: { one: 'Truhe', other: 'Truhen' },
    thisWeek: (d, n) => `diese Woche (Tag ${d} von ${n})`,
    rankOf: (r, t) => `#${r} von ${t}`,
    today: (w) => `Heute: ${w}`,
    goalReached: (g) => `Wochenziel ${g}: erreicht ✓`,
    goalOnPace: (g, p) => `Wochenziel ${g}: im Plan ◐ (${p} bis jetzt)`,
    goalBehind: (g, p, r) => `Wochenziel ${g}: hinter dem Plan ↓ (${p} bis jetzt) · noch ${r}`,
    lastWeek: (w) => `Letzte Woche: ${w}`,
    might: 'Macht',
    guards: 'Gardisten',
    goldPass: 'Goldener Pass',
    goldPassPrevious: 'Goldener Pass (letzter Zyklus)',
    topHead: (n, week) => `Top ${n} ${week}`,
    pointsChests: 'Punkte (Truhen)',
    you: 'Du',
    progressHead: (name, n) => `${name} — letzte ${n} Wochen (Punkte · Platz)`,
    goalWord: 'Ziel',
    notInClanYet: 'noch nicht im Clan',
    thisWeekSoFar: 'Diese Woche bisher',
    eventsHead: 'Events',
    liveNow: (name, left) => (left ? `Jetzt: ${name} — endet in ${left}` : `Jetzt: ${name}`),
    nextUp: (name, until) => `Als Nächstes: ${name} — in ${until}`,
    noEvents: 'Gerade keine Events im Kalender.',
    calendarDown: 'Der Eventkalender ist gerade nicht lesbar. Versuch es später noch einmal.',
    units: { d: 'T', h: 'Std.', m: 'Min.', space: true },
    missingHead: (week, n, total) => `Hinter dem Plan ${week}: ${n} von ${total}`,
    missingPace: (p, g) => `Soll bis jetzt: ${p} von ${g}`,
    nobodyBehind: (week) => `Niemand ist ${week} hinter dem Plan ✓`,
    noGoal: 'Der Clan hat kein Wochenziel, also ist niemand hinten dran.',
    andMore: (n) => `… und ${n} weitere`,
    leadersOnly: 'Nur die Clanführung kann „missing“ benutzen.',
    notOnBoard: 'Ich finde dich noch nicht in der Clan-Rangliste. Versuch es nach dem nächsten Scan noch einmal.',
    helpHead: 'TB Chest Counter (der Clan-Tracker von taulen). Schreib mir ein Wort:',
    helpCode: 'code: dein Code für die Website',
    helpCodePrivate: 'code: dein Code für die Website, kommt privat',
    helpLeaders: 'Clanführung: missing',
  },
};

/** The plural form of `forms` for `n` in `locale`. */
export function pluralWord(locale: string, n: number, forms: Forms): string {
  const cat = new Intl.PluralRules(locale).select(n) as keyof Forms;
  return forms[cat] ?? forms.other;
}
