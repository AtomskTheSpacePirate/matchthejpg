import { createRenderer } from './renderer.js';
import { loadPhotos, shuffle, makeRound } from './rounds.js';
import { createScorer } from './score.js';
import { buildSliders } from './ui.js';
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

// A game is 5 rounds that get harder: how many sliders and wheels each edit uses.
const DIFFICULTY = [
  { sliders: 2, wheels: 1 },
  { sliders: 3, wheels: 1 },
  { sliders: 3, wheels: 2 },
  { sliders: 4, wheels: 2 },
  { sliders: 4, wheels: 3 },
];
const ROUNDS = DIFFICULTY.length;
const MAX_UNEDITED_SCORE = 45; // an edit must be strong enough that doing nothing scores at most this
const MAX_EDIT_TRIES = 20;

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

// The player edits the unedited photo directly, so the controls are the shader settings.
const sliders = buildSliders(document.getElementById('sliders'), SLIDERS, (player) => {
  if (round) renderer.setParams(player);
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

// Size the canvases to the stage. On the result screen two photos share it, side by
// side or stacked, whichever shows them larger.
function fit() {
  const box = stage.getBoundingClientRect();
  if (!box.width || !box.height) return;
  let size = fitBox(box.width, box.height);
  let column = false;
  if (app.dataset.phase === 'result') {
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
  phaseLabel.textContent = PHASE_LABELS[name];
  fit();
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

async function newGame() {
  if (!pool) {
    try {
      pool = await loadPhotos();
    } catch (e) {
      phaseLabel.textContent = 'Could not load photos';
      return;
    }
  }
  photos = shuffle(pool).slice(0, ROUNDS);
  roundNo = 0;
  results = [];
  startRound();
}

// A random edit for the scorer's current photo that is clearly visible: one where submitting
// the unedited photo would score at most MAX_UNEDITED_SCORE. Sliders can cancel each other out,
// so edits are rolled again; after MAX_EDIT_TRIES the most visible one is used.
function makeVisibleRound(level) {
  let best = null;
  let bestScore = Infinity;
  for (let i = 0; i < MAX_EDIT_TRIES; i++) {
    const next = makeRound(level.sliders, level.wheels);
    const unedited = scorer.breakdown(next.look, ZERO).score;
    if (unedited <= MAX_UNEDITED_SCORE) return next;
    if (unedited < bestScore) {
      best = next;
      bestScore = unedited;
    }
  }
  return best;
}

// Show the edited photo for a few seconds, then hand over the unedited one.
async function startRound() {
  const img = await loadImage(photos[roundNo]);
  if (roundNo + 1 < ROUNDS) new Image().src = photos[roundNo + 1]; // warm the cache

  image = img;
  aspect = img.naturalWidth / img.naturalHeight;
  view.classList.add('is-hidden');
  for (const target of [renderer, original, scorer]) target.setImage(img);
  round = makeVisibleRound(DIFFICULTY[roundNo]);
  renderer.setParams(round.look);
  original.setParams(round.look);
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
  showParts([['Light', light], ['Colour', colour]]);
  showHints(scorer.explain(round.look, player));
  fillReveal(round.look, player);
  nextButton.textContent = results.length < ROUNDS ? 'Next round' : 'See results';
  paintDots();
  setPhase('result');
  countUp(scoreEl, score);
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
  if (results.length < ROUNDS) {
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
  verdictEl.textContent = VERDICTS.find(([min]) => average >= min)[1];

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
document.getElementById('reset').addEventListener('click', () => sliders.set(ZERO));
document.getElementById('submit').addEventListener('click', submit);
nextButton.addEventListener('click', next);
revealButton.addEventListener('click', toggleReveal);

enableButtonWave();
new ResizeObserver(fit).observe(stage);
setPhase('ready');
