// Photo list, random order, and the random edit the player has to recreate each round.

const KEYS = ['brightness', 'contrast', 'highlights', 'midtones', 'shadows', 'saturation'];
const WHEELS = ['tintS', 'tintM', 'tintH']; // shadows, midtones, highlights
const MIN_SHIFT = 0.3; // each setting in the edit sits at 30-75% of its slider or wheel
const MAX_SHIFT = 0.75;
const MAX_LIGHT_PUSH = 0.9; // keeps the brightening or darkening sliders from piling up

// Two decimals, so every value can be hit exactly by a whole-number slider.
function round2(value) {
  return Math.round(value * 100) / 100;
}

function randomShift() {
  return MIN_SHIFT + Math.random() * (MAX_SHIFT - MIN_SHIFT);
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
      const amount = round2(randomShift());
      look[key] = Math.random() < 0.5 ? -amount : amount;
    }
    push = look.brightness + 0.5 * (look.highlights + look.midtones + look.shadows);
  } while (Math.abs(push) > MAX_LIGHT_PUSH);

  for (const key of WHEELS) {
    look[key + 'x'] = 0;
    look[key + 'y'] = 0;
  }
  for (const key of shuffle(WHEELS).slice(0, wheelCount)) {
    const angle = Math.random() * Math.PI * 2;
    const amount = randomShift();
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
