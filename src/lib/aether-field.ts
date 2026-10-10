import type { Print, Side } from "@/lib/btc-tape";
import { GLTrail, SHAPE_GLOW, SHAPE_STRIDE, type Composite, type Rgba } from "@/lib/trail-gl";

export type GroundId = "ink" | "abyss" | "coal" | "paper";

export type FieldSettings = {
  intensity: number;
  trail: number;
  clash: number;
  ground: GroundId;
};

export const DEFAULT_SETTINGS: FieldSettings = {
  intensity: 1.2,
  trail: 0.74,
  clash: 1.3,
  ground: "ink",
};

export const GROUNDS: Record<
  GroundId,
  { label: string; hex: string; rgb: [number, number, number]; additive: boolean }
> = {
  ink: { label: "Ink", hex: "#07080c", rgb: [7, 8, 12], additive: true },
  abyss: { label: "Abyss", hex: "#061418", rgb: [6, 20, 24], additive: true },
  coal: { label: "Coal", hex: "#14110e", rgb: [20, 17, 14], additive: true },
  paper: { label: "Paper", hex: "#f3efe6", rgb: [243, 239, 230], additive: false },
};

const STORAGE_KEY = "aether-tape-v1";

/** Hard ceiling on live particles; the per-frame cap from Intensity sits well below it. */
const CAPACITY = 8192;

type Ripple = { x: number; y: number; r: number; a: number; side: 0 | 1 };

type Job = { side: 0 | 1; notional: number };

type Stroke = { rgba: Rgba; css: string; width: number };
type Lane = Stroke & { core?: Stroke };

function stroke(r: number, g: number, b: number, a: number, width: number): Stroke {
  return { rgba: [r / 255, g / 255, b / 255, a], css: `rgba(${r},${g},${b},${a})`, width };
}

function lane(body: Stroke, core?: Stroke): Lane {
  return core ? { ...body, core } : body;
}

/** Stroke styles per lane, indexed side * 3 + tier (0 fading, 1 body, 2 hot). */
const LIGHT_LANES: Lane[] = [
  lane(stroke(8, 120, 86, 0.5, 1.3)),
  lane(stroke(12, 170, 116, 0.7, 1.7)),
  lane(stroke(30, 220, 156, 0.88, 2.5), stroke(200, 255, 236, 0.42, 1)),
  lane(stroke(130, 22, 18, 0.55, 1.3)),
  lane(stroke(200, 36, 28, 0.74, 1.7)),
  lane(stroke(246, 66, 40, 0.9, 2.5), stroke(255, 214, 190, 0.42, 1)),
];

const INK_LANES: Lane[] = [
  lane(stroke(40, 140, 104, 0.35, 1.2)),
  lane(stroke(6, 118, 74, 0.78, 1.8)),
  lane(stroke(3, 84, 52, 0.95, 2.6)),
  lane(stroke(196, 70, 52, 0.38, 1.2)),
  lane(stroke(168, 28, 18, 0.8, 1.8)),
  lane(stroke(116, 14, 8, 0.95, 2.6)),
];

const BLACK: Rgba = [0, 0, 0, 1];
const WHITE: Rgba = [1, 1, 1, 1];

/**
 * The field is drawn as stacked layers the browser composites on the GPU:
 * a CSS backdrop, the persistent trail canvas (blended with screen, or multiply on paper),
 * a quarter-size glow canvas, and an overlay canvas redrawn from scratch every frame.
 */
export type FieldLayers = {
  backdrop: HTMLElement;
  trail: HTMLCanvasElement;
  glow: HTMLCanvasElement;
  overlay: HTMLCanvasElement;
};

/**
 * WebGL2 draws the whole field into the trail canvas. Without it, Canvas2D draws the trail,
 * glow and overlay canvases and CSS supplies the backdrop and vignette.
 */
type View = {
  root: HTMLElement | null;
  backdrop: HTMLElement;
  trailCanvas: HTMLCanvasElement;
  gl: GLTrail | null;
  trail: CanvasRenderingContext2D | null;
  glow: CanvasRenderingContext2D | null;
  overlay: CanvasRenderingContext2D | null;
};

export type FieldStats = {
  renderer: "gpu" | "basic";
  fps: number;
  /** Share of full resolution the field renders at, 0..100. */
  resolution: number;
  /** Share of the full particle budget in use, 0..100. */
  detail: number;
};

/** Shape instances the overlay can hold: dust, two strokes per shockwave and the flash. */
const SHAPE_CAPACITY = 512;

type Motes = { count: number; x: Float32Array; y: Float32Array; phase: Float32Array; size: Float32Array };

export function sanitizeSettings(raw: Partial<FieldSettings> | null | undefined): FieldSettings {
  return {
    intensity: clamp(num(raw?.intensity, DEFAULT_SETTINGS.intensity), 0.5, 2.2),
    trail: clamp(num(raw?.trail, DEFAULT_SETTINGS.trail), 0, 1),
    clash: clamp(num(raw?.clash, DEFAULT_SETTINGS.clash), 0.4, 2.2),
    ground: isGround(raw?.ground) ? raw.ground : DEFAULT_SETTINGS.ground,
  };
}

export function loadSettings(): FieldSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return sanitizeSettings(JSON.parse(raw) as Partial<FieldSettings>);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: FieldSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* private mode */
  }
}

