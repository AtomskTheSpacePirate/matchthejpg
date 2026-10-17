import { createRenderer } from './renderer.js';
import { loadPhotos, shuffle, makeVisibleRound, photoUrl } from './rounds.js';
import { createScorer } from './score.js';
import { buildSliders } from './ui.js';
import {
  todayKey, loadDailies, puzzleFor, getDay, saveDay, streakText, untilNext, shareText,
} from './daily.js';
import { enableButtonWave } from '../js/buttons.js';

const SLIDERS = [
  { key: 'brightness', label: 'Brightness', group: 'Light', min: -100, max: 100 },
  { key: 'contrast', label: 'Contrast', group: 'Light', min: -100, max: 100 },
  { key: 'highlights', label: 'Highlights', group: 'Light', min: -100, max: 100 },
  { key: 'midtones', label: 'Midtones', group: 'Light', min: -100, max: 100 },
  { key: 'shadows', label: 'Shadows', group: 'Light', min: -100, max: 100 },
  { key: 'saturation', label: 'Saturation', group: 'Color', min: -100, max: 100 },
  { type: 'wheel', key: 'tintS', label: 'Shadows', group: 'Color' },
  { type: 'wheel', key: 'tintM', label: 'Midtones', group: 'Color' },
  { type: 'wheel', key: 'tintH', label: 'Highlights', group: 'Color' },
];

// The unedited photo, and where every control starts.
const ZERO = {
  brightness: 0, contrast: 0, highlights: 0, midtones: 0, shadows: 0, saturation: 0,
  tintSx: 0, tintSy: 0, tintMx: 0, tintMy: 0, tintHx: 0, tintHy: 0,
};

// A free-play game is 5 rounds that get harder: how many sliders and wheels each edit uses.
// The daily challenge is a single round with a ready-made edit from dailies.json.
const DIFFICULTY = [
  { sliders: 2, wheels: 1 },
  { sliders: 3, wheels: 1 },
  { sliders: 3, wheels: 2 },
  { sliders: 4, wheels: 2 },
  { sliders: 4, wheels: 3 },
];
const ROUNDS = DIFFICULTY.length;
// Practice is endless, one hard edit after another, with the edit shown beside the player's.
const PRACTICE_LEVEL = DIFFICULTY[DIFFICULTY.length - 1];

// Final verdict by average match, highest first.
const VERDICTS = [
  [90, 'Pixel perfect'],
  [75, 'Sharp eye'],
  [60, 'Solid grade'],
  [45, 'Getting there'],
  [30, 'Off the mark'],
  [0, 'Colorblind'],
];

const MEMORISE_SECONDS = 5; // matches the ring's drain animation in style.css
const SWAP_MS = 260; // matches the #view transition in style.css
const FRAME_GAP = 16; // matches .frames gap in style.css
const CAPTION = 28; // matches .frame figcaption height in style.css
const THUMB_HEIGHT = 52; // final results thumbnails, in CSS pixels
const PHASE_LABELS = {
  ready: '', memorise: 'Memorise', edit: 'Recreate it', result: 'Result', final: 'Results',
};

const app = document.querySelector('.app');
const stage = document.querySelector('.stage');
const frames = document.querySelector('.frames');
const view = document.getElementById('view');
const originalView = document.getElementById('original');
const phaseLabel = document.getElementById('phase');
const countEl = document.getElementById('count');
const scoreEl = document.getElementById('score');
const nextButton = document.getElementById('next');
const partsEl = document.getElementById('parts');
const hintsEl = document.getElementById('hints');
const revealButton = document.getElementById('reveal');
const revealTable = document.getElementById('reveal-table');
const finalScoreEl = document.getElementById('final-score');
const verdictEl = document.getElementById('verdict');
const recapEl = document.getElementById('recap');
const dots = Array.from(document.querySelectorAll('.progress .dot'));
const dailyButton = document.getElementById('daily');
const streakEl = document.getElementById('streak');
const readyCountdownEl = document.getElementById('ready-countdown');
const dailyExtra = document.getElementById('daily-extra');
const dailyTitleEl = document.getElementById('daily-title');
const resultStreakEl = document.getElementById('result-streak');
const shareButton = document.getElementById('share');
const resultCountdownEl = document.getElementById('result-countdown');

