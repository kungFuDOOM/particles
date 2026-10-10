import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Check, Download, RotateCcw, SlidersHorizontal, X } from "lucide-react";
import {
  AetherField,
  DEFAULT_SETTINGS,
  GROUNDS,
  type FieldSettings,
  type FieldStats,
  type GroundId,
  loadSettings,
  saveSettings,
} from "@/lib/aether-field";
import { startTape, type Side, type TapeState } from "@/lib/btc-tape";

const GROUND_IDS = Object.keys(GROUNDS) as GroundId[];

const EMPTY_TAPE: TapeState = {
  price: null,
  change: null,
  buy: 0,
  sell: 0,
  status: "connecting",
  lastSide: null,
};

export function AetherApp() {
  const backdropRef = useRef<HTMLDivElement>(null);
  const trailRef = useRef<HTMLCanvasElement>(null);
  const glowRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const fieldRef = useRef<AetherField | null>(null);
  const settingsRef = useRef<FieldSettings>(DEFAULT_SETTINGS);
  const lastImpulse = useRef(0);
  const [settings, setSettings] = useState<FieldSettings>(DEFAULT_SETTINGS);
  const [ready, setReady] = useState(false);
  const [saved, setSaved] = useState(false);
  const [stats, setStats] = useState<FieldStats | null>(null);
  const [open, setOpen] = useState(false);
  const [tape, setTape] = useState<TapeState>(EMPTY_TAPE);
  const [whale, setWhale] = useState<{ side: Side; notional: number; at: number } | null>(null);
  const [tick, setTick] = useState<{ dir: "up" | "down" | null; n: number }>({ dir: null, n: 0 });
  const lastPrice = useRef<number | null>(null);
  const savedTimer = useRef<number>(0);
  const whaleTimer = useRef<number>(0);

  settingsRef.current = settings;

  useEffect(() => {
    setSettings(loadSettings());
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    saveSettings(settings);
  }, [settings, ready]);

  useEffect(() => {
    const backdrop = backdropRef.current;
    const trail = trailRef.current;
    const glow = glowRef.current;
    const overlay = overlayRef.current;
    if (!backdrop || !trail || !glow || !overlay) return;
    const field = new AetherField();
    if (!field.attach({ backdrop, trail, glow, overlay })) return;
    fieldRef.current = field;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const syncReduced = () => {
      field.reduce = reduced.matches;
    };
    syncReduced();
    reduced.addEventListener("change", syncReduced);

    const fit = () => {
      const rect = trail.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, rect.width);
      const h = Math.max(1, rect.height);
      if (field.w !== w || field.h !== h || field.dpr !== dpr) field.resize(w, h, dpr);
      field.fitLayers();
      field.setBand(h - 16);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(trail);

    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(0.033, (now - last) / 1000);
      last = now;
      const current = settingsRef.current;
      field.step(dt, current);
      field.draw(current);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      reduced.removeEventListener("change", syncReduced);
      if (fieldRef.current === field) fieldRef.current = null;
    };
  }, []);

  useEffect(() => {
    return startTape({
      onPrint: (print) => {
        fieldRef.current?.ingest(print);
        if (lastImpulse.current > 0 && Math.abs(print.price - lastImpulse.current) >= 4) {
          const rising = print.price > lastImpulse.current;
          const strength = Math.min(1, Math.abs(print.price - lastImpulse.current) / 18);
          fieldRef.current?.impulse(rising ? "buy" : "sell", strength);
        }
        if (print.price > 0) lastImpulse.current = print.price;
      },
      onState: (state) => {
        const prev = lastPrice.current;
        if (state.price != null && prev != null && state.price !== prev) {
          const dir = state.price > prev ? "up" : "down";
          setTick((t) => ({ dir, n: t.n + 1 }));
        }
        lastPrice.current = state.price;
        setTape(state);
        fieldRef.current?.setFlow(state.buy, state.sell);
      },
      onWhale: (print) => {
        setWhale({ side: print.side, notional: print.notional, at: performance.now() });
        window.clearTimeout(whaleTimer.current);
        whaleTimer.current = window.setTimeout(() => setWhale(null), 3200);
      },
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // While the panel is open, show which renderer is running and what auto-quality is doing.
  useEffect(() => {
    if (!open) return;
    const read = () => setStats(fieldRef.current?.stats() ?? null);
    read();
    const timer = window.setInterval(read, 1000);
    return () => window.clearInterval(timer);
  }, [open]);

  useEffect(() => {
    return () => {
      window.clearTimeout(savedTimer.current);
      window.clearTimeout(whaleTimer.current);
    };
  }, []);

  const patch = (partial: Partial<FieldSettings>) => {
    setSettings((prev) => ({ ...prev, ...partial }));
  };

  const total = tape.buy + tape.sell;
  const buyShare = total < 1 ? 0.5 : tape.buy / total;
  const lead = leadLabel(tape.buy, tape.sell);
  const live = tape.status === "live";

  return (
    <main
      data-ground={settings.ground}
      className="relative h-dvh w-full overflow-hidden bg-bg text-fg select-none"
    >
      <div aria-hidden="true" className={`field ${GROUNDS[settings.ground].additive ? "field-light" : "field-ink"}`}>
        <div ref={backdropRef} className={`field-backdrop ground-${settings.ground}`} />
        <canvas ref={trailRef} className="field-trail" />
        <canvas ref={glowRef} className="field-glow" />
        <canvas ref={overlayRef} className="field-overlay" />
        <div className="field-vignette" />
      </div>

      <div className="scrim-top pointer-events-none absolute inset-x-0 top-0 z-10 h-44" aria-hidden="true" />
      <div className="scrim-bottom pointer-events-none absolute inset-x-0 bottom-0 z-10 h-32" aria-hidden="true" />

      <header className="pointer-events-none absolute inset-x-0 top-0 z-20 p-3 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="hud-read min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="font-display text-2xl leading-none sm:text-3xl">Particles</h1>
              <span className="rounded-full border border-border/80 px-1.5 py-0.5 text-[0.625rem] font-semibold tracking-[0.14em] text-muted uppercase">
                BTC-USD
              </span>
            </div>
            <p className="mt-1.5 font-display text-4xl leading-none tabular-nums sm:text-5xl">
              {tape.price == null ? (
                "—"
              ) : (
                <span key={tick.n} className={tick.dir ? `price-${tick.dir}` : undefined}>
                  {usd(tape.price)}
                </span>
              )}
            </p>
            <p className="mt-1.5 flex items-center gap-1.5 text-sm">
              <span className={tape.change != null && tape.change < 0 ? "text-sell" : "text-accent"}>
                {tape.change == null ? "Linking tape" : `${signedPct(tape.change)} 24h`}
              </span>
              <span className="text-muted" aria-hidden="true">
                ·
              </span>
              <span className={`live-dot ${live ? "is-live" : ""}`} aria-hidden="true" />
              <span className="text-muted">{live ? "Live" : "Connecting"}</span>
            </p>
          </div>
          <button
            type="button"
            data-controls
            className="glass pointer-events-auto inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full border border-border bg-surface/90 px-4 text-sm font-medium text-fg transition-colors hover:bg-surface"
            aria-expanded={open}
            aria-controls="field-controls"
            onClick={() => setOpen((value) => !value)}
          >
            {open ? <X className="size-4" aria-hidden="true" /> : <SlidersHorizontal className="size-4" aria-hidden="true" />}
            {open ? "Close" : "Controls"}
          </button>
        </div>

        <div className="mt-3 min-h-8" aria-live="polite">
          {whale ? (
            <p
              key={whale.at}
              className="toast glass inline-flex items-center gap-2 rounded-full border border-border bg-surface/90 px-3 py-1.5 text-sm"
            >
              <span className={`size-2 rounded-full ${whale.side === "buy" ? "bg-accent" : "bg-sell"}`} aria-hidden="true" />
              <span className="font-medium">Whale {whale.side}</span>
              <span className={`tabular-nums ${whale.side === "buy" ? "text-accent" : "text-sell"}`}>
                {compactUsd(whale.notional)}
              </span>
            </p>
          ) : null}
        </div>
      </header>

      <footer
        className={`dock pointer-events-none absolute inset-x-0 bottom-0 z-20 px-3 transition-opacity duration-300 sm:px-5 ${open ? "opacity-0" : "opacity-100"}`}
        aria-hidden={open}
      >
        <div className="hud-read mx-auto mb-1 w-full max-w-2xl sm:mb-3">
          <div className="flex items-end justify-between gap-3 text-xs font-medium tracking-[0.12em] uppercase">
            <span className="text-accent">
              Buys <span className="text-fg tabular-nums">{pct(buyShare, total)}</span>
            </span>
            <span className={lead === "Sells ahead" ? "text-sell" : lead === "Buys ahead" ? "text-accent" : "text-muted"}>
              {lead}
            </span>
            <span className="text-sell">
              <span className="text-fg tabular-nums">{pct(1 - buyShare, total)}</span> Sells
            </span>
          </div>
          <div
            className="meter mt-2 flex h-1.5 overflow-hidden rounded-full"
            role="meter"
            aria-label="Share of taker volume that is buying"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(buyShare * 100)}
          >
            <div className="meter-buy h-full" style={{ width: `${buyShare * 100}%` }} />
            <div className="meter-sell h-full flex-1" />
          </div>
          <div className="mt-1.5 flex justify-between gap-3 text-xs text-muted tabular-nums">
            <span>{total < 1 ? "—" : compactUsd(tape.buy)}</span>
            <span className="hidden sm:inline">Taker flow · last minute</span>
            <span>{total < 1 ? "—" : compactUsd(tape.sell)}</span>
          </div>
        </div>
      </footer>

      {open ? (
        <div className="dock pointer-events-none absolute inset-x-0 bottom-0 z-30 flex justify-center px-3 sm:px-6">
          <section
            id="field-controls"
            data-controls
            className="glass dock-panel pointer-events-auto mb-3 w-full max-w-xl rounded-2xl border border-border bg-surface/95 p-4 shadow-2xl sm:mb-5 sm:p-5"
            aria-label="Field controls"
          >
            <div className="grid gap-1">
              <Slider
                label="Intensity"
                min={0.5}
                max={2.2}
                step={0.1}
                value={settings.intensity}
                display={settings.intensity.toFixed(1)}
                onChange={(intensity) => patch({ intensity })}
              />
              <Slider
                label="Trail"
                min={0}
                max={1}
                step={0.01}
                value={settings.trail}
                display={trailLabel(settings.trail)}
                onChange={(trail) => patch({ trail })}
              />
              <Slider
                label="Clash"
                min={0.4}
                max={2.2}
                step={0.1}
                value={settings.clash}
                display={clashLabel(settings.clash)}
                onChange={(clash) => patch({ clash })}
              />
            </div>

            <div className="mt-3">
              <ChipRow label="Ground">
                {GROUND_IDS.map((id) => (
                  <Chip key={id} pressed={settings.ground === id} onClick={() => patch({ ground: id })}>
                    <span className={`swatch swatch-${id}`} aria-hidden="true" />
                    {GROUNDS[id].label}
                  </Chip>
                ))}
              </ChipRow>
            </div>

            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => fieldRef.current?.reset()}
                className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl border border-border bg-bg/60 px-3 text-sm font-medium text-fg transition-colors hover:bg-bg"
              >
                <RotateCcw className="size-4" aria-hidden="true" />
                Reset
              </button>
              <button
                type="button"
                onClick={() =>
                  download(fieldRef.current?.snapshot(settings) ?? null, settings, tape, () => {
                    setSaved(true);
                    window.clearTimeout(savedTimer.current);
                    savedTimer.current = window.setTimeout(() => setSaved(false), 1400);
                  })
                }
                className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-accent px-3 text-sm font-medium text-bg transition-[filter] hover:brightness-110"
                aria-live="polite"
              >
                {saved ? <Check className="size-4" aria-hidden="true" /> : <Download className="size-4" aria-hidden="true" />}
                {saved ? "Saved" : "Save image"}
              </button>
            </div>
            {stats ? <p className="mt-3 text-center text-xs text-muted tabular-nums">{statsLine(stats)}</p> : null}
          </section>
        </div>
      ) : null}
    </main>
  );
}

function download(out: HTMLCanvasElement | null, settings: FieldSettings, tape: TapeState, done: () => void) {
  if (!out) return;
  const ctx = out.getContext("2d");
  if (!ctx) return;
  stampCaption(ctx, out.width, out.height, settings, tape);
  out.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    link.href = url;
    link.download = `particles-btc-${stamp}.png`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    done();
  }, "image/png");
}

