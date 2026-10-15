// Match Pixel Colors: a few real pixels from one photo, three photos with similar colours, pick the source.
// Each photo's main colours come from palettes.json (made by tools/build-palettes.ps1).

import { enableButtonWave } from '../js/buttons.js';

// Pixels shown in each round, first to last; the game has one round per entry.
const PIXELS_PER_ROUND = [6, 6, 6, 5, 5, 5, 4, 4, 4, 3, 3, 3];
const ROUNDS = PIXELS_PER_ROUND.length;
const OPTIONS = 3;
const ROUND_SECONDS = 10; // time to answer; running out counts as wrong
const LOW_SECONDS = 3; // the timer turns red from here
// How much each new pixel is rewarded for differing from those already picked, so the band
// stays varied (higher drowns out the difficulty, lower makes the pixels look alike); and a
// little randomness so the same photo gives different bands.
const SPREAD = 0.15;
const JITTER = 0.01;
// Wrong options come from the photos whose colours are closest to the answer's, drawn from a
// window of ranks (0 is the most similar photo) that slides from EASIEST in the first round to
// HARDEST in the last, so the game gets harder as it goes.
const EASIEST = [12, 20];
const HARDEST = [0, 4];
const MIN_SHARE = 0.03; // a colour must cover at least 3% of the photo to be shown
const NEAR_DUPLICATE = 0.01; // photos closer than this count as the same shot and never share a round
const VERDICTS = ['Try again', 'Tricky, right?', 'Sharp eye', 'Perfect eye']; // by number correct
const PHASE_LABELS = { ready: '', final: 'Results' };

// This game's own photos, separate from Match the Color Grading's photos-web/.
const PHOTOS = new URL('../pixel-photos-web/', import.meta.url);
const photoUrl = (name) => new URL(name, PHOTOS).href;

const app = document.querySelector('.app');
const phaseLabel = document.getElementById('phase');
const roundEl = document.getElementById('round');
const promptEl = document.getElementById('prompt');
const bandEl = document.getElementById('band');
const optionsEl = document.getElementById('options');
const timerEl = document.getElementById('timer');
const timerBar = document.getElementById('timer-bar');
const timerSecs = document.getElementById('timer-secs');
const roundVerdictEl = document.getElementById('round-verdict');
const nextButton = document.getElementById('next');
const finalScoreEl = document.getElementById('final-score');
const finalTotalEl = document.getElementById('final-total');
const verdictEl = document.getElementById('verdict');
const recapEl = document.getElementById('recap');
const dots = Array.from({ length: ROUNDS }, () => {
  const dot = document.createElement('span');
  dot.className = 'dot';
  return dot;
});
document.querySelector('.progress').replaceChildren(...dots);

let palettes = null; // photo name -> its colours, biggest first
let names = [];
let rounds = []; // { target, options, pixels } per round, planned when a game starts
let results = []; // { picked, right } per answered round; picked is null when time ran out
let roundNo = 0;
let timerFrame = 0; // the timer's animation frame while a round's clock runs

function shuffle(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const labGap = (x, y) => Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);

// How different two photos' colours are: for each colour of one, the gap to the nearest colour
// of the other, weighted by how much of the photo it covers; averaged both ways. 0 is identical.
const profileGaps = new Map();
function profileGap(a, b) {
  const key = a < b ? a + '|' + b : b + '|' + a;
  if (!profileGaps.has(key)) {
    const oneWay = (from, to) => from.reduce((sum, c) =>
      sum + c.share * Math.min(...to.map((d) => labGap(c.lab, d.lab))), 0);
    profileGaps.set(key, (oneWay(palettes[a], palettes[b]) + oneWay(palettes[b], palettes[a])) / 2);
  }
  return profileGaps.get(key);
}

// How much a colour stands out from the wrong options: the gap to the nearest colour in each of
// them, averaged. Small means the wrong options have it too, so it gives little away.
function standOut(colour, wrong) {
  const gaps = wrong.map((n) => Math.min(...palettes[n].map((d) => labGap(colour.lab, d.lab))));
  return gaps.reduce((sum, g) => sum + g, 0) / gaps.length;
}

