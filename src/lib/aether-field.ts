import type { Print, Side } from "@/lib/btc-tape";

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

type Particle = {
  x: number;
  y: number;
  px: number;
  py: number;
  vx: number;
  vy: number;
  phase: number;
  spark: boolean;
  side: 0 | 1;
  life: number;
  alive: boolean;
};

type Ripple = { x: number; y: number; r: number; a: number; side: 0 | 1 };

type Job = { side: 0 | 1; notional: number };

type Lane = { color: string; width: number; core?: { color: string; width: number } };

/** Stroke styles per lane, indexed side * 3 + tier (0 fading, 1 body, 2 hot). */
const LIGHT_LANES: Lane[] = [
  { color: "rgba(8,120,86,0.5)", width: 1.3 },
  { color: "rgba(12,170,116,0.7)", width: 1.7 },
  { color: "rgba(30,220,156,0.88)", width: 2.5, core: { color: "rgba(200,255,236,0.42)", width: 1 } },
  { color: "rgba(130,22,18,0.55)", width: 1.3 },
  { color: "rgba(200,36,28,0.74)", width: 1.7 },
  { color: "rgba(246,66,40,0.9)", width: 2.5, core: { color: "rgba(255,214,190,0.42)", width: 1 } },
];

const INK_LANES: Lane[] = [
  { color: "rgba(40,140,104,0.35)", width: 1.2 },
  { color: "rgba(6,118,74,0.78)", width: 1.8 },
  { color: "rgba(3,84,52,0.95)", width: 2.6 },
  { color: "rgba(196,70,52,0.38)", width: 1.2 },
  { color: "rgba(168,28,18,0.8)", width: 1.8 },
  { color: "rgba(116,14,8,0.95)", width: 2.6 },
];

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

