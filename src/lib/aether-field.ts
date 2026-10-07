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
  private buyBody: number[] = [];
  private buyHot: number[] = [];
  private sellBody: number[] = [];
  private sellHot: number[] = [];
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
    this.needsClear = true;
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
    const clash = settings.clash * (this.reduce ? 0.5 : 1);
    this.bias += (this.biasTarget - this.bias) * Math.min(1, dt * 1.5);
    this.pressure += (this.pressureTarget - this.pressure) * Math.min(1, dt * 2.4);
    const drive = clamp(this.bias * 0.55 + this.pressure * 0.45, -1, 1);
    const target = 0.5 + drive * 0.4 * Math.min(clash, 1.8);
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
      let dvy = roll * dir + (broad.y * 0.74 + fine.y * 0.26) * turb;
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

    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const r = this.ripples[i];
      r.r += dt * (640 + r.r * 0.55);
      r.a -= dt * 0.85;
      if (r.a <= 0) this.ripples.splice(i, 1);
    }
  }

  draw(ctx: CanvasRenderingContext2D, settings: FieldSettings) {
    const ground = GROUNDS[settings.ground];
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    if (this.needsClear || this.ground !== settings.ground) {
      ctx.fillStyle = ground.hex;
      ctx.fillRect(0, 0, this.w, this.h);
      this.needsClear = false;
      this.ground = settings.ground;
    } else {
      const fade = ground.additive ? 0.042 - settings.trail * 0.024 : 0.11 - settings.trail * 0.05;
      const [r, g, b] = ground.rgb;
      ctx.fillStyle = `rgba(${r},${g},${b},${fade.toFixed(3)})`;
      ctx.fillRect(0, 0, this.w, this.h);
    }

    const wash = ctx.createLinearGradient(0, 0, this.w, 0);
    const front = clamp(this.front, 0.08, 0.92);
    wash.addColorStop(0, ground.additive ? "rgba(61,222,180,0.2)" : "rgba(18,110,86,0.1)");
    wash.addColorStop(front, "rgba(0,0,0,0)");
    wash.addColorStop(1, ground.additive ? "rgba(226,91,58,0.2)" : "rgba(150,48,28,0.1)");
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, this.w, this.h);

    if (this.flash.a > 0.02) {
      const radius = 80 + (1 - this.flash.a) * 420;
      const glow = ctx.createRadialGradient(this.flash.x, this.flash.y, 8, this.flash.x, this.flash.y, radius);
      const rgb = this.flash.side === 0 ? "0,214,140" : "232,42,32";
      glow.addColorStop(0, `rgba(${rgb},${(this.flash.a * 0.55).toFixed(3)})`);
      glow.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, this.w, this.h);
    }

    this.buyBody.length = 0;
    this.buyHot.length = 0;
    this.sellBody.length = 0;
    this.sellHot.length = 0;

    const maxSeg = 260 * 260;
    for (const p of this.particles) {
      if (!p.alive) continue;
      const dx = p.x - p.px;
      const dy = p.y - p.py;
      const seg = dx * dx + dy * dy;
      if (seg < 0.04 || seg > maxSeg) continue;
      const dest = p.side === 0 ? (p.spark ? this.buyHot : this.buyBody) : p.spark ? this.sellHot : this.sellBody;
      dest.push(p.x - dx * 6.4, p.y - dy * 6.4, p.x, p.y);
    }

    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.globalCompositeOperation = "source-over";
    if (ground.additive) {
      this.strokeLane(ctx, this.buyBody, "rgba(0,196,118,0.84)", 2.7);
      this.strokeLane(ctx, this.sellBody, "rgba(214,30,26,0.86)", 2.7);
      this.strokeLane(ctx, this.buyHot, "rgba(0,230,156,0.96)", 4.8);
      this.strokeLane(ctx, this.sellHot, "rgba(255,64,36,0.96)", 4.8);
      ctx.globalCompositeOperation = "lighter";
      this.strokeLane(ctx, this.buyBody, "rgba(110,255,205,0.5)", 1.05);
      this.strokeLane(ctx, this.sellBody, "rgba(255,130,100,0.5)", 1.05);
      this.strokeLane(ctx, this.buyHot, "rgba(220,255,242,0.75)", 1.7);
      this.strokeLane(ctx, this.sellHot, "rgba(255,200,170,0.75)", 1.7);
    } else {
      this.strokeLane(ctx, this.buyBody, "rgba(6,118,74,0.9)", 2.6);
      this.strokeLane(ctx, this.buyHot, "rgba(4,92,58,1)", 4.4);
      this.strokeLane(ctx, this.sellBody, "rgba(168,28,18,0.92)", 2.6);
      this.strokeLane(ctx, this.sellHot, "rgba(120,16,10,1)", 4.4);
    }

    const fx = this.front * this.w;
    const lead = this.bias >= 0;
    ctx.globalCompositeOperation = "source-over";
    ctx.beginPath();
    ctx.moveTo(fx, this.h * 0.14);
    ctx.lineTo(fx, Math.max(this.h * 0.2, this.band - 28));
    ctx.strokeStyle = lead ? "rgba(61,222,180,0.75)" : "rgba(226,91,58,0.75)";
    ctx.lineWidth = 3.25;
    ctx.stroke();

    const labelY = Math.max(this.h * 0.2, this.band - 16);
    ctx.font = "600 12px Instrument Sans, sans-serif";
    ctx.textBaseline = "bottom";
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(61,222,180,0.9)";
    ctx.fillText("BUYS", 14, labelY);
    ctx.textAlign = "right";
    ctx.fillStyle = "rgba(226,91,58,0.9)";
    ctx.fillText("SELLS", this.w - 14, labelY);

    for (const ripple of this.ripples) {
      ctx.beginPath();
      ctx.arc(ripple.x, ripple.y, ripple.r, 0, Math.PI * 2);
      ctx.strokeStyle =
        ripple.side === 0
          ? `rgba(61,222,180,${ripple.a})`
          : `rgba(226,91,58,${ripple.a})`;
      ctx.lineWidth = 2.4 + ripple.a * 3;
      ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
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