// `count` real pixels of a photo, one per main colour. Early in the game (t near 0) they favour
// the colours that stand out from the wrong options; late (t near 1), the colours the wrong
// options share, so only the exact shades tell them apart. Every pick is also rewarded for
// differing from the colours already chosen, so the band stays varied.
function pickPixels(name, wrong, t, count) {
  let candidates = palettes[name].filter((c) => c.share >= MIN_SHARE);
  if (candidates.length < count) candidates = palettes[name];
  const value = new Map(candidates.map((c) =>
    [c, (1 - 2 * t) * standOut(c, wrong) + Math.random() * JITTER]));
  const chosen = [];
  while (chosen.length < Math.min(count, candidates.length)) {
    let best = null;
    let bestScore = -Infinity;
    for (const c of candidates) {
      if (chosen.includes(c)) continue;
      const spread = chosen.length ? Math.min(...chosen.map((d) => labGap(c.lab, d.lab))) : 0;
      const score = value.get(c) + SPREAD * spread;
      if (score > bestScore) {
        best = c;
        bestScore = score;
      }
    }
    chosen.push(best);
  }
  return shuffle(chosen.map((c) => pick(c.samples)));
}

// The answer plus OPTIONS - 1 photos with similar colours, from this round's difficulty ranks,
// never two that are the same shot.
function pickOptions(target, t) {
  const ranked = names
    .filter((n) => n !== target && profileGap(target, n) >= NEAR_DUPLICATE)
    .sort((x, y) => profileGap(target, x) - profileGap(target, y));
  const [from, to] = EASIEST.map((easy, i) => Math.round(easy + (HARDEST[i] - easy) * t));
  const wrong = [];
  for (const pool of [shuffle(ranked.slice(from, to + 1)), ranked]) {
    for (const n of pool) {
      if (wrong.length === OPTIONS - 1) break;
      if (!wrong.includes(n) && wrong.every((w) => profileGap(w, n) >= NEAR_DUPLICATE)) wrong.push(n);
    }
  }
  return shuffle([target, ...wrong]);
}

// The phase label; during a round "Round 3 / 10", shortened to "3 / 10" on phones by style.css.
function setPhase(name) {
  app.dataset.phase = name;
  if (name !== 'round') {
    phaseLabel.textContent = PHASE_LABELS[name];
    return;
  }
  const word = document.createElement('span');
  word.className = 'tag-word';
  word.textContent = 'Round ';
  phaseLabel.replaceChildren(word, roundNo + 1 + ' / ' + ROUNDS);
}

function paintDots() {
  dots.forEach((dot, i) => {
    const done = i < results.length;
    dot.classList.toggle('is-current', i === roundNo && !done);
    dot.classList.toggle('is-right', done && results[i].right);
    dot.classList.toggle('is-wrong', done && !results[i].right);
  });
}

function swatch(className, hex, i) {
  const el = document.createElement('span');
  el.className = className;
  el.style.setProperty('--c', hex);
  if (i !== undefined) el.style.setProperty('--i', i);
  return el;
}

async function newGame() {
  if (!palettes) {
    try {
      const response = await fetch(new URL('palettes.json', import.meta.url), { cache: 'no-cache' });
      palettes = await response.json();
      names = Object.keys(palettes);
    } catch (e) {
      phaseLabel.textContent = 'Could not load photos';
      return;
    }
  }
  // Each round's place in the game, 0 for the first and 1 for the last, sets how hard it is.
  rounds = shuffle(names).slice(0, ROUNDS).map((target, i) => {
    const t = ROUNDS > 1 ? i / (ROUNDS - 1) : 1;
    const options = pickOptions(target, t);
    const wrong = options.filter((n) => n !== target);
    return { target, options, pixels: pickPixels(target, wrong, t, PIXELS_PER_ROUND[i]) };
  });
  for (const round of rounds) for (const n of round.options) new Image().src = photoUrl(n); // preload
  results = [];
  roundNo = 0;
  startRound();
}

function startRound() {
  const round = rounds[roundNo];
  roundEl.classList.remove('is-answered');
  promptEl.textContent = 'Which photo are these ' + round.pixels.length + ' pixels from?';
  bandEl.style.setProperty('--n', round.pixels.length);
  bandEl.replaceChildren(...round.pixels.map((p, i) => swatch('pixel', p.hex, i)));
  optionsEl.replaceChildren(...round.options.map((name, i) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'option';
    button.style.setProperty('--i', i);
    button.setAttribute('aria-label', 'Photo ' + (i + 1));
    const img = document.createElement('img');
    img.src = photoUrl(name);
    img.alt = '';
    button.append(img);
    button.addEventListener('click', () => answer(name));
    return button;
  }));
  paintDots();
  setPhase('round');
  startTimer();
}