export class AetherField {
  w = 1;
  h = 1;
  dpr = 1;
  t = 0;
  reduce = false;
  needsClear = true;
  front = 0.5;
  ripples: Ripple[] = [];
  /** Share of the device pixel ratio the layers render at; lowered while frames run long. */
  quality = 1;
  // Particles live in flat typed arrays; `live` lists the occupied slots, `free` the rest.
  private px = new Float32Array(CAPACITY);
  private py = new Float32Array(CAPACITY);
  private ox = new Float32Array(CAPACITY);
  private oy = new Float32Array(CAPACITY);
  private vx = new Float32Array(CAPACITY);
  private vy = new Float32Array(CAPACITY);
  private life = new Float32Array(CAPACITY);
  private side = new Uint8Array(CAPACITY);
  private spark = new Uint8Array(CAPACITY);
  private tier = new Uint8Array(CAPACITY);
  private live = new Int32Array(CAPACITY);
  private liveCount = 0;
  private free = Int32Array.from({ length: CAPACITY }, (_, i) => CAPACITY - 1 - i);
  private freeCount = CAPACITY;
  // One slot past the particles holds the front seam, drawn with the same streak shader.
  private segs = new Float32Array((CAPACITY + 1) * 4);
  private shapes = new Float32Array(SHAPE_CAPACITY * SHAPE_STRIDE);
  /** Share of the particle budget in use; trimmed once resolution can drop no further. */
  private detail = 1;
  private fpsEma = 60;
  private lastInk = false;
  private laneCursor = new Int32Array(6);
  private laneStart = new Int32Array(6);
  private laneCount = new Int32Array(6);
  private curl = { x: 0, y: 0 };
  private curlFine = { x: 0, y: 0 };
  private frameEma = 1 / 60;
  private lastNow = 0;
  private slowFor = 0;
  private fastFor = 0;
  private settle = 2;
  private layersDirty = false;
  private ground: GroundId = "ink";
  private view: View | null = null;
  private backKey = "";
  private glowAlpha = -1;
  private frame = 0;
  private motes: Motes = { count: 0, x: new Float32Array(0), y: new Float32Array(0), phase: new Float32Array(0), size: new Float32Array(0) };
  private frameDt = 1 / 60;
  private crowd = 0;
  private queue: Job[] = [];
  private mobile = false;
  private bias = 0;
  private biasTarget = 0;
  private pressure = 0;
  private pressureTarget = 0;
  private flowUsd = 0;
  private surgeBuy = 0;
  private surgeSell = 0;
  private surgeCd = 0;
  private boom = 0.6;
  private flash = { side: 0 as 0 | 1, a: 0, x: 0, y: 0 };
  band = 0;

  resize(w: number, h: number, dpr: number) {
    const sx = this.w > 1 ? w / this.w : 1;
    const sy = this.h > 1 ? h / this.h : 1;
    if (this.w > 1) {
      for (let k = 0; k < this.liveCount; k++) {
        const i = this.live[k];
        this.px[i] *= sx;
        this.py[i] *= sy;
        this.ox[i] *= sx;
        this.oy[i] *= sy;
      }
    }
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
    this.dpr = dpr;
    this.mobile = w < 760;
    if (this.band <= 0) this.band = this.h * 0.58;
    this.seedMotes(sx, sy);
    this.needsClear = true;
  }

  /** Slow dust that drifts behind the streams, like the sparkle in the share card. */
  private seedMotes(sx: number, sy: number) {
    const count = Math.round(clamp((this.w * this.h) / 5200, 60, 320));
    const prev = this.motes;
    const next: Motes = {
      count,
      x: new Float32Array(count),
      y: new Float32Array(count),
      phase: new Float32Array(count),
      size: new Float32Array(count),
    };
    for (let i = 0; i < count; i++) {
      const keep = i < prev.count;
      next.x[i] = keep ? prev.x[i] * sx : Math.random() * this.w;
      next.y[i] = keep ? prev.y[i] * sy : Math.random() * this.h;
      next.phase[i] = keep ? prev.phase[i] : Math.random();
      next.size[i] = keep ? prev.size[i] : 0.8 + Math.random() * Math.random() * 1.8;
    }
    this.motes = next;
  }

  /** Device pixels per CSS pixel the layers actually render at. */
  get renderScale() {
    return this.dpr * this.quality;
  }

  setBand(y: number) {
    this.band = clamp(y, 140, Math.max(140, this.h - 24));
  }

  setBias(bias: number) {
    this.biasTarget = clamp(bias, -1, 1);
  }

  setFlow(buy: number, sell: number) {
    const total = Math.max(0, buy) + Math.max(0, sell);
    this.flowUsd = total;
    const tilt = total < 80 ? 0 : clamp((buy - sell) / total, -1, 1);
    this.pressureTarget = tilt;
    this.biasTarget = tilt;
  }

  impulse(side: Side, strength: number) {
    this.detonate(side === "buy" ? 0 : 1, 0.28 + clamp(strength, 0, 1) * 0.72);
  }

  ingest(print: Print) {
    if (!Number.isFinite(print.notional) || print.notional <= 0) return;
    this.queue.push({ side: print.side === "buy" ? 0 : 1, notional: print.notional });
    if (this.queue.length > 500) this.queue.splice(0, this.queue.length - 500);
    if (print.side === "buy") this.surgeBuy += print.notional;
    else this.surgeSell += print.notional;
    if (print.notional >= 25_000) this.detonate(print.side === "buy" ? 0 : 1, clamp(print.notional / 90_000, 0.55, 1));
  }

  reset() {
    while (this.liveCount > 0) this.kill(this.liveCount - 1);
    this.queue.length = 0;
    this.ripples.length = 0;
    this.front = 0.5;
    this.pressure = 0;
    this.pressureTarget = 0;
    this.surgeBuy = 0;
    this.surgeSell = 0;
    this.flash.a = 0;
    this.needsClear = true;
  }