const renderer = createRenderer(view);
const original = createRenderer(originalView);
const scorer = createScorer();
const thumbCanvas = document.createElement('canvas');
let thumbRenderer = null; // created on the first results screen

let pool = null; // every available photo, loaded on the first game
let photos = []; // this game's photos, one per round
let roundNo = 0;
let results = []; // { img, look, player, score } per finished round
let aspect = 1.5;
let round = null;
let image = null;
let mode = 'free'; // 'free', 'daily' or 'practice'
let practiceQueue = []; // practice photos still to come, reshuffled when used up
let dailies = null; // the puzzle file, once loaded
let dayKey = todayKey(); // the day whose puzzle is offered
let puzzle = null; // that day's { number, photo, look }, or null when there is none

// The player edits the unedited photo directly, so the controls are the shader settings. While
// editing the daily they are also saved, so a reload continues the edit instead of restarting it.
const sliders = buildSliders(document.getElementById('sliders'), SLIDERS, (player) => {
  if (round) renderer.setParams(player);
  if (mode === 'daily' && app.dataset.phase === 'edit') saveDay(dayKey, { player });
});

// Largest size with the photo's shape that fits in the given box.
function fitBox(maxWidth, maxHeight) {
  let width = maxWidth;
  let height = width / aspect;
  if (height > maxHeight) {
    height = maxHeight;
    width = height * aspect;
  }
  return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
}

// Size the canvases to the stage. On the result screen, and while editing in practice, two
// photos share it, side by side or stacked, whichever shows them larger.
function fit() {
  const box = stage.getBoundingClientRect();
  if (!box.width || !box.height) return;
  let size = fitBox(box.width, box.height);
  let column = false;
  if (app.dataset.phase === 'result' || (mode === 'practice' && app.dataset.phase === 'edit')) {
    const side = fitBox((box.width - FRAME_GAP) / 2, box.height - CAPTION);
    const stacked = fitBox(box.width, (box.height - FRAME_GAP) / 2 - CAPTION);
    column = stacked.width > side.width;
    size = column ? stacked : side;
  }
  frames.classList.toggle('is-column', column);
  for (const [canvas, target] of [[view, renderer], [originalView, original]]) {
    canvas.style.width = size.width + 'px';
    canvas.style.height = size.height + 'px';
    target.resize(size.width, size.height);
  }
}

function setPhase(name) {
  app.dataset.phase = name;
  const label = { daily: "Today's challenge", practice: 'Practice' }[mode];
  phaseLabel.textContent = label && name !== 'ready' ? label : PHASE_LABELS[name];
  fit();
}

function verdictFor(score) {
  return VERDICTS.find(([min]) => score >= min)[1];
}

function loadImage(src) {
  const img = new Image();
  img.src = src;
  return img.decode().then(() => img);
}