// Counts the round down from ROUND_SECONDS: the bar drains and the seconds tick, red for the last
// LOW_SECONDS. At zero the round is answered with no pick. Measured against a fixed end time, so
// a tab left in the background still runs out on time.
function startTimer() {
  stopTimer();
  const end = performance.now() + ROUND_SECONDS * 1000;
  const tick = () => {
    const left = Math.max(0, end - performance.now());
    timerBar.style.transform = 'scaleX(' + left / (ROUND_SECONDS * 1000) + ')';
    timerSecs.textContent = Math.ceil(left / 1000);
    timerEl.classList.toggle('is-low', left <= LOW_SECONDS * 1000);
    if (left > 0) timerFrame = requestAnimationFrame(tick);
    else answer(null);
  };
  tick();
}

function stopTimer() {
  cancelAnimationFrame(timerFrame);
  timerFrame = 0;
}

// Places a marker on the source photo where each pixel came from. The photo is cropped to fill
// its frame (object-fit: cover), so positions are mapped through the same crop.
async function placeMarkers(button, pixels) {
  const img = button.querySelector('img');
  await img.decode().catch(() => {});
  const w = button.clientWidth;
  const h = button.clientHeight;
  const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  const dw = img.naturalWidth * scale;
  const dh = img.naturalHeight * scale;
  const clamp = (v) => Math.min(96, Math.max(4, v));
  button.append(...pixels.map((p, i) => {
    const marker = swatch('marker', p.hex, i);
    marker.style.left = clamp((((w - dw) / 2 + p.x * dw) / w) * 100) + '%';
    marker.style.top = clamp((((h - dh) / 2 + p.y * dh) / h) * 100) + '%';
    return marker;
  }));
}

function badge(text) {
  const el = document.createElement('span');
  el.className = 'badge';
  el.textContent = text;
  return el;
}

// The player's pick, or null when time ran out.
function answer(picked) {
  if (roundEl.classList.contains('is-answered')) return;
  stopTimer();
  const round = rounds[roundNo];
  const right = picked === round.target;
  results.push({ picked, right });
  const buttons = Array.from(optionsEl.children);
  buttons.forEach((button, i) => {
    button.disabled = true;
    const name = round.options[i];
    if (name === round.target) {
      button.classList.add('is-right');
      button.append(badge('✓ Source'));
      placeMarkers(button, round.pixels);
    } else if (name === picked) {
      button.classList.add('is-wrong');
      button.append(badge('✗ Your pick'));
    }
  });
  roundVerdictEl.textContent = right ? 'Correct!' : picked === null ? "Time's up" : 'Not this one';
  roundVerdictEl.style.color = right ? 'var(--right)' : 'var(--wrong)';
  nextButton.textContent = results.length < ROUNDS ? 'Next round' : 'See results';
  roundEl.classList.add('is-answered');
  paintDots();
  nextButton.focus({ preventScroll: true });
}

function next() {
  if (results.length < ROUNDS) {
    roundNo += 1;
    startRound();
  } else {
    showFinal();
  }
}

function thumb(name, wrong) {
  const img = document.createElement('img');
  img.src = photoUrl(name);
  img.alt = '';
  if (wrong) img.className = 'is-wrong';
  return img;
}

function showFinal() {
  const correct = results.filter((r) => r.right).length;
  finalScoreEl.textContent = correct;
  finalTotalEl.textContent = '/ ' + ROUNDS;
  verdictEl.textContent = VERDICTS[Math.round((correct / ROUNDS) * (VERDICTS.length - 1))];
  recapEl.replaceChildren(...rounds.map((round, i) => {
    const r = results[i];
    const row = document.createElement('li');
    row.style.setProperty('--i', i);
    const no = document.createElement('span');
    no.className = 'recap-no';
    no.textContent = i + 1;
    const band = document.createElement('span');
    band.className = 'mini-band';
    band.append(...round.pixels.map((p) => swatch('', p.hex)));
    const photos = document.createElement('span');
    photos.className = 'recap-photos';
    photos.append(thumb(round.target, false));
    if (r.picked === null) {
      const late = document.createElement('span');
      late.className = 'recap-late';
      late.textContent = "Time's up";
      photos.append(late);
    } else if (!r.right) {
      photos.append(thumb(r.picked, true));
    }
    const mark = document.createElement('span');
    mark.className = 'recap-mark ' + (r.right ? 'is-right' : 'is-wrong');
    mark.textContent = r.right ? '✓' : '✗';
    row.append(no, band, photos, mark);
    return row;
  }));
  setPhase('final');
}

document.getElementById('start').addEventListener('click', newGame);
document.getElementById('again').addEventListener('click', newGame);
nextButton.addEventListener('click', next);

enableButtonWave();
setPhase('ready');
