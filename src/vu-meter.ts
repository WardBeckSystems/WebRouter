/*! Copyright (c) 2026 Ward-Beck Systems (Ward-Beck.ca). All rights reserved. */
/**
 * Stereo broadcast VU meter (SVG) used on every router strip.
 * One face, one scale, two needles on the same pivot: L is black, R is red.
 * No scale numbers, channel letters or VU legend.
 */

/** Needle pivot x for the L and R needles (they share one face), and pivot y. */
export const PIVOT_L = 50;
export const PIVOT_R = 50;
export const PIVOT_Y = 53;

const ARC_R = 40;      // scale arc radius
const NEEDLE = 45;     // needle length
const TICKS = [-20, -10, -5, 0, 3];

/** dB → needle angle (−42° rest … +42° full scale), VU law referenced to +3. */
export function vuDbToAngle(db: number): number {
  if (db <= -55 || !isFinite(db)) return -42;
  const p = Math.pow(10, (Math.max(-40, Math.min(3, db)) - 3) / 20);
  return -42 + 84 * Math.max(0, Math.min(1.05, p));
}

export const clampDb = (db: number): number => Math.max(-60, Math.min(3, isFinite(db) ? db : -60));

/** Point on a circle around the pivot at angle a (degrees from vertical). */
function polar(cx: number, r: number, a: number): string {
  const t = (a * Math.PI) / 180;
  return `${(cx + r * Math.sin(t)).toFixed(1)} ${(PIVOT_Y - r * Math.cos(t)).toFixed(1)}`;
}

function meterFace(idL: string, idR: string, cx: number): string {
  const a20 = vuDbToAngle(-20), a0 = vuDbToAngle(0), a3 = vuDbToAngle(3);
  const ticks = TICKS.map((db) => {
    const a = vuDbToAngle(db);
    return `<path d="M ${polar(cx, ARC_R, a)} L ${polar(cx, ARC_R + 5, a)}" class="${db >= 0 ? 'wr-meter-tick-red' : 'wr-meter-tick'}" />`;
  }).join('');
  const needle = (id: string, ch: 'l' | 'r') => `
      <g id="${id}" class="wr-needle-group" transform="rotate(-42 ${cx} ${PIVOT_Y})">
        <line x1="${cx}" y1="${PIVOT_Y}" x2="${cx}" y2="${PIVOT_Y - NEEDLE}" class="wr-meter-needle wr-meter-needle-${ch}" />
      </g>`;
  return `
    <g class="wr-meter-subgroup">
      <rect x="${cx - 47}" y="1" width="94" height="58" rx="4" class="wr-meter-bezel" />
      <rect x="${cx - 45}" y="3" width="90" height="54" rx="3" class="wr-meter-face" />
      <path d="M ${polar(cx, ARC_R, a20)} A ${ARC_R} ${ARC_R} 0 0 1 ${polar(cx, ARC_R, a0)}" class="wr-meter-arc-norm" />
      <path d="M ${polar(cx, ARC_R, a0)} A ${ARC_R} ${ARC_R} 0 0 1 ${polar(cx, ARC_R, a3)}" class="wr-meter-arc-over" />
      ${ticks}${needle(idR, 'r')}${needle(idL, 'l')}
      <circle cx="${cx}" cy="${PIVOT_Y}" r="3" class="wr-meter-hub" />
    </g>`;
}

export function renderMeterPair(prefix: string, idx: number): string {
  return `
    <div class="wr-theme-meters-wrap" title="L black · R red">
      <svg class="wr-theme-meter-svg" viewBox="0 0 100 60" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        ${meterFace(`${prefix}NeedleL${idx}`, `${prefix}NeedleR${idx}`, PIVOT_L)}
      </svg>
    </div>`;
}

/**
 * A host's own meter, shown in miniature on every strip (bezel, face, lamps and all): the
 * router copies its SVG (minus the needle) into each strip and draws its own L / R needles.
 */
export interface MeterArt {
  /** id of the host's meter group */
  href: string;
  /** id of the needle inside it, left out of the copies */
  needle: string;
  /** viewBox around the whole meter, housing included: x y w h */
  box: [number, number, number, number];
  /** needle pivot and length, in the host's units */
  pivot: [number, number];
  length: number;
  /** the glass window: needles are clipped to it so they never cross the bezel */
  window: [number, number, number, number, number];
  /** host's needle law: VU dB (0 = 0 VU, +3 = full scale) → degrees from vertical */
  angle: (db: number) => number;
}

/** The host's meter in miniature, with this strip's two needles (L black, R red). */
export function renderArtMeterPair(prefix: string, idx: number, art: MeterArt, overlay = ''): string {
  const [bx, by, bw, bh] = art.box;
  const [px, py] = art.pivot;
  const [wx, wy, ww, wh, wr] = art.window;
  const rest = art.angle(-60).toFixed(1);
  const clip = `${prefix}Win${idx}`;
  const needle = (id: string, ch: 'l' | 'r') => `
        <g id="${id}" class="wr-needle-group" transform="rotate(${rest} ${px} ${py})">
          <line x1="${px}" y1="${py}" x2="${px}" y2="${py - art.length}" class="wr-art-needle wr-art-needle-${ch}" vector-effect="non-scaling-stroke"/>
        </g>`;
  return `
    <div class="wr-theme-meters-wrap wr-art-meter" title="L black · R red">
      <svg class="wr-theme-meter-svg" viewBox="${bx} ${by} ${bw} ${bh}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        <clipPath id="${clip}"><rect x="${wx}" y="${wy}" width="${ww}" height="${wh}" rx="${wr}"/></clipPath>
        <g class="wr-art-slot" pointer-events="none"></g>
        <g clip-path="url(#${clip})">${needle(`${prefix}NeedleR${idx}`, 'r')}${needle(`${prefix}NeedleL${idx}`, 'l')}</g>
      </svg>
      ${overlay ? `<div class="wr-art-tag">${overlay}</div>` : ''}
    </div>`;
}

/**
 * The host meter as a template for the strips: a deep copy without its needle and with no
 * ids (clip paths and gradients then resolve to the host's own, which share the geometry).
 */
export function artTemplate(art: MeterArt): { src: Element; tpl: Element } | null {
  const src = document.getElementById(art.href);
  if (!src) return null;
  const tpl = src.cloneNode(true) as Element;
  tpl.querySelector(`#${CSS.escape(art.needle)}`)?.remove();
  tpl.querySelectorAll('title').forEach((t) => t.remove());
  for (const el of [tpl, ...Array.from(tpl.querySelectorAll('*'))]) {
    el.removeAttribute('id');
    el.removeAttribute('data-btn');
    el.classList.remove('xtm-btn');
  }
  return { src, tpl };
}
