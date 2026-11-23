/*! Copyright (c) 2026 Ward-Beck Systems (Ward-Beck.ca). All rights reserved. */
/** Miniature stereo broadcast VU meter pair (SVG) used on every router strip. */

/** One meter face. cx is the needle pivot x; the pair sits at x offsets 0 and 102. */
function meterFace(id: string, ch: 'L' | 'R', dx: number): string {
  const x = (v: number) => (v + dx).toFixed(1);
  return `
    <g class="wr-meter-subgroup">
      <rect x="${x(2)}" y="2" width="94" height="40" rx="3" class="wr-meter-bezel" />
      <rect x="${x(4)}" y="4" width="90" height="36" rx="2" class="wr-meter-face" />
      <text x="${x(8)}" y="13" class="wr-meter-ch-lbl">${ch}</text>
      <text x="${x(49)}" y="37" class="wr-meter-vu-lbl" text-anchor="middle">VU</text>
      <path d="M ${x(28.9)} 19.7 A 30 30 0 0 1 ${x(57.3)} 13.2" class="wr-meter-arc-norm" />
      <path d="M ${x(57.3)} 13.2 A 30 30 0 0 1 ${x(69.1)} 19.7" class="wr-meter-arc-over" />
      <line x1="${x(32.5)}" y1="19.3" x2="${x(30.2)}" y2="16.1" class="wr-meter-tick" />
      <line x1="${x(37.6)}" y1="16.4" x2="${x(36.0)}" y2="12.8" class="wr-meter-tick" />
      <line x1="${x(41.3)}" y1="15.1" x2="${x(40.2)}" y2="11.2" class="wr-meter-tick" />
      <line x1="${x(49.0)}" y1="14.0" x2="${x(49.0)}" y2="10.0" class="wr-meter-tick" />
      <line x1="${x(56.7)}" y1="15.1" x2="${x(57.8)}" y2="11.2" class="wr-meter-tick-red" />
      <line x1="${x(67.7)}" y1="21.2" x2="${x(70.4)}" y2="18.2" class="wr-meter-tick-red" />
      <text x="${x(27)}" y="25" class="wr-meter-tick-lbl" text-anchor="middle">-20</text>
      <text x="${x(49)}" y="8.5" class="wr-meter-tick-lbl" text-anchor="middle">-3</text>
      <text x="${x(58.5)}" y="9.5" class="wr-meter-tick-lbl-red" text-anchor="middle">0</text>
      <text x="${x(73)}" y="25" class="wr-meter-tick-lbl-red" text-anchor="middle">+3</text>
      <g id="${id}" class="wr-needle-group" transform="rotate(-42 ${x(49)} 42)">
        <line x1="${x(49)}" y1="42" x2="${x(49)}" y2="13" class="wr-meter-needle" />
        <circle cx="${x(49)}" cy="42" r="2.5" class="wr-meter-hub" />
      </g>
    </g>`;
}

/** Needle pivot x for the left and right faces. */
export const PIVOT_L = 49;
export const PIVOT_R = 151;

export function renderMeterPair(prefix: string, idx: number): string {
  return `
    <div class="wr-theme-meters-wrap">
      <svg class="wr-theme-meter-svg" viewBox="0 0 200 44" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        ${meterFace(`${prefix}NeedleL${idx}`, 'L', 0)}
        ${meterFace(`${prefix}NeedleR${idx}`, 'R', 102)}
      </svg>
    </div>`;
}

/** dB → needle angle (−42° rest … +42° full scale), VU law referenced to +3. */
export function vuDbToAngle(db: number): number {
  if (db <= -55 || !isFinite(db)) return -42;
  const p = Math.pow(10, (Math.max(-40, Math.min(3, db)) - 3) / 20);
  return -42 + 84 * Math.max(0, Math.min(1.05, p));
}

export const clampDb = (db: number): number => Math.max(-60, Math.min(3, isFinite(db) ? db : -60));
