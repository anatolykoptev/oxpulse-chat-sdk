// Voice-waveform helpers — browser-only (Canvas2D / OfflineAudioContext).

import { downsamplePeaks, DEFAULT_PEAK_BARS } from './waveform-math.ts';

interface OAC extends AudioContext {
  startRendering(): Promise<AudioBuffer>;
}

/** Decode the recorded blob with OfflineAudioContext and return a
 *  downsampled `peaks` array suitable for storage in the Attachment.
 *  Returns an empty array on decode failure — caller treats that as
 *  "no peaks" and the bubble renders a flat fallback. */
export async function extractPeaksFromBlob(
  blob: Blob,
  bars: number = DEFAULT_PEAK_BARS,
): Promise<ReadonlyArray<number>> {
  if (typeof OfflineAudioContext === 'undefined') return [];
  let arrayBuffer: ArrayBuffer;
  try {
    arrayBuffer = await blob.arrayBuffer();
  } catch {
    return [];
  }
  // 1-channel, 16 kHz is fine — we only need the envelope shape, not
  // fidelity. A short OfflineAudioContext keeps the decode cheap.
  const Ctor = OfflineAudioContext as unknown as {
    new (channels: number, length: number, sampleRate: number): OAC;
  };
  let oac: OAC;
  try {
    oac = new Ctor(1, 16_000, 16_000);
  } catch {
    return [];
  }
  let buffer: AudioBuffer;
  try {
    buffer = await oac.decodeAudioData(arrayBuffer.slice(0));
  } catch {
    return [];
  }
  const ch = buffer.getChannelData(0);
  const peaks = downsamplePeaks(ch, bars);
  // Defensive clamp + NaN guard. The canonical wire representation is
  // float[0,1]; a single rogue value (NaN from a silent recording, or
  // 1.0000001 from float math) would paint the waveform wrong. Clamp
  // here so downstream consumers always see a valid envelope.
  return peaks.map((v) => {
    if (!Number.isFinite(v)) return 0;
    if (v < 0) return 0;
    if (v > 1) return 1;
    return v;
  });
}

export interface WaveformTheme {
  readonly active: string;
  readonly inactive: string;
  readonly background?: string;
}

/** Default theme — app-neutral. The core package does not read app-
 *  specific CSS variables; shells pass their own theme built from
 *  their own tokens (widget: --oxp-accent; web: --brand-primary).
 *
 *  inactive WCAG 1.4.11: the prior rgba(128,128,128,0.28) blended to
 *  ~#bdbdbd on white → 1.38:1 FAIL (non-text needs ≥3:1). Raised to
 *  rgba(0,0,0,0.55) — models the chat-widget --oxp-spinner-track light
 *  token; blends to #737373 on white → 3.15:1 PASS, and to ~#637059 on
 *  a #dcf8c6 self-bubble → 4.58:1 PASS. Apps with dark bubble bgs MUST
 *  supply their own themed inactive (the widget does, via
 *  --oxp-waveform-inactive) — a single app-neutral value cannot clear
 *  3:1 on both light and dark backgrounds. */
export function defaultWaveformTheme(): WaveformTheme {
  return {
    active: 'currentColor',
    inactive: 'rgba(0,0,0,0.55)',
  };
}

/** Render an array of peaks (or live amplitude bars) into the canvas.
 *  Bars left of `progress * bars.length` use theme.active, the rest
 *  use theme.inactive. Set `progress = 1` for "all active" (live
 *  recording look), `progress = 0` for "all inactive" (idle bubble). */
export function renderStaticWaveform(
  canvas: HTMLCanvasElement,
  peaks: ReadonlyArray<number>,
  progress: number,
  theme: WaveformTheme,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const cssW = canvas.clientWidth || canvas.width;
  const cssH = canvas.clientHeight || canvas.height;
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  if (theme.background) {
    ctx.fillStyle = theme.background;
    ctx.fillRect(0, 0, cssW, cssH);
  }
  const n = peaks.length;
  if (n === 0) return;
  const gap = 1.5;
  const barW = Math.max(1.5, (cssW - gap * (n - 1)) / n);
  const midY = cssH / 2;
  const maxBarH = cssH - 2;
  const playedTo = Math.max(0, Math.min(1, progress)) * n;
  for (let i = 0; i < n; i++) {
    const amp = Math.max(0, Math.min(1, peaks[i] ?? 0));
    const h = Math.max(2, amp * maxBarH);
    const x = i * (barW + gap);
    ctx.fillStyle = i < playedTo ? theme.active : theme.inactive;
    const r = Math.min(barW / 2, 2);
    roundedBar(ctx, x, midY - h / 2, barW, h, r);
  }
}

function roundedBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
  ctx.fill();
}
