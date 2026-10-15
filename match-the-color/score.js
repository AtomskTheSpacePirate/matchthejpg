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
//    A tint is what the colour wheels did to the picture (the picture with them minus without
//    them), so saturation and the other sliders don't count as tints.
// For the result screen the score is split into a Light part (the band difference counting
// lightness alone) and a Colour part (everything else); Light times Colour is the score.

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
// Trial: the round's % is the average of Light and Colour. false puts back the scoring fitted
// to the ratings (the bars are then only a guide).
const AVERAGE_PARTS = true;
// In that average the weaker part counts this many times (2: Light 99, Colour 49 -> 66).
// 1 is a plain average.
const WEAKER_WEIGHT = 2;
// Trial: each part is raised to this power so weak matches drop further (2.25: 90 -> 79,
// 70 -> 45, 50 -> 21). 1 puts back the curve fitted to the ratings.
const PART_POWER = 2.25;
// Lightness counts this much in the Light part: fitting Light and Colour separately to the
// ratings gave lightness about a third of its weight here (1.42 against 4.42). 1 is unscaled.
const LIGHT_SCALE = 0.32;
// Trial: false leaves the tint-direction penalty out of the Colour part, which then measures
// only how different the colours look. true adds it back on top.
const DIRECTION_PENALTY = false;
// Colour differences up to this much (in OKLab, where about 0.02 is just noticeable) cost
// nothing in the Colour part; above it only the excess counts. 0 counts every difference.
const COLOUR_TOLERANCE = 0.02;

const HINT_MIN = 0.05; // smallest difference worth a hint, in distance (about 5 points off the score)
const LIGHT_VISIBLE = 0.03; // smallest lightness difference in a range worth a hint (3% of black to white)
const MAX_HINTS = 3;
const TONES = ['Shadows', 'Midtones', 'Highlights'];
// OKLab hue angles of everyday colour names.
const HUES = [
  [29, 'red'], [60, 'orange'], [105, 'yellow'], [142, 'green'],
  [195, 'cyan'], [264, 'blue'], [300, 'purple'], [340, 'pink'],
];

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

// The same settings with every colour wheel at the centre.
function withoutWheels(params) {
  return { ...params, tintSx: 0, tintSy: 0, tintMx: 0, tintMy: 0, tintHx: 0, tintHy: 0 };
}

// What the colour wheels did to a group of pixels, as an (a, b) shift: its colour with the
// wheels minus its colour without them. Saturation and the other sliders cancel out.
function tintOf(withWheels, without) {
  return { a: withWheels.a - without.a, b: withWheels.b - without.b };
}

// How far two tints point in different directions: 0 when they point the same way, up to
// their average size when they point opposite ways.
function directionError(target, player) {
  const tSize = Math.hypot(target.a, target.b);
  const pSize = Math.hypot(player.a, player.b);
  if (tSize < 1e-4 || pSize < 1e-4) return 0;
  const cos = (target.a * player.a + target.b * player.b) / (tSize * pSize);
  return ((1 - cos) / 2) * (tSize + pSize) / 2;
}

// Nearest colour name for an OKLab (a, b) direction.
function hueName(a, b) {
  const deg = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  let best = HUES[0];
  let gap = 360;
  for (const hue of HUES) {
    const d = Math.min(Math.abs(deg - hue[0]), 360 - Math.abs(deg - hue[0]));
    if (d < gap) {
      gap = d;
      best = hue;
    }
  }
  return best[1];
}