/** A small credit line so a saved frame still says what it is. */
function stampCaption(ctx: CanvasRenderingContext2D, width: number, height: number, settings: FieldSettings, tape: TapeState) {
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  const pad = 20 * scale;
  const ink = !GROUNDS[settings.ground].additive;
  const fg = ink ? "rgba(29,27,23,0.92)" : "rgba(236,234,228,0.92)";
  const muted = ink ? "rgba(29,27,23,0.6)" : "rgba(236,234,228,0.6)";
  const total = tape.buy + tape.sell;
  const left = tape.price == null ? "BTC-USD" : `BTC-USD ${usd(tape.price)}`;
  const when = new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  const right = total < 1 ? when : `Buys ${pct(tape.buy / total, total)} · Sells ${pct(tape.sell / total, total)} · ${when}`;
  ctx.save();
  ctx.textBaseline = "alphabetic";
  ctx.shadowColor = ink ? "rgba(243,239,230,0.9)" : "rgba(0,0,0,0.85)";
  ctx.shadowBlur = 10 * scale;
  ctx.font = `${26 * scale}px "Instrument Serif", Georgia, serif`;
  ctx.fillStyle = fg;
  ctx.textAlign = "left";
  ctx.fillText("Particles", pad, height - pad);
  const brand = ctx.measureText("Particles ").width;
  ctx.font = `500 ${13 * scale}px "Instrument Sans", system-ui, sans-serif`;
  ctx.fillStyle = muted;
  ctx.fillText(left, pad + brand, height - pad);
  ctx.textAlign = "right";
  ctx.fillText(right, width - pad, height - pad);
  ctx.restore();
}

