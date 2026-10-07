import { useEffect, useRef, useState, type ReactNode } from "react";
import { Download, RotateCcw, X } from "lucide-react";
import {
  AetherField,
  DEFAULT_SETTINGS,
  GROUNDS,
  type FieldSettings,
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
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fieldRef = useRef<AetherField | null>(null);
  const settingsRef = useRef<FieldSettings>(DEFAULT_SETTINGS);
  const lastImpulse = useRef(0);
  const [settings, setSettings] = useState<FieldSettings>(DEFAULT_SETTINGS);
  const [ready, setReady] = useState(false);
  const [saved, setSaved] = useState(false);
  const [open, setOpen] = useState(false);
  const [tape, setTape] = useState<TapeState>(EMPTY_TAPE);
  const [whale, setWhale] = useState<{ side: Side; notional: number } | null>(null);
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
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;
    const field = new AetherField();
    fieldRef.current = field;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const syncReduced = () => {
      field.reduce = reduced.matches;
    };
    syncReduced();
    reduced.addEventListener("change", syncReduced);

    const fit = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, rect.width);
      const h = Math.max(1, rect.height);
      const nextW = Math.round(w * dpr);
      const nextH = Math.round(h * dpr);
      if (canvas.width !== nextW || canvas.height !== nextH) {
        canvas.width = nextW;
        canvas.height = nextH;
      }
      if (field.w !== w || field.h !== h || field.dpr !== dpr) field.resize(w, h, dpr);
      field.setBand(h - 16);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(canvas);

    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(0.033, (now - last) / 1000);
      last = now;
      const current = settingsRef.current;
      field.step(dt, current);
      field.draw(ctx, current);
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
        setTape(state);
        fieldRef.current?.setFlow(state.buy, state.sell);
      },
      onWhale: (print) => {
        setWhale({ side: print.side, notional: print.notional });
        window.clearTimeout(whaleTimer.current);
        whaleTimer.current = window.setTimeout(() => setWhale(null), 2200);
      },
    });
  }, []);

  const patch = (partial: Partial<FieldSettings>) => {
    setSettings((prev) => ({ ...prev, ...partial }));
  };

  const ground = GROUNDS[settings.ground];

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-bg text-fg select-none">
      <canvas
        ref={canvasRef}
        className={`absolute inset-0 h-full w-full touch-none ground-${settings.ground}`}
        aria-hidden="true"
      />
      <div className={`pointer-events-none absolute inset-0 ${ground.additive ? "vignette-dark" : "vignette-light"}`} />

      <header className="pointer-events-none absolute inset-x-0 top-0 z-20 p-3 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="hud-read min-w-0">
            <div className="flex items-baseline gap-2">
              <h1 className="font-display text-2xl leading-none sm:text-3xl">Particles</h1>
              <span className="text-xs font-medium tracking-wide text-muted uppercase">BTC</span>
            </div>
            <p className="mt-1 font-display text-4xl leading-none tabular-nums sm:text-5xl">
              {tape.price == null ? "—" : usd(tape.price)}
            </p>
            <p className={`mt-1 text-sm ${tape.change != null && tape.change < 0 ? "text-sell" : "text-accent"}`}>
              {tape.change == null ? "Linking tape" : `${signedPct(tape.change)} today`}
              <span className="text-muted"> · {tape.status === "live" ? "Live" : "Connecting"}</span>
            </p>
          </div>
          <button
            type="button"
            data-controls
            className="pointer-events-auto inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full border border-border bg-surface/90 px-4 text-sm font-medium text-fg backdrop-blur-md"
            aria-expanded={open}
            aria-controls="field-controls"
            onClick={() => setOpen((value) => !value)}
          >
            {open ? (
              <>
                <X className="size-4" aria-hidden="true" />
                Close
              </>
            ) : (
              "Controls"
            )}
          </button>
        </div>

        {whale ? (
          <p className={`hud-read mt-2 text-sm font-medium ${whale.side === "buy" ? "text-accent" : "text-sell"}`}>
            Whale {whale.side} {compactUsd(whale.notional)}
          </p>
        ) : null}
        <p className="hud-read mt-2 text-sm">
          <span className="font-medium text-accent">Buys</span>
          <span className="text-muted"> · </span>
          <span className="font-medium text-sell">Sells</span>
          <span className={`font-medium ${leadLabel(tape.buy, tape.sell) === "Sells ahead" ? "text-sell" : "text-accent"}`}>
            {" "}
            · {leadLabel(tape.buy, tape.sell)}
          </span>
          <span className="font-normal text-muted"> · {flowNote(tape.buy, tape.sell)}</span>
        </p>
      </header>

      {open ? (
        <div className="dock pointer-events-none absolute inset-x-0 bottom-0 z-30 flex justify-center px-3 sm:px-6">
          <section
            id="field-controls"
            data-controls
            className="pointer-events-auto dock-panel mb-3 w-full max-w-xl rounded-2xl border border-border bg-surface/95 p-4 shadow-2xl backdrop-blur-md sm:mb-5"
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
                className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl border border-border bg-bg px-3 text-sm font-medium text-fg"
              >
                <RotateCcw className="size-4" aria-hidden="true" />
                Reset
              </button>
              <button
                type="button"
                onClick={() => download(canvasRef.current, () => {
                  setSaved(true);
                  window.clearTimeout(savedTimer.current);
                  savedTimer.current = window.setTimeout(() => setSaved(false), 1400);
                })}
                className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-accent px-3 text-sm font-medium text-bg"
                aria-live="polite"
              >
                <Download className="size-4" aria-hidden="true" />
                {saved ? "Saved" : "Save image"}
              </button>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="mt-2 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-border bg-bg px-3 text-sm font-medium text-fg"
            >
              <X className="size-4" aria-hidden="true" />
              Close
            </button>
          </section>
        </div>
      ) : null}
    </main>
  );
}

function download(canvas: HTMLCanvasElement | null, done: () => void) {
  if (!canvas) return;
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    link.href = url;
    link.download = `particles-btc-${stamp}.png`;
    link.click();
    URL.revokeObjectURL(url);
    done();
  }, "image/png");
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
      <div className="flex flex-wrap gap-2">{children}</div>
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
          ? "inline-flex min-h-11 items-center gap-2 rounded-full bg-accent px-3 text-sm font-medium text-bg"
          : "inline-flex min-h-11 items-center gap-2 rounded-full border border-border px-3 text-sm text-fg"
      }
    >
      {children}
    </button>
  );
}

function leadLabel(buy: number, sell: number) {
  const total = buy + sell;
  if (total < 1) return "Reading the tape";
  const tilt = (buy - sell) / total;
  if (tilt >= 0.08) return "Buys ahead";
  if (tilt <= -0.08) return "Sells ahead";
  return "Even fight";
}

function flowNote(buy: number, sell: number) {
  if (buy + sell < 1) return "Taker buys and sells show up as prints land";
  return `Live takers · buys ${compactUsd(buy)} · sells ${compactUsd(sell)}`;
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