function pop(el) {
  el.animate(
    [{ transform: 'scale(1.3)', opacity: 0.3 }, { transform: 'scale(1)', opacity: 1 }],
    { duration: 350, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
}

// Red at 0, yellow at an average 60 and still yellow at 85, green only above that.
function scoreColor(value) {
  let hue;
  if (value <= 60) hue = 4 + value * (46 / 60);
  else if (value <= 85) hue = 50 + (value - 60) * (20 / 25);
  else hue = 70 + (value - 85) * (65 / 15);
  return 'hsl(' + Math.round(hue) + ', 80%, 58%)';
}

// Counts a score up from 0 in `el`, shifting its colour as it goes. The colour is set on
// the parent so the number and its % sign match.
function countUp(el, to) {
  const duration = 900;
  const began = performance.now();
  const block = el.parentElement;
  function step(now) {
    const t = Math.min(1, (now - began) / duration);
    const value = to * (1 - Math.pow(1 - t, 3));
    el.textContent = Math.round(value);
    block.style.color = scoreColor(value);
    if (t < 1) requestAnimationFrame(step);
  }
  el.textContent = 0;
  block.style.color = scoreColor(0);
  requestAnimationFrame(step);
}

// Progress dots: finished rounds take their score's colour, the current one is outlined.
function paintDots() {
  dots.forEach((dot, i) => {
    const done = i < results.length;
    dot.classList.toggle('is-done', done);
    dot.classList.toggle('is-current', i === roundNo && !done);
    dot.style.background = done ? scoreColor(results[i].score) : '';
  });
}

function setMode(name) {
  mode = name;
  app.dataset.mode = name;
  roundNo = 0;
  results = [];
}

// Loads the photo list the first time it is needed. False if it can't be loaded.
async function ensurePool() {
  if (pool) return true;
  try {
    pool = await loadPhotos();
    return true;
  } catch (e) {
    phaseLabel.textContent = 'Could not load photos';
    return false;
  }
}

async function newGame() {
  if (!(await ensurePool())) return;
  setMode('free');
  photos = shuffle(pool).slice(0, ROUNDS);
  startRound();
}

async function startPractice() {
  if (!(await ensurePool())) return;
  setMode('practice');
  startRound();
}

// The next practice photo: every photo once in random order, then a new order.
function nextPracticePhoto() {
  if (!practiceQueue.length) practiceQueue = shuffle(pool);
  return practiceQueue.pop();
}

// Today's daily: its result if already played, otherwise the round (continued if started).
function playDaily() {
  if (!puzzle) return;
  setMode('daily');
  if (getDay(dayKey).score !== undefined) showTodaysResult();
  else startRound();
}

// Loads a photo into the view, the original and the scorer. False if it can't be loaded.
async function usePhoto(src) {
  try {
    image = await loadImage(src);
  } catch (e) {
    phaseLabel.textContent = 'Could not load the photo';
    return false;
  }
  aspect = image.naturalWidth / image.naturalHeight;
  for (const target of [renderer, original, scorer]) target.setImage(image);
  return true;
}

// Show the edited photo for a few seconds, then hand over the unedited one. The daily uses its
// ready-made edit, and a daily already started (the page was reloaded) goes straight back to
// editing with the saved settings, without showing the edit again. Practice skips memorising:
// the edit stays on screen beside the player's photo.
async function startRound() {
  const daily = mode === 'daily';
  const practice = mode === 'practice';
  view.classList.add('is-hidden');
  const src = daily ? photoUrl(puzzle.photo) : practice ? nextPracticePhoto() : photos[roundNo];
  if (!(await usePhoto(src))) return;
  if (mode === 'free' && roundNo + 1 < ROUNDS) new Image().src = photos[roundNo + 1]; // warm the cache

  const level = practice ? PRACTICE_LEVEL : DIFFICULTY[roundNo];
  round = daily ? { look: puzzle.look } : makeVisibleRound(scorer, level.sliders, level.wheels);
  original.setParams(round.look);
  if (practice) {
    sliders.set(ZERO);
    setPhase('edit');
    view.classList.remove('is-hidden');
    return;
  }
  if (daily) {
    const day = getDay(dayKey);
    if (day.started) {
      sliders.set(day.player || ZERO);
      setPhase('edit');
      view.classList.remove('is-hidden');
      return;
    }
    saveDay(dayKey, { started: true });
  }
  renderer.setParams(round.look);
  paintDots();
  setPhase('memorise');
  requestAnimationFrame(() => view.classList.remove('is-hidden'));

  let left = MEMORISE_SECONDS;
  countEl.textContent = left;
  const timer = setInterval(() => {
    left -= 1;
    if (left > 0) {
      countEl.textContent = left;
      pop(countEl);
    } else {
      clearInterval(timer);
      beginEdit();
    }
  }, 1000);
}

function beginEdit() {
  view.classList.add('is-swapping');
  setTimeout(() => {
    sliders.set(ZERO);
    setPhase('edit');
    view.classList.remove('is-swapping');
  }, SWAP_MS);
}

function submit() {
  const player = sliders.values();
  const { score, light, colour, costs } = scorer.breakdown(round.look, player);
  console.log('[score]', { score, light, colour, ...costs }); // temporary, while tuning the scoring
  results.push({ img: image, look: round.look, player, score });
  if (mode === 'daily') saveDay(dayKey, { player, score, light, colour });
  showResult(round.look, player, { score, light, colour });
}

// The result card for one round. In the daily it ends with the streak, Share and the countdown
// instead of a next round.
function showResult(look, player, { score, light, colour }) {
  showParts([['Light', light], ['Colour', colour]]);
  showHints(scorer.explain(look, player));
  fillReveal(look, player);
  const daily = mode === 'daily';
  nextButton.hidden = daily;
  dailyExtra.hidden = !daily;
  if (daily) {
    dailyTitleEl.textContent = "Today's challenge · " + verdictFor(score);
    resultStreakEl.textContent = streakText(dayKey);
    shareButton.textContent = 'Share';
  } else if (mode === 'practice') {
    nextButton.textContent = 'Next photo';
  } else {
    nextButton.textContent = results.length < ROUNDS ? 'Next round' : 'See results';
  }
  paintDots();
  setPhase('result');
  countUp(scoreEl, score);
}

// Coming back to a daily already played: its result card again, with both photos.
async function showTodaysResult() {
  const day = getDay(dayKey);
  if (!(await usePhoto(photoUrl(puzzle.photo)))) return;
  round = { look: puzzle.look };
  original.setParams(puzzle.look);
  renderer.setParams(day.player);
  view.classList.remove('is-hidden');
  showResult(puzzle.look, day.player, day);
}

// Shares the daily result: the share menu on phones, the clipboard elsewhere.
async function shareDaily() {
  const text = shareText(getDay(dayKey).score);
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try {
      await navigator.share({ text });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return; // the player closed the share menu
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    shareButton.textContent = 'Copied!';
  } catch (e) {
    shareButton.textContent = 'Could not copy';
  }
  setTimeout(() => { shareButton.textContent = 'Share'; }, 2000);
}

// The start card's daily button and streak, for the current day.
function renderReady() {
  dayKey = todayKey();
  puzzle = puzzleFor(dailies, dayKey);
  const day = getDay(dayKey);
  dailyButton.disabled = !puzzle;
  if (!puzzle) dailyButton.textContent = 'New dailies coming soon';
  else if (day.score !== undefined) dailyButton.textContent = 'Today: ' + day.score + '% · See result';
  else if (day.started) dailyButton.textContent = "Continue today's challenge";
  else dailyButton.textContent = "Today's challenge";
  streakEl.textContent = puzzle ? streakText(dayKey) : '';
}

// Every second: the countdowns to the next puzzle, and a fresh start card when a new day begins
// while the page is open (not in the middle of a daily, which stays on its own day).
function tickDaily() {
  const text = 'Next puzzle in ' + untilNext();
  readyCountdownEl.textContent = puzzle && getDay(dayKey).score !== undefined ? text : '';
  resultCountdownEl.textContent = text;
  if (todayKey() !== dayKey && (mode !== 'daily' || app.dataset.phase === 'ready')) renderReady();
}

// A bar per part of the score, coloured like the score itself.
function showParts(parts) {
  partsEl.replaceChildren(...parts.flatMap(([name, value]) => {
    const label = document.createElement('span');
    label.className = 'part-name';
    label.textContent = name;
    const bar = document.createElement('span');
    bar.className = 'part-bar';
    const fill = document.createElement('span');
    fill.style.width = value + '%';
    fill.style.background = scoreColor(value);
    bar.append(fill);
    const number = document.createElement('span');
    number.className = 'part-value';
    number.textContent = value;
    number.style.color = scoreColor(value);
    return [label, bar, number];
  }));
}

function showHints(hints) {
  const items = hints.length ? hints : ['Very close, nothing stands out'];
  hintsEl.replaceChildren(...items.map((text, i) => {
    const li = document.createElement('li');
    li.style.setProperty('--i', i);
    li.textContent = text;
    li.classList.toggle('is-close', !hints.length);
    return li;
  }));
}

// Colour wheel names by hsl() hue, which is also the wheel's angle (red to the right, up is 90).
const WHEEL_HUES = [
  [0, 'red'], [30, 'orange'], [60, 'yellow'], [120, 'green'],
  [180, 'cyan'], [240, 'blue'], [280, 'purple'], [320, 'pink'], [360, 'red'],
];

// One table cell showing a slider value (+41) or a wheel position (a dot of its colour, its
// name and strength); a dash when the control is untouched.
function valueCell(def, values) {
  const cell = document.createElement('span');
  if (def.type !== 'wheel') {
    const v = Math.round((values[def.key] || 0) * 100);
    cell.textContent = v > 0 ? '+' + v : v ? String(v) : '–';
    return cell;
  }
  const x = values[def.key + 'x'] || 0;
  const y = values[def.key + 'y'] || 0;
  const strength = Math.round(Math.hypot(x, y) * 100);
  if (!strength) {
    cell.textContent = '–';
    return cell;
  }
  const hue = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  const name = WHEEL_HUES.reduce((best, h) => (Math.abs(h[0] - hue) < Math.abs(best[0] - hue) ? h : best))[1];
  const swatch = document.createElement('span');
  swatch.className = 'swatch';
  swatch.style.background = 'hsl(' + Math.round(hue) + ' 85% 55%)';
  cell.append(swatch, name + ' ' + strength);
  return cell;
}

// The edit's actual settings next to the player's, for every control either of them moved.
function fillReveal(look, player) {
  const cells = [];
  for (const text of ['', 'Edit', 'You']) {
    const head = document.createElement('span');
    head.className = 'reveal-head';
    head.textContent = text;
    cells.push(head);
  }
  for (const def of SLIDERS) {
    const used = (values) => (def.type === 'wheel'
      ? values[def.key + 'x'] || values[def.key + 'y']
      : values[def.key]);
    if (!used(look) && !used(player)) continue;
    const name = document.createElement('span');
    name.textContent = def.type === 'wheel' ? def.label + ' tint' : def.label;
    cells.push(name, valueCell(def, look), valueCell(def, player));
  }
  revealTable.replaceChildren(...cells);
  revealTable.hidden = true;
  revealButton.textContent = 'Show the edit';
  revealButton.setAttribute('aria-expanded', 'false');
}

function toggleReveal() {
  revealTable.hidden = !revealTable.hidden;
  revealButton.textContent = revealTable.hidden ? 'Show the edit' : 'Hide the edit';
  revealButton.setAttribute('aria-expanded', String(!revealTable.hidden));
}

function next() {
  if (mode === 'practice') {
    startRound();
  } else if (results.length < ROUNDS) {
    roundNo += 1;
    startRound();
  } else {
    showFinal();
  }
}

// A small still of the photo with the given settings, drawn by one shared renderer. It is
// rendered 4x larger, then scaled down smoothly, so detail doesn't turn into speckle.
function thumbnail(img, params) {
  if (!thumbRenderer) thumbRenderer = createRenderer(thumbCanvas);
  const width = Math.round((THUMB_HEIGHT * img.naturalWidth) / img.naturalHeight);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  thumbRenderer.setImage(img);
  thumbRenderer.resize(width * 4, THUMB_HEIGHT * 4);
  thumbRenderer.read(params); // draws now, so the canvas can be copied straight away
  const out = document.createElement('canvas');
  out.width = Math.round(width * dpr);
  out.height = Math.round(THUMB_HEIGHT * dpr);
  out.style.width = width + 'px';
  out.style.height = THUMB_HEIGHT + 'px';
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(thumbCanvas, 0, 0, out.width, out.height);
  return out;
}

function showFinal() {
  const average = Math.round(results.reduce((sum, r) => sum + r.score, 0) / results.length);
  verdictEl.textContent = verdictFor(average);

  recapEl.replaceChildren(...results.map((r, i) => {
    const row = document.createElement('li');
    row.style.setProperty('--i', i);
    const no = document.createElement('span');
    no.className = 'recap-no';
    no.textContent = i + 1;
    const score = document.createElement('span');
    score.className = 'recap-score';
    score.textContent = r.score + '%';
    score.style.color = scoreColor(r.score);
    row.append(no, thumbnail(r.img, r.look), thumbnail(r.img, r.player), score);
    return row;
  }));

  round = null;
  setPhase('final');
  countUp(finalScoreEl, average);
}

document.getElementById('start').addEventListener('click', newGame);
document.getElementById('again').addEventListener('click', newGame);
document.getElementById('free').addEventListener('click', newGame);
dailyButton.addEventListener('click', playDaily);
document.getElementById('practice').addEventListener('click', startPractice);
shareButton.addEventListener('click', shareDaily);
document.getElementById('reset').addEventListener('click', () => sliders.set(ZERO));
document.getElementById('submit').addEventListener('click', submit);
nextButton.addEventListener('click', next);
revealButton.addEventListener('click', toggleReveal);

enableButtonWave();
new ResizeObserver(fit).observe(stage);
setPhase('ready');
loadDailies().then((file) => {
  dailies = file;
  renderReady();
});
setInterval(tickDaily, 1000);
