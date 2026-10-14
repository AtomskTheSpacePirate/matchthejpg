// Scoring: compares the player's picture with the target edit, not the control positions.
//
// Fitted to a player's own ratings of 40 rounds and checked on 32 more. Two things decide the score:
// 1. Band difference: pixels are grouped into brightness bands (from the unedited photo, so
//    both pictures use the same groups) and each band's average brightness, colour cast and
//    saturation are compared, weighted by how much of the photo the band covers. Lightness
//    differences in the darkest bands count less, because the eye barely notices how deep
//    shadows are.
// 2. Tint direction: in the shadows, midtones and highlights, a tint pushed the opposite way
//    from the target's (pink instead of yellow) is penalised; the same direction at a
//    different strength is not. The eye judges colour direction harshly and strength gently.

import { createRenderer } from './renderer.js';

const SIZE = 64; // both pictures are compared on a small copy
const BANDS = 8; // brightness bands, darkest to brightest
const DARK_BANDS = 3; // bands 0-2 count as shadows for the lightness discount
const SHADOW_LIGHTNESS = 0.4; // how much lightness differences count in those bands
const COLOUR_WEIGHT = 2.5; // colour cast and saturation count this much more than lightness
// Score = 100 * exp(-(BAND_WEIGHT * band difference + DIRECTION_WEIGHT * tint direction)),
// fitted to the ratings.
const BAND_WEIGHT = 4.42;
const DIRECTION_WEIGHT = 8.43;

// sRGB byte -> linear light
const LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// RGBA bytes -> OKLab (L, a, b per pixel), a colour space where distance matches what the eye sees.
function toLab(pixels) {
  const out = new Float32Array((pixels.length / 4) * 3);
  for (let i = 0, j = 0; i < pixels.length; i += 4, j += 3) {
    const r = LINEAR[pixels[i]];
    const g = LINEAR[pixels[i + 1]];
    const b = LINEAR[pixels[i + 2]];
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    out[j] = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    out[j + 1] = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    out[j + 2] = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  }
  return out;
}

// Average brightness, colour (a, b) and saturation for each group of pixels.
function groupStats(lab, groupOf, count) {
  const stats = Array.from({ length: count }, () => ({ n: 0, L: 0, a: 0, b: 0, C: 0 }));
  for (let i = 0; i < groupOf.length; i++) {
    const s = stats[groupOf[i]];
    const a = lab[i * 3 + 1];
    const b = lab[i * 3 + 2];
    s.n += 1;
    s.L += lab[i * 3];
    s.a += a;
    s.b += b;
    s.C += Math.hypot(a, b);
  }
  for (const s of stats) {
    if (!s.n) continue;
    s.L /= s.n;
    s.a /= s.n;
    s.b /= s.n;
    s.C /= s.n;
  }
  return stats;
}

// How far two tints point in different directions, each measured from the unedited photo:
// 0 when they point the same way, up to their average size when they point opposite ways.
function directionError(target, player, base) {
  const ta = target.a - base.a;
  const tb = target.b - base.b;
  const pa = player.a - base.a;
  const pb = player.b - base.b;
  const tSize = Math.hypot(ta, tb);
  const pSize = Math.hypot(pa, pb);
  if (tSize < 1e-4 || pSize < 1e-4) return 0;
  const cos = (ta * pa + tb * pb) / (tSize * pSize);
  return ((1 - cos) / 2) * (tSize + pSize) / 2;
}

export function createScorer() {
  const renderer = createRenderer(document.createElement('canvas'));
  renderer.resize(SIZE, SIZE);
  let bandOf = new Uint8Array(0); // brightness band per pixel
  let thirdOf = new Uint8Array(0); // shadows (0), midtones (1), highlights (2) per pixel
  let baseThirds = [];

  return {
    setImage(img) {
      renderer.setImage(img);
      // Groups come from the unedited photo, so a pixel stays in its group whatever the edit.
      const base = toLab(renderer.read({}));
      const n = base.length / 3;
      bandOf = new Uint8Array(n);
      thirdOf = new Uint8Array(n);
      const sorted = [];
      for (let i = 0; i < n; i++) {
        bandOf[i] = Math.min(BANDS - 1, Math.max(0, Math.floor(base[i * 3] * BANDS)));
        sorted.push(base[i * 3]);
      }
      sorted.sort((x, y) => x - y);
      const low = sorted[Math.floor(n / 3)];
      const high = sorted[Math.floor((2 * n) / 3)];
      for (let i = 0; i < n; i++) {
        const L = base[i * 3];
        thirdOf[i] = L < low ? 0 : L > high ? 2 : 1;
      }
      baseThirds = groupStats(base, thirdOf, 3);
    },
    // How different the pictures from two sets of shader settings look; 0 is identical.
    distance(a, b) {
      const labA = toLab(renderer.read(a));
      const labB = toLab(renderer.read(b));

      const bandsA = groupStats(labA, bandOf, BANDS);
      const bandsB = groupStats(labB, bandOf, BANDS);
      let bands = 0;
      for (let k = 0; k < BANDS; k++) {
        if (!bandsA[k].n) continue;
        const lightness = k < DARK_BANDS ? SHADOW_LIGHTNESS : 1;
        const d = Math.hypot(
          lightness * (bandsA[k].L - bandsB[k].L),
          COLOUR_WEIGHT * Math.hypot(bandsA[k].a - bandsB[k].a, bandsA[k].b - bandsB[k].b),
          COLOUR_WEIGHT * (bandsA[k].C - bandsB[k].C));
        bands += (bandsA[k].n / bandOf.length) * d;
      }

      const thirdsA = groupStats(labA, thirdOf, 3);
      const thirdsB = groupStats(labB, thirdOf, 3);
      let direction = 0;
      for (let k = 0; k < 3; k++) {
        if (thirdsA[k].n) direction += directionError(thirdsA[k], thirdsB[k], baseThirds[k]);
      }

      return BAND_WEIGHT * bands + DIRECTION_WEIGHT * direction;
    },
    // 0-100 from how close the two pictures look: 100 is identical.
    score(target, player) {
      return Math.round(100 * Math.exp(-this.distance(target, player)));
    },
  };
}
