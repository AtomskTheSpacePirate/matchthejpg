// Photo list, random order, and the random edit the player has to recreate each round.

const KEYS = ['brightness', 'contrast', 'highlights', 'midtones', 'shadows', 'saturation'];
const WHEELS = ['tintS', 'tintM', 'tintH']; // shadows, midtones, highlights
const MIN_SHIFT = 0.3; // each slider in the edit sits at 30-75% of its range
const MAX_SHIFT = 0.75;
const MAX_SATURATION = 0.5; // boosts beyond +50% look unreal; lowering keeps the full range
const WHEEL_MIN = 0.2; // each colour wheel sits at 20-50% of its radius
const WHEEL_MAX = 0.5;
const MAX_LIGHT_PUSH = 0.9; // keeps the brightening or darkening sliders from piling up
// Tints follow real colour grading: warm (orange to yellow) or cool (teal to blue), varied by
// up to HUE_SPREAD degrees either way, never a full green or magenta. Hues are the wheel's
// angle in degrees, which renderer.js maps like hsl() hues.
const WARM_HUE = 40;
const COOL_HUE = 205;
const HUE_SPREAD = 30;
const SPLIT_TONE_CHANCE = 0.6; // with shadows and highlights both tinted, how often they go opposite ways

// Two decimals, so every value can be hit exactly by a whole-number slider.
function round2(value) {
  return Math.round(value * 100) / 100;
}

function randomShift(min = MIN_SHIFT, max = MAX_SHIFT) {
  return min + Math.random() * (max - min);
}

// One round: a bold random edit. `count` sliders are moved and `wheelCount` colour wheels
// are pushed off-centre; the rest stay at 0. The player starts from the unedited photo, so
// the perfect answer is `look` itself.
export function makeRound(count = 4, wheelCount = WHEELS.length) {
  const look = {};
  let push;
  // Redraw the sliders if they all brighten or all darken, which would wash the photo out.
  do {
    for (const key of KEYS) look[key] = 0;
    for (const key of shuffle(KEYS).slice(0, count)) {
      const up = Math.random() < 0.5;
      const amount = round2(randomShift(MIN_SHIFT, key === 'saturation' && up ? MAX_SATURATION : MAX_SHIFT));
      look[key] = up ? amount : -amount;
    }
    push = look.brightness + 0.5 * (look.highlights + look.midtones + look.shadows);
  } while (Math.abs(push) > MAX_LIGHT_PUSH);

  for (const key of WHEELS) {
    look[key + 'x'] = 0;
    look[key + 'y'] = 0;
  }
  // Each tinted wheel goes warm or cool; shadows and highlights often split the two ways.
  const tinted = shuffle(WHEELS).slice(0, wheelCount);
  const warm = {};
  for (const key of tinted) warm[key] = Math.random() < 0.5;
  if ('tintS' in warm && 'tintH' in warm && Math.random() < SPLIT_TONE_CHANCE) warm.tintH = !warm.tintS;
  for (const key of tinted) {
    const hue = (warm[key] ? WARM_HUE : COOL_HUE) + (Math.random() * 2 - 1) * HUE_SPREAD;
    const angle = (hue * Math.PI) / 180;
    const amount = randomShift(WHEEL_MIN, WHEEL_MAX);
    look[key + 'x'] = round2(Math.cos(angle) * amount);
    look[key + 'y'] = round2(Math.sin(angle) * amount);
  }

  return { look };
}

// The photo pool: every image listed in photos-web/manifest.json. serve.ps1 rebuilds that list
// from the folder whenever it is requested, so adding a photo to photos-web is enough.
export async function loadPhotos() {
  const response = await fetch('photos-web/manifest.json', { cache: 'no-cache' });
  if (!response.ok) throw new Error('Photo list not found');
  const names = await response.json();
  return names.map((name) => 'photos-web/' + name);
}

// Fisher-Yates shuffle; returns a new array.
export function shuffle(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
