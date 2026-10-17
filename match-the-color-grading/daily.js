// Daily challenge: one puzzle per local calendar day, the same for everyone, read from
// dailies.json (made by tools/make-dailies.html). This browser keeps each day's progress and
// result, and from those the streak, in localStorage.

const STORE = 'matchthejpg.colorGrading.daily'; // localStorage key
const DAY_MS = 24 * 60 * 60 * 1000;
const SHARE_URL = 'https://matchthejpg.com/match-the-color-grading/'; // with https:// so chat apps make it a link

// Today's date in the player's own time zone as 'YYYY-MM-DD'; a new puzzle starts at local midnight.
export function todayKey(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
}

// Days since 1970 for a 'YYYY-MM-DD' date, so dates can be counted and stepped through.
export function dayIndex(key) {
  const [y, m, d] = key.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

function keyOf(index) {
  return new Date(index * DAY_MS).toISOString().slice(0, 10);
}

// { start: 'YYYY-MM-DD', puzzles: [{ photo, look }] }, or null when there is no puzzle file.
export async function loadDailies() {
  try {
    const response = await fetch(new URL('dailies.json', import.meta.url), { cache: 'no-cache' });
    return response.ok ? await response.json() : null;
  } catch (e) {
    return null;
  }
}

// The puzzle for a day with its number (#1 is the first day), or null outside the file's range.
export function puzzleFor(dailies, key) {
  if (!dailies) return null;
  const i = dayIndex(key) - dayIndex(dailies.start);
  if (i < 0 || i >= dailies.puzzles.length) return null;
  return { number: i + 1, ...dailies.puzzles[i] };
}

// Saved data, { days: { 'YYYY-MM-DD': { player, score, light, colour } }, best }. Storage can be
// blocked (private windows, strict settings); the daily then still plays, it just isn't kept.
function load() {
  try {
    const data = JSON.parse(localStorage.getItem(STORE));
    if (data && data.days) return data;
  } catch (e) {
    // fall through to an empty record
  }
  return { days: {}, best: 0 };
}

function store(data) {
  try {
    localStorage.setItem(STORE, JSON.stringify(data));
  } catch (e) {
    // not kept; see load()
  }
}

// One day's record: {} before it is started, { started } once the photo was shown, then the
// player's settings while editing, and score, light and colour once submitted.
export function getDay(key) {
  return load().days[key] || {};
}

export function saveDay(key, changes) {
  const data = load();
  data.days[key] = { ...data.days[key], ...changes };
  const current = streakFrom(data, key);
  if (current > data.best) data.best = current;
  store(data);
}

// Days in a row with a finished daily, ending today, or yesterday while today isn't done yet.
function streakFrom(data, key) {
  const done = (index) => data.days[keyOf(index)] && data.days[keyOf(index)].score !== undefined;
  let index = dayIndex(key);
  if (!done(index)) index -= 1;
  let count = 0;
  while (done(index)) {
    count += 1;
    index -= 1;
  }
  return count;
}

export function streak(key) {
  const data = load();
  return { current: streakFrom(data, key), best: data.best || 0 };
}

// The streak line, or nothing while there is no streak.
export function streakText(key) {
  const { current, best } = streak(key);
  if (!current) return '';
  const days = current === 1 ? '1-day streak' : current + '-day streak';
  return '🔥 ' + days + (best > current ? ' · best ' + best : '');
}

// Time left until the next puzzle, as 'h:mm:ss'.
export function untilNext(now = new Date()) {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const s = Math.max(0, Math.floor((midnight - now) / 1000));
  const pad = (n) => String(n).padStart(2, '0');
  return Math.floor(s / 3600) + ':' + pad(Math.floor((s % 3600) / 60)) + ':' + pad(s % 60);
}

// What players share: a line that fits how well they did, their score, and a dare to try it,
// so a low score is as worth sharing as a high one. Highest score band first.
const SHARE_LINES = [
  [90, "Nailed today's color grade 🎯", 'Beat that!'],
  [75, "Pretty close on today's color grade 🎨", 'Can you do better?'],
  [50, "Today's color grade was tricky 😅", "Bet you can't beat it."],
  [0, "Today's color grade got me 😵", 'Your turn.'],
];

export function shareText(score) {
  const [, headline, dare] = SHARE_LINES.find(([min]) => score >= min);
  return headline + '\nMy result: ' + score + '%\n' + dare + ' ' + SHARE_URL;
}