type View = {
  backdrop: HTMLElement;
  trail: CanvasRenderingContext2D;
  glow: CanvasRenderingContext2D;
  overlay: CanvasRenderingContext2D;
};

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
  particles: Particle[] = [];
  ripples: Ripple[] = [];
  private ground: GroundId = "ink";
  private lanes: number[][] = [[], [], [], [], [], []];
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
    if (this.particles.length && this.w > 1) {
      for (const p of this.particles) {
        p.x *= sx;
        p.y *= sy;
        p.px *= sx;
        p.py *= sy;
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
    for (const p of this.particles) p.alive = false;
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
      budget -= this.spawnJob(job, settings.intensity, budget);
    }

    if (!this.reduce) {
      const tilt = Math.abs(this.pressure);
      const pour = Math.round((this.mobile ? 4 : 7) * (0.45 + tilt * 2.1));
      const buyShare = clamp(0.5 + this.pressure * 0.5, 0.05, 0.95);
      for (let i = 0; i < pour; i++) this.birth(Math.random() < buyShare ? 0 : 1, false);
    }

    const cap = Math.round((this.mobile ? 1600 : 2800) * (0.7 + settings.intensity * 0.35));
    let alive = 0;
    for (const p of this.particles) if (p.alive) alive++;
    this.crowd += (clamp(alive / cap, 0, 1) - this.crowd) * Math.min(1, dt * 2);
    if (alive > cap) {
      let extra = alive - cap;
      for (const p of this.particles) {
        if (!p.alive || extra <= 0) continue;
        if (p.life < 0.45) {
          p.alive = false;
          extra--;
        }
      }
    }

    const fx = this.front * this.w;
    const scale = 0.0031;
    const drift = this.t * 0.16;
    for (const p of this.particles) {
      if (!p.alive) continue;
      const dir = p.side === 0 ? 1 : -1;
      const age = 1 - p.life;
      const band = 96 + clash * 46;
      const dist = p.x - fx;
      const shear = Math.exp(-(dist * dist) / (band * band));
      const wave = p.y * 0.0105 + this.t * (0.85 + clash * 0.2);
      const roll = Math.sin(wave) * shear * (560 + clash * 300);
      const nx = p.x * scale;
      const ny = p.y * scale + drift + p.side * 3.5;
      const broad = curl2(nx, ny);
      const fine = curl2(nx * 2.8 + 17, ny * 2.8);
      const turb = (this.reduce ? 36 : 70 + age * 520) * (0.6 + clash * 0.22);
      let dvx = dir * (220 + clash * 60) * (1 - shear * 0.78);
      dvx += (broad.x * 0.74 + fine.x * 0.26) * turb;
      dvx += -Math.cos(wave) * Math.sign(dist || dir) * shear * 240;
      const dvy = roll * dir + (broad.y * 0.74 + fine.y * 0.26) * turb;
      const invaded = dir === 1 ? dist > 36 : dist < -36;
      p.life -= dt * (invaded ? 0.2 : 0.038);
      const steer = Math.min(1, dt * (3.2 + age * 7));
      p.vx += (dvx - p.vx) * steer;
      p.vy += (dvy - p.vy) * steer;
      p.vx *= 0.996;
      p.vy *= 0.996;
      const sp = Math.hypot(p.vx, p.vy);
      const max = this.reduce ? 340 : 1500 + clash * 280;
      if (sp > max) {
        p.vx = (p.vx / sp) * max;
        p.vy = (p.vy / sp) * max;
      }
      p.px = p.x;
      p.py = p.y;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.life <= 0 || p.x < -80 || p.x > this.w + 80 || p.y < -80 || p.y > this.h + 80) p.alive = false;
    }

    const m = this.motes;
    const moteDrift = this.reduce ? 4 : 14;
    for (let i = 0; i < m.count; i++) {
      const flow = curl2(m.x[i] * 0.0022 + 40, m.y[i] * 0.0022 + this.t * 0.05);
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
    const trail = layers.trail.getContext("2d", { alpha: false });
    const glow = layers.glow.getContext("2d");
    const overlay = layers.overlay.getContext("2d");
    if (!trail || !glow || !overlay) return false;
    this.view = { backdrop: layers.backdrop, trail, glow, overlay };
    this.needsClear = true;
    this.backKey = "";
    this.glowAlpha = -1;
    return true;
  }

  /** Sizes every layer to the field; the glow layer runs at a quarter of CSS resolution. */
  fitLayers() {
    const view = this.view;
    if (!view) return;
    const dw = Math.round(this.w * this.dpr);
    const dh = Math.round(this.h * this.dpr);
    for (const ctx of [view.trail, view.overlay]) {
      if (ctx.canvas.width !== dw || ctx.canvas.height !== dh) {
        ctx.canvas.width = dw;
        ctx.canvas.height = dh;
        this.needsClear = true;
      }
    }
    const gw = Math.max(1, Math.round(this.w / 4));
    const gh = Math.max(1, Math.round(this.h / 4));
    if (view.glow.canvas.width !== gw || view.glow.canvas.height !== gh) {
      view.glow.canvas.width = gw;
      view.glow.canvas.height = gh;
    }
    this.backKey = "";
  }

  draw(settings: FieldSettings) {
    const view = this.view;
    if (!view) return;
    const ground = GROUNDS[settings.ground];
    const ink = !ground.additive;
    const { trail, glow, overlay } = view;
    const fresh = this.needsClear || this.ground !== settings.ground;
    this.needsClear = false;
    this.ground = settings.ground;
    this.frame++;

    // Trails: black for light-emitting grounds, white for ink on paper.
    trail.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    trail.globalCompositeOperation = "source-over";
    if (fresh) {
      trail.fillStyle = ink ? "#fff" : "#000";
      trail.fillRect(0, 0, this.w, this.h);
    } else {
      const perFrame = ink ? 0.11 - settings.trail * 0.065 : 0.05 - settings.trail * 0.034;
      const fade = 1 - Math.pow(1 - perFrame, this.frameDt * 60);
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
    this.strokeParticles(trail, ink);

    // Bloom flatters a sparse field but washes a crowded one out to white.
    const glowAlpha = ink ? 0 : Math.round((0.5 - this.crowd * 0.32) * 50) / 50;
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

    overlay.setTransform(1, 0, 0, 1, 0, 0);
    overlay.clearRect(0, 0, overlay.canvas.width, overlay.canvas.height);
    overlay.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawOverlay(overlay, ink);

    this.syncBackdrop(view.backdrop, ground.hex, ink);
  }

  /** Flattens the layers into one canvas, as the screen shows them, for saving. */
  snapshot(settings: FieldSettings) {
    const view = this.view;
    if (!view || typeof document === "undefined") return null;
    const ground = GROUNDS[settings.ground];
    const ink = !ground.additive;
    const out = document.createElement("canvas");
    out.width = view.trail.canvas.width;
    out.height = view.trail.canvas.height;
    const ctx = out.getContext("2d");
    if (!ctx) return null;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = ground.hex;
    ctx.fillRect(0, 0, this.w, this.h);
    this.drawAtmosphere(ctx, ink);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = ink ? "multiply" : "screen";
    ctx.drawImage(view.trail.canvas, 0, 0);
    if (!ink && this.glowAlpha > 0) {
      ctx.globalAlpha = this.glowAlpha;
      ctx.drawImage(view.glow.canvas, 0, 0, out.width, out.height);
      ctx.globalAlpha = 1;
    }
    ctx.globalCompositeOperation = ink ? "source-over" : "screen";
    ctx.drawImage(view.overlay.canvas, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
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

  private strokeParticles(ctx: CanvasRenderingContext2D, ink: boolean) {
    for (const lane of this.lanes) lane.length = 0;
    const maxSeg = 260 * 260;
    for (const p of this.particles) {
      if (!p.alive) continue;
      const dx = p.x - p.px;
      const dy = p.y - p.py;
      const seg = dx * dx + dy * dy;
      if (seg < 0.04 || seg > maxSeg) continue;
      const fast = seg > 15 * 15;
      const tier = p.spark || (fast && p.life > 0.5) ? 2 : p.life > 0.42 ? 1 : 0;
      this.lanes[p.side * 3 + tier].push(p.x - dx * 6.4, p.y - dy * 6.4, p.x, p.y);
    }
    const tones = ink ? INK_LANES : LIGHT_LANES;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.globalCompositeOperation = "source-over";
    for (let i = 0; i < 6; i++) this.strokeLane(ctx, this.lanes[i], tones[i].color, tones[i].width);
    if (ink) return;
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < 6; i++) {
      const core = tones[i].core;
      if (core) this.strokeLane(ctx, this.lanes[i], core.color, core.width);
    }
    ctx.globalCompositeOperation = "source-over";
  }

  private atmosphere(ink: boolean) {
    const share = clamp(0.5 + this.pressure * 0.5, 0, 1);
    const base = ink ? 0.07 : 0.13;
    return {
      fx: this.front * this.w,
      cy: this.h * 0.55,
      reach: Math.max(this.w, this.h) * 0.75,
      buy: ink ? "18,140,100" : "31,191,138",
      sell: ink ? "170,46,24" : "226,70,44",
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
    for (const p of this.particles) {
      if (!p.alive || p.side !== side) continue;
      if (Math.abs(p.x - x) < 280 && Math.abs(p.y - y) < 280) p.vx += dir * kick * 0.45;
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
    const p = this.take();
    const dir = side === 0 ? 1 : -1;
    const top = this.h * 0.2;
    const span = Math.max(80, this.band - top - 12);
    const y = at ? at.y : top + Math.random() * span;
    const x = at ? at.x : side === 0 ? Math.random() * this.w * 0.2 : this.w * (0.8 + Math.random() * 0.2);
    p.x = x;
    p.y = y;
    p.vx = at ? at.vx : dir * (480 + Math.random() * 720);
    p.vy = at ? at.vy : (Math.random() - 0.5) * 220;
    p.px = x - (at ? at.vx * 0.016 : dir * 18);
    p.py = y - (at ? at.vy * 0.016 : 0);
    p.phase = Math.random();
    p.spark = spark;
    p.side = side;
    p.life = 1;
    p.alive = true;
  }

  private take() {
    for (const p of this.particles) {
      if (!p.alive) return p;
    }
    const fresh: Particle = {
      x: 0,
      y: 0,
      px: 0,
      py: 0,
      vx: 0,
      vy: 0,
      phase: 0,
      spark: false,
      side: 0,
      life: 1,
      alive: false,
    };
    this.particles.push(fresh);
    return fresh;
  }

  private strokeLane(ctx: CanvasRenderingContext2D, list: number[], color: string, width: number) {
    if (list.length === 0) return;
    ctx.beginPath();
    for (let j = 0; j < list.length; j += 4) {
      ctx.moveTo(list[j], list[j + 1]);
      ctx.lineTo(list[j + 2], list[j + 3]);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
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

function curl2(x: number, y: number) {
  const e = 0.17;
  const n1 = valueNoise(x, y + e);
  const n2 = valueNoise(x, y - e);
  const n3 = valueNoise(x + e, y);
  const n4 = valueNoise(x - e, y);
  return { x: (n1 - n2) / (2 * e), y: (n4 - n3) / (2 * e) };
}

function valueNoise(x: number, y: number) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2(x0, y0);
  const b = hash2(x0 + 1, y0);
  const c = hash2(x0, y0 + 1);
  const d = hash2(x0 + 1, y0 + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

function hash2(ix: number, iy: number) {
  let n = Math.imul(ix, 374761393) + Math.imul(iy, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}