function Slider({
  label,
  min,
  max,
  step,
  value,
  display,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  display: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex items-center gap-3">
      <span className="w-20 text-xs font-medium tracking-wide text-muted uppercase">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        aria-valuetext={display}
        className="min-w-0 flex-1"
        style={{ "--fill": `${((value - min) / (max - min)) * 100}%` } as CSSProperties}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="w-12 text-right text-sm tabular-nums text-fg">{display}</span>
    </label>
  );
}

function ChipRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">{label}</p>
      <div className="grid grid-cols-4 gap-2">{children}</div>
    </div>
  );
}

function Chip({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={
        pressed
          ? "inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-accent bg-accent/15 px-2 text-sm font-medium text-fg"
          : "inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-border px-2 text-sm text-muted transition-colors hover:text-fg"
      }
    >
      {children}
    </button>
  );
}

function statsLine(stats: FieldStats) {
  const parts = [stats.renderer === "gpu" ? "GPU renderer" : "Basic renderer", `${stats.fps} fps`];
  if (stats.resolution < 100) parts.push(`${stats.resolution}% resolution`);
  if (stats.detail < 100) parts.push(`${stats.detail}% particles`);
  if (stats.resolution >= 100 && stats.detail >= 100) parts.push("full quality");
  return parts.join(" · ");
}

function leadLabel(buy: number, sell: number) {
  const total = buy + sell;
  if (total < 1) return "Reading the tape";
  const tilt = (buy - sell) / total;
  if (tilt >= 0.08) return "Buys ahead";
  if (tilt <= -0.08) return "Sells ahead";
  return "Even fight";
}

function pct(share: number, total: number) {
  if (total < 1) return "—";
  return `${Math.round(share * 100)}%`;
}

function trailLabel(trail: number) {
  if (trail < 0.34) return "Short";
  if (trail < 0.67) return "Mid";
  return "Long";
}

function clashLabel(clash: number) {
  if (clash < 0.9) return "Soft";
  if (clash < 1.6) return "Hard";
  return "Fierce";
}

function usd(value: number) {
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function signedPct(fraction: number) {
  const pct = fraction * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

function compactUsd(value: number) {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `$${(value / 1_000).toFixed(0)}k`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}k`;
  return `$${Math.round(value)}`;
}