export function createScorer() {
  const renderer = createRenderer(document.createElement('canvas'));
  renderer.resize(SIZE, SIZE);
  let bandOf = new Uint8Array(0); // brightness band per pixel
  let thirdOf = new Uint8Array(0); // shadows (0), midtones (1), highlights (2) per pixel

  // Shadows/midtones/highlights stats of the picture from these settings.
  const thirds = (params) => groupStats(toLab(renderer.read(params)), thirdOf, 3);

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
    },
    // How different the pictures from two sets of shader settings look; 0 is identical.
    // `total` is the fitted scoring's distance; `light` and `colour` measure lightness and
    // colour (cast, saturation and tint direction) each on its own, for the Light and Colour parts.
    distance(a, b) {
      const labA = toLab(renderer.read(a));
      const labB = toLab(renderer.read(b));

      const bandsA = groupStats(labA, bandOf, BANDS);
      const bandsB = groupStats(labB, bandOf, BANDS);
      let bands = 0;
      let light = 0;
      let colour = 0;
      for (let k = 0; k < BANDS; k++) {
        if (!bandsA[k].n) continue;
        const share = bandsA[k].n / bandOf.length;
        const dL = (k < DARK_BANDS ? SHADOW_LIGHTNESS : 1) * (bandsA[k].L - bandsB[k].L);
        const dColour = Math.hypot(
          bandsA[k].a - bandsB[k].a, bandsA[k].b - bandsB[k].b, bandsA[k].C - bandsB[k].C);
        bands += share * Math.hypot(dL, COLOUR_WEIGHT * dColour);
        light += share * Math.abs(dL);
        colour += share * COLOUR_WEIGHT * Math.max(0, dColour - COLOUR_TOLERANCE);
      }

      // Tint direction compares only what each side's colour wheels did to the picture.
      const thirdsA = groupStats(labA, thirdOf, 3);
      const thirdsB = groupStats(labB, thirdOf, 3);
      const plainA = thirds(withoutWheels(a));
      const plainB = thirds(withoutWheels(b));
      let direction = 0;
      for (let k = 0; k < 3; k++) {
        if (!thirdsA[k].n) continue;
        direction += directionError(tintOf(thirdsA[k], plainA[k]), tintOf(thirdsB[k], plainB[k]));
      }

      return {
        total: BAND_WEIGHT * bands + DIRECTION_WEIGHT * direction,
        light: BAND_WEIGHT * light,
        colour: BAND_WEIGHT * colour + (DIRECTION_PENALTY ? DIRECTION_WEIGHT * direction : 0),
        // Each cost on its own, before the Light and Colour curves, for debugging.
        costs: {
          light: LIGHT_SCALE * BAND_WEIGHT * light,
          colourDifference: BAND_WEIGHT * colour,
          direction: DIRECTION_WEIGHT * direction,
          directionCounted: DIRECTION_PENALTY,
        },
      };
    },
    // 0-100 from how close the two pictures look, 100 is identical, split into Light and
    // Colour. The score is a mix of the two that leans on the weaker (see AVERAGE_PARTS), or
    // with AVERAGE_PARTS off, the fitted scoring unchanged.
    breakdown(target, player) {
      const d = this.distance(target, player);
      const light = Math.exp(-LIGHT_SCALE * d.light) ** PART_POWER;
      const colour = Math.exp(-d.colour) ** PART_POWER;
      const weaker = Math.min(light, colour);
      const stronger = Math.max(light, colour);
      const average = (WEAKER_WEIGHT * weaker + stronger) / (WEAKER_WEIGHT + 1);
      return {
        score: Math.round(100 * (AVERAGE_PARTS ? average : Math.exp(-d.total))),
        light: Math.round(100 * light),
        colour: Math.round(100 * colour),
        costs: d.costs,
      };
    },
    // The biggest visible differences in plain words, worst first; empty when nothing stands
    // out. Sizes are rough shares of the score's distance, so the hints agree with the score.
    explain(target, player) {
      const t = thirds(target);
      const p = thirds(player);
      const plainT = thirds(withoutWheels(target));
      const plainP = thirds(withoutWheels(player));
      const hints = [];
      const add = (size, text) => {
        if (size >= HINT_MIN) hints.push({ size, text });
      };

      // Lightness, split the way the eye reads it (positive where the player's picture is brighter):
      // brightness is only what shadows and highlights share, contrast is how differently they
      // moved, and midtones are what is left in between. Each gets a hint once it is visible,
      // "slightly" while under twice that; sizes are shares of the Light part, for the order.
      const [dS, dM, dH] = t.map((s, k) => p[k].L - s.L);
      const shared = dS * dH > 0 ? Math.sign(dS) * Math.min(Math.abs(dS), Math.abs(dH)) : 0;
      const contrast = dH - dS; // positive: the player's picture has more contrast
      const mid = dM - (dS + dH) / 2;
      const lightHint = (d, size, text) => {
        if (Math.abs(d) < LIGHT_VISIBLE) return;
        const slight = Math.abs(d) < 2 * LIGHT_VISIBLE;
        hints.push({ size: LIGHT_SCALE * BAND_WEIGHT * size, text: text(slight) });
      };
      lightHint(shared, Math.abs(shared), (slight) =>
        'The whole photo is ' + (slight ? 'slightly ' : '') + (shared > 0 ? 'too bright' : 'too dark'));
      lightHint(contrast, Math.abs(contrast) / 3, (slight) => (contrast > 0
        ? (slight ? 'Slightly too much contrast' : 'Too much contrast')
        : (slight ? 'Slightly flat, it needs a bit more contrast' : 'Too flat, it needs more contrast')));
      lightHint(mid, Math.abs(mid) / 3, (slight) =>
        'Midtones ' + (slight ? 'slightly ' : '') + (mid > 0 ? 'too bright' : 'too dark'));

      const chroma = (p[0].C + p[1].C + p[2].C - t[0].C - t[1].C - t[2].C) / 3;
      add(BAND_WEIGHT * COLOUR_WEIGHT * Math.max(0, Math.abs(chroma) - COLOUR_TOLERANCE),
        chroma > 0 ? 'Colours too strong' : 'Colours too muted');

      // Colour cast per range from the wheels alone (what each side's wheels did to the picture),
      // so saturation differences show up only in the hint above.
      for (let k = 0; k < 3; k++) {
        const tt = tintOf(t[k], plainT[k]);
        const pt = tintOf(p[k], plainP[k]);
        const size =
          BAND_WEIGHT * COLOUR_WEIGHT * Math.max(0, Math.hypot(tt.a - pt.a, tt.b - pt.b) - COLOUR_TOLERANCE) / 3 +
          (DIRECTION_PENALTY ? DIRECTION_WEIGHT * directionError(tt, pt) : 0);
        const tSize = Math.hypot(tt.a, tt.b);
        const pSize = Math.hypot(pt.a, pt.b);
        const cos = tSize && pSize ? (tt.a * pt.a + tt.b * pt.b) / (tSize * pSize) : 0;
        if (cos < 0) {
          add(size, TONES[k] + ' went ' + hueName(pt.a, pt.b) + ', the edit went ' + hueName(tt.a, tt.b));
        } else if (cos > 0.7 && pSize > tSize) {
          add(size, TONES[k] + ' too ' + hueName(pt.a, pt.b));
        } else {
          add(size, TONES[k] + ' need more ' + hueName(tt.a - pt.a, tt.b - pt.b));
        }
      }

      return hints.sort((x, y) => y.size - x.size).slice(0, MAX_HINTS).map((h) => h.text);
    },
  };
}