  step(dt: number, settings: FieldSettings) {
    this.t += dt;
    this.frameDt = dt;
    this.adaptQuality();
    const clash = settings.clash * (this.reduce ? 0.5 : 1);
    this.bias += (this.biasTarget - this.bias) * Math.min(1, dt * 1.5);
    this.pressure += (this.pressureTarget - this.pressure) * Math.min(1, dt * 2.4);
    const drive = clamp(this.bias * 0.55 + this.pressure * 0.45, -1, 1);
    const target = clamp(0.5 + drive * 0.4 * Math.min(clash, 1.8), 0.14, 0.86);
    this.front += (target - this.front) * Math.min(1, dt * 1.6);
    this.flash.a = Math.max(0, this.flash.a - dt * 1.35);
    this.surgeBuy *= Math.exp(-dt * 1.35);
    this.surgeSell *= Math.exp(-dt * 1.35);
    this.surgeCd -= dt;
    this.boom -= dt;
    const net = this.surgeBuy - this.surgeSell;
    if (!this.reduce && this.surgeCd <= 0 && Math.abs(net) > 6_000) {
      this.detonate(net > 0 ? 0 : 1, clamp(Math.abs(net) / 55_000, 0.34, 1));
      this.surgeBuy *= 0.15;
      this.surgeSell *= 0.15;
      this.surgeCd = 0.32;
      this.boom = 0.7;
    } else if (!this.reduce && this.boom <= 0) {
      const mag = Math.abs(this.pressure);
      if (mag > 0.14 && this.flowUsd > 250) {
        this.detonate(this.pressure > 0 ? 0 : 1, 0.22 + mag * 0.78);
        this.boom = 1.2 - mag * 0.82;
      } else this.boom = 0.45;
    }

    let budget = this.mobile ? 70 : 110;
    while (budget > 0 && this.queue.length) {
      const job = this.queue.shift();
      if (!job) break;
      budget -= this.spawnJob(job, settings.intensity * this.detail, budget);
    }

    if (!this.reduce) {
      const tilt = Math.abs(this.pressure);
      const pour = Math.round((this.mobile ? 4 : 7) * (0.45 + tilt * 2.1) * this.detail);
      const buyShare = clamp(0.5 + this.pressure * 0.5, 0.05, 0.95);
      for (let i = 0; i < pour; i++) this.birth(Math.random() < buyShare ? 0 : 1, false);
    }

    const cap = Math.round((this.mobile ? 1600 : 2800) * (0.7 + settings.intensity * 0.35) * this.detail);
    this.crowd += (clamp(this.liveCount / cap, 0, 1) - this.crowd) * Math.min(1, dt * 2);
    if (this.liveCount > cap) {
      let extra = this.liveCount - cap;
      for (let k = this.liveCount - 1; k >= 0 && extra > 0; k--) {
        if (this.life[this.live[k]] < 0.45) {
          this.kill(k);
          extra--;
        }
      }
    }

    const fx = this.front * this.w;
    const scale = 0.0031;
    const drift = this.t * 0.16;
    const band = 96 + clash * 46;
    const invBand2 = 1 / (band * band);
    const waveT = this.t * (0.85 + clash * 0.2);
    const rollAmp = 560 + clash * 300;
    const turbBase = 0.6 + clash * 0.22;
    const push = 220 + clash * 60;
    const max = this.reduce ? 340 : 1500 + clash * 280;
    const max2 = max * max;
    const damp = 0.996;
    const { px, py, ox, oy, vx, vy, life, side, live } = this;
    const broad = this.curl;
    const fine = this.curlFine;
    const right = this.w + 80;
    const bottom = this.h + 80;
    for (let k = this.liveCount - 1; k >= 0; k--) {
      const i = live[k];
      const x = px[i];
      const y = py[i];
      const s = side[i];
      const dir = s === 0 ? 1 : -1;
      const age = 1 - life[i];
      const dist = x - fx;
      const shear = Math.exp(-dist * dist * invBand2);
      const wave = y * 0.0105 + waveT;
      const sinW = Math.sin(wave);
      const cosW = Math.cos(wave);
      const nx = x * scale;
      const ny = y * scale + drift + s * 3.5;
      curlInto(nx, ny, broad);
      curlInto(nx * 2.8 + 17, ny * 2.8, fine);
      const turb = (this.reduce ? 36 : 70 + age * 520) * turbBase;
      const dvx =
        dir * push * (1 - shear * 0.78) +
        (broad.x * 0.74 + fine.x * 0.26) * turb -
        cosW * (dist > 0 ? 1 : dist < 0 ? -1 : dir) * shear * 240;
      const dvy = sinW * shear * rollAmp * dir + (broad.y * 0.74 + fine.y * 0.26) * turb;
      const invaded = dir === 1 ? dist > 36 : dist < -36;
      const l = life[i] - dt * (invaded ? 0.2 : 0.038);
      life[i] = l;
      const steer = Math.min(1, dt * (3.2 + age * 7));
      let nvx = (vx[i] + (dvx - vx[i]) * steer) * damp;
      let nvy = (vy[i] + (dvy - vy[i]) * steer) * damp;
      const sp2 = nvx * nvx + nvy * nvy;
      if (sp2 > max2) {
        const k2 = max / Math.sqrt(sp2);
        nvx *= k2;
        nvy *= k2;
      }
      vx[i] = nvx;
      vy[i] = nvy;
      ox[i] = x;
      oy[i] = y;
      const nxp = x + nvx * dt;
      const nyp = y + nvy * dt;
      px[i] = nxp;
      py[i] = nyp;
      if (l <= 0 || nxp < -80 || nxp > right || nyp < -80 || nyp > bottom) this.kill(k);
    }

    const m = this.motes;
    const moteDrift = this.reduce ? 4 : 14;
    for (let i = 0; i < m.count; i++) {
      const flow = curlInto(m.x[i] * 0.0022 + 40, m.y[i] * 0.0022 + this.t * 0.05, broad);
      const dir = m.x[i] < fx ? 1 : -1;
      m.x[i] += (flow.x * moteDrift + dir * 3) * dt;
      m.y[i] += flow.y * moteDrift * dt;
      if (m.x[i] < -4) m.x[i] += this.w + 8;
      else if (m.x[i] > this.w + 4) m.x[i] -= this.w + 8;
      if (m.y[i] < -4) m.y[i] += this.h + 8;
      else if (m.y[i] > this.h + 4) m.y[i] -= this.h + 8;
    }

    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const r = this.ripples[i];
      r.r += dt * (640 + r.r * 0.55);
      r.a -= dt * 0.85;
      if (r.a <= 0) this.ripples.splice(i, 1);
    }
  }

  attach(layers: FieldLayers) {
    const gl = GLTrail.create(layers.trail);
    const trail = gl ? null : layers.trail.getContext("2d", { alpha: false });
    const glow = gl ? null : layers.glow.getContext("2d");
    const overlay = gl ? null : layers.overlay.getContext("2d");
    if (!gl && (!trail || !glow || !overlay)) return false;
    // With WebGL the trail canvas is the whole picture; CSS hides the other layers (styles.css).
    const root = layers.trail.parentElement;
    root?.setAttribute("data-renderer", gl ? "gpu" : "basic");
    this.view = { root, backdrop: layers.backdrop, trailCanvas: layers.trail, gl, trail, glow, overlay };
    this.needsClear = true;
    this.backKey = "";
    this.glowAlpha = -1;
    return true;
  }

  /** Sizes every layer to the field at the current render scale. */
  fitLayers() {
    const view = this.view;
    if (!view) return;
    this.layersDirty = false;
    const rs = this.renderScale;
    const dw = Math.max(1, Math.round(this.w * rs));
    const dh = Math.max(1, Math.round(this.h * rs));
    if (view.gl) {
      view.gl.resize(this.w, this.h, rs);
    } else if (view.trailCanvas.width !== dw || view.trailCanvas.height !== dh) {
      view.trailCanvas.width = dw;
      view.trailCanvas.height = dh;
      this.needsClear = true;
    }
    if (view.overlay && (view.overlay.canvas.width !== dw || view.overlay.canvas.height !== dh)) {
      view.overlay.canvas.width = dw;
      view.overlay.canvas.height = dh;
    }
    if (view.glow) {
      const gw = Math.max(1, Math.round(this.w / 4));
      const gh = Math.max(1, Math.round(this.h / 4));
      if (view.glow.canvas.width !== gw || view.glow.canvas.height !== gh) {
        view.glow.canvas.width = gw;
        view.glow.canvas.height = gh;
      }
    }
    this.backKey = "";
  }

  draw(settings: FieldSettings) {
    const view = this.view;
    if (!view) return;
    if (this.layersDirty) this.fitLayers();
    const ground = GROUNDS[settings.ground];
    const ink = !ground.additive;
    const fresh = this.needsClear || this.ground !== settings.ground;
    this.needsClear = false;
    this.ground = settings.ground;
    this.frame++;
    const rs = this.renderScale;
    const perFrame = ink ? 0.11 - settings.trail * 0.065 : 0.05 - settings.trail * 0.034;
    const fade = 1 - Math.pow(1 - perFrame, this.frameDt * 60);
    // Bloom flatters a sparse field but washes a crowded one out to white.
    const glowAlpha = ink ? 0 : Math.round((0.5 - this.crowd * 0.32) * 50) / 50;
    const tones = ink ? INK_LANES : LIGHT_LANES;
    this.packSegments();

    if (view.gl) {
      const gl = view.gl;
      const base = ink ? WHITE : BLACK;
      if (gl.takeBlank() || fresh) gl.clear(base);
      else gl.fade(base, fade);
      // The front seam rides in the slot after the last lane, so one upload covers both.
      const seam = (this.laneStart[5] + this.laneCount[5]) * 4;
      this.segs[seam] = this.front * this.w;
      this.segs[seam + 1] = this.h * 0.14;
      this.segs[seam + 2] = this.front * this.w;
      this.segs[seam + 3] = Math.max(this.h * 0.24, this.band - 28);
      gl.upload(this.segs, seam / 4 + 1);
      for (let i = 0; i < 6; i++) gl.strokes(this.laneStart[i], this.laneCount[i], tones[i].rgba, tones[i].width, false);
      if (!ink) {
        for (let i = 0; i < 6; i++) {
          const core = tones[i].core;
          if (core) gl.strokes(this.laneStart[i], this.laneCount[i], core.rgba, core.width, true);
        }
      }
      this.glowAlpha = glowAlpha;
      this.lastInk = ink;
      this.composeGL(gl, ink);
      return;
    }
    if (view.trail && view.glow && view.overlay) {
      const trail = view.trail;
      // Trails: black for light-emitting grounds, white for ink on paper.
      trail.setTransform(rs, 0, 0, rs, 0, 0);
      trail.globalCompositeOperation = "source-over";
      if (fresh) {
        trail.fillStyle = ink ? "#fff" : "#000";
        trail.fillRect(0, 0, this.w, this.h);
      } else {
        trail.fillStyle = ink ? `rgba(255,255,255,${fade.toFixed(4)})` : `rgba(0,0,0,${fade.toFixed(4)})`;
        trail.fillRect(0, 0, this.w, this.h);
        // An 8-bit alpha fade stalls a few levels short of the ground and leaves ghosts.
        // Every few frames, burn (or dodge) by a hair so faint residue reaches pure black (or white).
        if (this.frame % 3 === 0) {
          trail.globalCompositeOperation = ink ? "color-dodge" : "color-burn";
          trail.fillStyle = ink ? "rgb(6,6,6)" : "rgb(249,249,249)";
          trail.fillRect(0, 0, this.w, this.h);
          trail.globalCompositeOperation = "source-over";
        }
      }
      this.strokeParticles(trail, tones, ink);
      const glow = view.glow;
      if (glowAlpha !== this.glowAlpha) {
        this.glowAlpha = glowAlpha;
        glow.canvas.style.opacity = String(glowAlpha);
      }
      if (!ink) {
        glow.setTransform(1, 0, 0, 1, 0, 0);
        glow.globalCompositeOperation = "copy";
        glow.filter = "blur(2px)";
        glow.drawImage(trail.canvas, 0, 0, glow.canvas.width, glow.canvas.height);
        glow.filter = "none";
      }

      const overlay = view.overlay;
      overlay.setTransform(1, 0, 0, 1, 0, 0);
      overlay.clearRect(0, 0, overlay.canvas.width, overlay.canvas.height);
      overlay.setTransform(rs, 0, 0, rs, 0, 0);
      this.drawOverlay(overlay, ink);
      this.syncBackdrop(view.backdrop, ground.hex, ink);
    }
  }

  /** Renderer, frame rate and how far auto-quality has scaled things back. */
  stats(): FieldStats {
    return {
      renderer: this.view?.gl ? "gpu" : "basic",
      fps: Math.round(this.fpsEma),
      resolution: Math.round(this.quality * 100),
      detail: Math.round(this.detail * 100),
    };
  }

  /**
   * Paints the finished WebGL frame from the current trail: backdrop, trail, bloom and
   * vignette in one pass, then dust, flash, shockwaves and the front seam on top.
   */
  private composeGL(gl: GLTrail, ink: boolean) {
    const ground = GROUNDS[this.ground];
    const a = this.atmosphere(ink);
    const composite: Composite = {
      glow: this.glowAlpha,
      ink,
      ground: [ground.rgb[0] / 255, ground.rgb[1] / 255, ground.rgb[2] / 255, 1],
      buy: [a.buyRgb[0] / 255, a.buyRgb[1] / 255, a.buyRgb[2] / 255, Number(a.buyA)],
      sell: [a.sellRgb[0] / 255, a.sellRgb[1] / 255, a.sellRgb[2] / 255, Number(a.sellA)],
      cy: a.cy,
      reach: a.reach,
      fx: a.fx,
      seam: ink ? 0 : 0.035,
      // Same falloff as .field-vignette in styles.css.
      vignetteFrom: ink ? 0.55 : 0.4,
      vignette: ink ? [60 / 255, 46 / 255, 28 / 255, 0.14] : [0, 0, 0, 0.55],
    };
    gl.present(composite, `${this.ground}|${a.key}`);
    const quads = this.packShapes(ink);
    gl.shapes(this.shapes, quads, this.packRings(ink, quads), !ink);

    // draw() uploaded the seam with the streaks, in the slot just past the last lane.
    const seam = (this.laneStart[5] + this.laneCount[5]) * 4;
    const lead = this.bias >= 0;
    const rgb = ink ? (lead ? [6, 110, 72] : [150, 34, 20]) : lead ? [61, 222, 180] : [240, 96, 64];
    const tone = (alpha: number): Rgba => [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, alpha];
    if (!ink) {
      gl.strokes(seam / 4, 1, tone(0.08), 18, true, true);
      gl.strokes(seam / 4, 1, tone(0.2), 6, true, true);
    }
    gl.strokes(seam / 4, 1, tone(ink ? 0.7 : 0.9), 1.5, false, true);
  }

  /** Writes dust and the flash as disc and glow instances; returns how many. */
  private packShapes(ink: boolean) {
    let n = 0;
    const push = (x: number, y: number, r: number, w: number, rgb: readonly number[], alpha: number) => {
      n += this.writeShape(n, x, y, r, w, rgb, alpha);
    };

    const fx = this.front * this.w;
    const m = this.motes;
    for (let i = 0; i < m.count; i++) {
      const side = m.x[i] < fx ? 0 : 1;
      const tw = 0.5 + 0.5 * Math.sin(this.t * (0.8 + m.phase[i] * 1.6) + m.phase[i] * 40);
      const bright = tw > 0.62;
      // Same tones as drawMotes; a disc of radius 0.56·s covers about the area of an s-square.
      const rgb = ink
        ? side === 0
          ? [6, 110, 72]
          : [150, 34, 20]
        : side === 0
          ? bright
            ? [170, 255, 225]
            : [90, 220, 175]
          : bright
            ? [255, 200, 175]
            : [240, 96, 70];
      const alpha = ink ? (bright ? 0.5 : 0.22) : bright ? 0.75 : 0.28;
      push(m.x[i], m.y[i], m.size[i] * (bright ? 1.25 : 1) * 0.56, 0, rgb, alpha);
    }

    if (this.flash.a > 0.02) {
      const { x, y, a, side } = this.flash;
      const rgb = ink ? (side === 0 ? [10, 130, 90] : [190, 50, 30]) : side === 0 ? [40, 230, 160] : [255, 70, 40];
      push(x, y, 90 + (1 - a) * 380, SHAPE_GLOW, rgb, a * (ink ? 0.16 : 0.42));
    }

    return n;
  }

  /** Appends the shockwave rings after the `from` shapes already written; returns how many. */
  private packRings(ink: boolean, from: number) {
    let n = 0;
    for (const ripple of this.ripples) {
      const a = clamp(ripple.a, 0, 1);
      const rgb = ink
        ? ripple.side === 0
          ? [8, 110, 72]
          : [160, 36, 20]
        : ripple.side === 0
          ? [61, 222, 180]
          : [240, 96, 64];
      if (!ink) n += this.writeShape(from + n, ripple.x, ripple.y, ripple.r, 10 + (1 - a) * 18, rgb, a * 0.12);
      n += this.writeShape(from + n, ripple.x, ripple.y, ripple.r, 1 + a * 1.6, rgb, a * (ink ? 0.45 : 0.6));
    }
    return n;
  }

  /** Writes one shape instance at `index`; returns 1, or 0 when the buffer is full. */
  private writeShape(index: number, x: number, y: number, r: number, w: number, rgb: readonly number[], alpha: number) {
    if (index >= SHAPE_CAPACITY) return 0;
    const out = this.shapes;
    const o = index * SHAPE_STRIDE;
    out[o] = x;
    out[o + 1] = y;
    out[o + 2] = r;
    out[o + 3] = w;
    out[o + 4] = (rgb[0] / 255) * alpha;
    out[o + 5] = (rgb[1] / 255) * alpha;
    out[o + 6] = (rgb[2] / 255) * alpha;
    out[o + 7] = alpha;
    return 1;
  }

  /**
   * Lowers the render resolution while frames run long and raises it again once they
   * recover, so a slow GPU trades a little sharpness for a steady frame rate.
   */
  private adaptQuality() {
    // Real elapsed time: the caller clamps dt, which would hide how slow a slow frame was.
    const now = typeof performance === "undefined" ? 0 : performance.now();
    const dt = this.lastNow ? Math.min(0.25, (now - this.lastNow) / 1000) : 1 / 60;
    this.lastNow = now;
    if (dt > 0) this.fpsEma += (1 / dt - this.fpsEma) * 0.05;
    if (this.settle > 0) {
      this.settle -= dt;
      return;
    }
    this.frameEma += (dt - this.frameEma) * 0.08;
    if (this.frameEma > 1 / 46) {
      this.slowFor += dt;
      this.fastFor = 0;
    } else if (this.frameEma < 1 / 57) {
      this.fastFor += dt;
      this.slowFor = 0;
    } else {
      this.slowFor = 0;
      this.fastFor = 0;
    }
    // Resolution goes first; once it is as low as looks acceptable, thin out the particles.
    // Recovery runs the other way round: particles back first, then sharpness.
    const gpu = !!this.view?.gl;
    const floor = this.dpr >= 1.5 ? (gpu ? 0.6 : 0.5) : gpu ? 0.75 : 0.6;
    let quality = this.quality;
    let detail = this.detail;
    if (this.slowFor > 1.2) {
      if (quality > floor) quality = Math.max(floor, quality * 0.85);
      else if (detail > 0.45) detail = Math.max(0.45, detail * 0.85);
    } else if (this.fastFor > 6) {
      if (detail < 1) detail = Math.min(1, detail * 1.15);
      else if (quality < 1) quality = Math.min(1, quality * 1.12);
    }
    if (quality !== this.quality || detail !== this.detail) {
      if (quality !== this.quality) this.layersDirty = true;
      this.quality = quality;
      this.detail = detail;
      this.slowFor = 0;
      this.fastFor = 0;
      this.settle = 0.75;
    }
  }

  /** Buckets every visible streak by lane into one contiguous buffer: x0, y0, x1, y1. */
  private packSegments() {
    const { px, py, ox, oy, life, side, spark, tier, live, laneStart, laneCount, segs } = this;
    laneCount.fill(0);
    const maxSeg = 260 * 260;
    for (let k = 0; k < this.liveCount; k++) {
      const i = live[k];
      const dx = px[i] - ox[i];
      const dy = py[i] - oy[i];
      const seg = dx * dx + dy * dy;
      if (seg < 0.04 || seg > maxSeg) {
        tier[i] = 255;
        continue;
      }
      const l = life[i];
      const t = spark[i] || (seg > 225 && l > 0.5) ? 2 : l > 0.42 ? 1 : 0;
      const lane = side[i] * 3 + t;
      tier[i] = lane;
      laneCount[lane]++;
    }
    let at = 0;
    for (let j = 0; j < 6; j++) {
      laneStart[j] = at;
      at += laneCount[j];
    }
    const cursor = this.laneCursor;
    cursor.set(laneStart);
    for (let k = 0; k < this.liveCount; k++) {
      const i = live[k];
      const lane = tier[i];
      if (lane === 255) continue;
      const dx = px[i] - ox[i];
      const dy = py[i] - oy[i];
      const o = cursor[lane]++ * 4;
      segs[o] = px[i] - dx * 6.4;
      segs[o + 1] = py[i] - dy * 6.4;
      segs[o + 2] = px[i];
      segs[o + 3] = py[i];
    }
  }

  /** Flattens the layers into one canvas, as the screen shows them, for saving. */
  snapshot(settings: FieldSettings) {
    const view = this.view;
    if (!view || typeof document === "undefined") return null;
    const ground = GROUNDS[settings.ground];
    const ink = !ground.additive;
    const out = document.createElement("canvas");
    out.width = view.trailCanvas.width;
    out.height = view.trailCanvas.height;
    const ctx = out.getContext("2d");
    if (!ctx) return null;
    if (view.gl) {
      // A WebGL canvas is only readable in the task that drew it, so draw it again here.
      this.composeGL(view.gl, this.lastInk);
      ctx.drawImage(view.trailCanvas, 0, 0);
      return out;
    }
    if (!view.overlay) return null;
    const rs = this.renderScale;
    ctx.setTransform(rs, 0, 0, rs, 0, 0);
    ctx.fillStyle = ground.hex;
    ctx.fillRect(0, 0, this.w, this.h);
    this.drawAtmosphere(ctx, ink);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = ink ? "multiply" : "screen";
    ctx.drawImage(view.trailCanvas, 0, 0);
    if (!ink && view.glow && this.glowAlpha > 0) {
      ctx.globalAlpha = this.glowAlpha;
      ctx.drawImage(view.glow.canvas, 0, 0, out.width, out.height);
      ctx.globalAlpha = 1;
    }
    ctx.globalCompositeOperation = ink ? "source-over" : "screen";
    ctx.drawImage(view.overlay.canvas, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.setTransform(rs, 0, 0, rs, 0, 0);
    this.drawVignette(ctx, ink);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return out;
  }

  private drawOverlay(ctx: CanvasRenderingContext2D, ink: boolean) {
    this.drawMotes(ctx, ink);
    this.drawFlash(ctx, ink);
    this.drawRipples(ctx, ink);
    this.drawSeam(ctx, ink);
    ctx.globalCompositeOperation = "source-over";
  }

  private strokeParticles(ctx: CanvasRenderingContext2D, tones: Lane[], ink: boolean) {
    // Round caps cost Canvas2D a lot of tessellation; on streaks this long they are invisible.
    ctx.lineCap = "butt";
    ctx.lineJoin = "round";
    ctx.globalCompositeOperation = "source-over";
    for (let i = 0; i < 6; i++) this.strokeLane(ctx, i, tones[i]);
    if (ink) return;
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < 6; i++) {
      const core = tones[i].core;
      if (core) this.strokeLane(ctx, i, core);
    }
    ctx.globalCompositeOperation = "source-over";
  }

  private atmosphere(ink: boolean) {
    const share = clamp(0.5 + this.pressure * 0.5, 0, 1);
    const buyRgb = ink ? [18, 140, 100] : [31, 191, 138];
    const sellRgb = ink ? [170, 46, 24] : [226, 70, 44];
    const base = ink ? 0.07 : 0.13;
    return {
      fx: this.front * this.w,
      cy: this.h * 0.55,
      reach: Math.max(this.w, this.h) * 0.75,
      buyRgb,
      sellRgb,
      buy: buyRgb.join(","),
      sell: sellRgb.join(","),
      buyA: (base * (0.55 + share * 0.9)).toFixed(3),
      sellA: (base * (0.55 + (1 - share) * 0.9)).toFixed(3),
      key: `${Math.round(share * 40)}|${Math.round(this.front * 80)}`,
    };
  }

  /** Soft side glows as a CSS background, rewritten only when the balance visibly moves. */
  private syncBackdrop(el: HTMLElement, hex: string, ink: boolean) {
    const a = this.atmosphere(ink);
    const key = `${this.w}x${this.h}|${hex}|${a.key}`;
    if (key === this.backKey) return;
    this.backKey = key;
    const r = Math.round(a.reach);
    const cy = Math.round(a.cy);
    const layers = [
      `radial-gradient(circle ${r}px at 0px ${cy}px, rgba(${a.buy},${a.buyA}), rgba(${a.buy},0))`,
      `radial-gradient(circle ${r}px at ${Math.round(this.w)}px ${cy}px, rgba(${a.sell},${a.sellA}), rgba(${a.sell},0))`,
    ];
    if (!ink) {
      const fx = Math.round(a.fx);
      layers.unshift(
        `linear-gradient(90deg, transparent ${fx - 160}px, rgba(255,240,225,0.035) ${fx}px, transparent ${fx + 160}px)`,
      );
    }
    el.style.background = `${layers.join(", ")}, ${hex}`;
  }

  private drawAtmosphere(ctx: CanvasRenderingContext2D, ink: boolean) {
    const a = this.atmosphere(ink);
    const buy = ctx.createRadialGradient(0, a.cy, 0, 0, a.cy, a.reach);
    buy.addColorStop(0, `rgba(${a.buy},${a.buyA})`);
    buy.addColorStop(1, `rgba(${a.buy},0)`);
    ctx.fillStyle = buy;
    ctx.fillRect(0, 0, this.w, this.h);
    const sell = ctx.createRadialGradient(this.w, a.cy, 0, this.w, a.cy, a.reach);
    sell.addColorStop(0, `rgba(${a.sell},${a.sellA})`);
    sell.addColorStop(1, `rgba(${a.sell},0)`);
    ctx.fillStyle = sell;
    ctx.fillRect(0, 0, this.w, this.h);
    if (ink) return;
    const seam = ctx.createLinearGradient(a.fx - 160, 0, a.fx + 160, 0);
    seam.addColorStop(0, "rgba(255,240,225,0)");
    seam.addColorStop(0.5, "rgba(255,240,225,0.035)");
    seam.addColorStop(1, "rgba(255,240,225,0)");
    ctx.fillStyle = seam;
    ctx.fillRect(a.fx - 160, 0, 320, this.h);
  }

  private drawMotes(ctx: CanvasRenderingContext2D, ink: boolean) {
    const fx = this.front * this.w;
    const m = this.motes;
    ctx.globalCompositeOperation = ink ? "source-over" : "lighter";
    for (let side = 0; side < 2; side++) {
      for (let pass = 0; pass < 2; pass++) {
        ctx.beginPath();
        for (let i = 0; i < m.count; i++) {
          const x = m.x[i];
          if ((x < fx ? 0 : 1) !== side) continue;
          const tw = 0.5 + 0.5 * Math.sin(this.t * (0.8 + m.phase[i] * 1.6) + m.phase[i] * 40);
          if ((tw > 0.62 ? 1 : 0) !== pass) continue;
          const s = m.size[i] * (pass ? 1.25 : 1);
          ctx.rect(x - s / 2, m.y[i] - s / 2, s, s);
        }
        ctx.fillStyle = ink
          ? side === 0
            ? pass
              ? "rgba(6,110,72,0.5)"
              : "rgba(6,110,72,0.22)"
            : pass
              ? "rgba(150,34,20,0.5)"
              : "rgba(150,34,20,0.22)"
          : side === 0
            ? pass
              ? "rgba(170,255,225,0.75)"
              : "rgba(90,220,175,0.28)"
            : pass
              ? "rgba(255,200,175,0.75)"
              : "rgba(240,96,70,0.28)";
        ctx.fill();
      }
    }
    ctx.globalCompositeOperation = "source-over";
  }

  private drawFlash(ctx: CanvasRenderingContext2D, ink: boolean) {
    if (this.flash.a <= 0.02) return;
    const { x, y, a, side } = this.flash;
    const radius = 90 + (1 - a) * 380;
    const glow = ctx.createRadialGradient(x, y, 0, x, y, radius);
    const rgb = ink ? (side === 0 ? "10,130,90" : "190,50,30") : side === 0 ? "40,230,160" : "255,70,40";
    const peak = a * (ink ? 0.16 : 0.42);
    glow.addColorStop(0, `rgba(${rgb},${peak.toFixed(3)})`);
    glow.addColorStop(0.35, `rgba(${rgb},${(peak * 0.35).toFixed(3)})`);
    glow.addColorStop(1, `rgba(${rgb},0)`);
    ctx.globalCompositeOperation = ink ? "source-over" : "lighter";
    ctx.fillStyle = glow;
    ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    ctx.globalCompositeOperation = "source-over";
  }

  private drawRipples(ctx: CanvasRenderingContext2D, ink: boolean) {
    if (!this.ripples.length) return;
    ctx.globalCompositeOperation = ink ? "source-over" : "lighter";
    for (const ripple of this.ripples) {
      const a = clamp(ripple.a, 0, 1);
      const rgb = ink ? (ripple.side === 0 ? "8,110,72" : "160,36,20") : ripple.side === 0 ? "61,222,180" : "240,96,64";
      ctx.beginPath();
      ctx.arc(ripple.x, ripple.y, ripple.r, 0, Math.PI * 2);
      if (!ink) {
        ctx.strokeStyle = `rgba(${rgb},${(a * 0.12).toFixed(3)})`;
        ctx.lineWidth = 10 + (1 - a) * 18;
        ctx.stroke();
      }
      ctx.strokeStyle = `rgba(${rgb},${(a * (ink ? 0.45 : 0.6)).toFixed(3)})`;
      ctx.lineWidth = 1 + a * 1.6;
      ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  private drawSeam(ctx: CanvasRenderingContext2D, ink: boolean) {
    const fx = this.front * this.w;
    const top = this.h * 0.14;
    const bottom = Math.max(this.h * 0.24, this.band - 28);
    const lead = this.bias >= 0;
    const rgb = ink ? (lead ? "6,110,72" : "150,34,20") : lead ? "61,222,180" : "240,96,64";
    const fadeLine = (alpha: number) => {
      const g = ctx.createLinearGradient(0, top, 0, bottom);
      g.addColorStop(0, `rgba(${rgb},0)`);
      g.addColorStop(0.18, `rgba(${rgb},${alpha})`);
      g.addColorStop(0.82, `rgba(${rgb},${alpha})`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      return g;
    };
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(fx, top);
    ctx.lineTo(fx, bottom);
    if (!ink) {
      ctx.globalCompositeOperation = "lighter";
      ctx.strokeStyle = fadeLine(0.08);
      ctx.lineWidth = 18;
      ctx.stroke();
      ctx.strokeStyle = fadeLine(0.2);
      ctx.lineWidth = 6;
      ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = fadeLine(ink ? 0.7 : 0.9);
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  /** Matches the CSS vignette over the live view. */
  private drawVignette(ctx: CanvasRenderingContext2D, ink: boolean) {
    const cx = this.w / 2;
    const cy = this.h / 2;
    const r = Math.hypot(cx, cy);
    const v = ctx.createRadialGradient(cx, cy, r * (ink ? 0.55 : 0.4), cx, cy, r);
    v.addColorStop(0, "rgba(0,0,0,0)");
    v.addColorStop(1, ink ? "rgba(60,46,28,0.14)" : "rgba(0,0,0,0.55)");
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, this.w, this.h);
  }

  private detonate(side: 0 | 1, power: number) {
    const mag = clamp(power, 0.15, 1);
    const dir = side === 0 ? 1 : -1;
    const fx = this.front * this.w;
    const x = clamp(fx - dir * (36 + Math.random() * this.w * 0.12), 24, this.w - 24);
    const y = this.h * (0.26 + Math.random() * 0.5);
    const n = Math.round((this.mobile ? 16 : 34) * (0.4 + mag));
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2;
      const sp = 220 + mag * 980 * Math.random();
      this.birth(side, mag > 0.62, {
        x,
        y,
        vx: Math.cos(ang) * sp + dir * (180 + mag * 420),
        vy: Math.sin(ang) * sp,
      });
    }
    const rings = 1 + Math.round(mag * 2);
    for (let i = 0; i < rings; i++) this.ripples.push({ x, y, r: 10 + i * 22, a: 0.95 - i * 0.18, side });
    if (this.ripples.length > 24) this.ripples.splice(0, this.ripples.length - 24);
    this.flash = { side, a: Math.max(this.flash.a, 0.28 + mag * 0.55), x, y };
    const kick = 220 + mag * 780;
    for (let k = 0; k < this.liveCount; k++) {
      const i = this.live[k];
      if (this.side[i] !== side) continue;
      if (Math.abs(this.px[i] - x) < 280 && Math.abs(this.py[i] - y) < 280) this.vx[i] += dir * kick * 0.45;
    }
  }

  private spawnJob(job: Job, intensity: number, budget: number) {
    const weight = Math.sqrt(job.notional / 500);
    const want = clamp(Math.round((4 + weight * 5.5) * intensity), 3, 72);
    const n = Math.min(want, budget);
    for (let i = 0; i < n; i++) this.birth(job.side, job.notional >= 25_000);
    if (want > n) this.queue.unshift({ side: job.side, notional: job.notional * ((want - n) / want) });
    return n;
  }

  private birth(side: 0 | 1, spark: boolean, at?: { x: number; y: number; vx: number; vy: number }) {
    if (this.freeCount === 0) return;
    const i = this.free[--this.freeCount];
    this.live[this.liveCount++] = i;
    const dir = side === 0 ? 1 : -1;
    const top = this.h * 0.2;
    const span = Math.max(80, this.band - top - 12);
    const y = at ? at.y : top + Math.random() * span;
    const x = at ? at.x : side === 0 ? Math.random() * this.w * 0.2 : this.w * (0.8 + Math.random() * 0.2);
    this.px[i] = x;
    this.py[i] = y;
    this.vx[i] = at ? at.vx : dir * (480 + Math.random() * 720);
    this.vy[i] = at ? at.vy : (Math.random() - 0.5) * 220;
    this.ox[i] = x - (at ? at.vx * 0.016 : dir * 18);
    this.oy[i] = y - (at ? at.vy * 0.016 : 0);
    this.spark[i] = spark ? 1 : 0;
    this.side[i] = side;
    this.life[i] = 1;
  }

  /** Frees the particle at position `k` of the live list by swapping in the last one. */
  private kill(k: number) {
    const i = this.live[k];
    this.live[k] = this.live[--this.liveCount];
    this.free[this.freeCount++] = i;
  }

  private strokeLane(ctx: CanvasRenderingContext2D, lane: number, style: Stroke) {
    const count = this.laneCount[lane];
    if (count === 0) return;
    const segs = this.segs;
    const end = (this.laneStart[lane] + count) * 4;
    ctx.beginPath();
    for (let j = this.laneStart[lane] * 4; j < end; j += 4) {
      ctx.moveTo(segs[j], segs[j + 1]);
      ctx.lineTo(segs[j + 2], segs[j + 3]);
    }
    ctx.strokeStyle = style.css;
    ctx.lineWidth = style.width;
    ctx.stroke();
  }
}

function num(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function isGround(value: unknown): value is GroundId {
  return value === "ink" || value === "abyss" || value === "coal" || value === "paper";
}

/**
 * Curl of a smoothstep value-noise field, written into `out` to avoid allocating.
 * The gradient is analytic, so it costs four lattice hashes instead of sixteen for
 * central differences.
 */
function curlInto(x: number, y: number, out: { x: number; y: number }) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const dux = 6 * fx * (1 - fx);
  const duy = 6 * fy * (1 - fy);
  const a = hash2(x0, y0);
  const b = hash2(x0 + 1, y0);
  const c = hash2(x0, y0 + 1);
  const d = hash2(x0 + 1, y0 + 1);
  const k = a - b - c + d;
  out.x = duy * (c - a + k * ux);
  out.y = -dux * (b - a + k * uy);
  return out;
}

function hash2(ix: number, iy: number) {
  let n = Math.imul(ix, 374761393) + Math.imul(iy, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}
