export type FrameId = "15s" | "30s" | "1m" | "5m" | "15m";

export type Candle = {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  buy: number;
  sell: number;
};

export const FRAMES: { id: FrameId; label: string; ms: number }[] = [
  { id: "15s", label: "15s", ms: 15_000 },
  { id: "30s", label: "30s", ms: 30_000 },
  { id: "1m", label: "1m", ms: 60_000 },
  { id: "5m", label: "5m", ms: 300_000 },
  { id: "15m", label: "15m", ms: 900_000 },
];

export function frameMs(id: FrameId) {
  return FRAMES.find((frame) => frame.id === id)?.ms ?? 60_000;
}

export function isFrame(value: string | null): value is FrameId {
  return FRAMES.some((frame) => frame.id === value);
}

export function applyTick(candles: Candle[], ms: number, price: number, side: "buy" | "sell", usd: number, now = Date.now()) {
  if (!Number.isFinite(price) || price <= 0) return candles;
  const t = Math.floor(now / ms) * ms;
  const next = candles.length > 90 ? candles.slice(-80) : candles.slice();
  const last = next[next.length - 1];
  if (!last || last.t !== t) {
    next.push({ t, o: price, h: price, l: price, c: price, buy: side === "buy" ? usd : 0, sell: side === "sell" ? usd : 0 });
    return next;
  }
  next[next.length - 1] = {
    ...last,
    h: Math.max(last.h, price),
    l: Math.min(last.l, price),
    c: price,
    buy: last.buy + (side === "buy" ? usd : 0),
    sell: last.sell + (side === "sell" ? usd : 0),
  };
  return next;
}

export function mergeLive(history: Candle[], local: Candle[], ms: number) {
  const nowBucket = Math.floor(Date.now() / ms) * ms;
  const map = new Map<number, Candle>();
  for (const candle of history) map.set(candle.t, { ...candle });
  const live = [...local].reverse().find((candle) => candle.t === nowBucket);
  if (live) {
    const prev = map.get(nowBucket);
    map.set(
      nowBucket,
      prev
        ? {
            ...prev,
            h: Math.max(prev.h, live.h),
            l: Math.min(prev.l, live.l),
            c: live.c,
            buy: Math.max(prev.buy, live.buy),
            sell: Math.max(prev.sell, live.sell),
          }
        : { ...live },
    );
  }
  return [...map.values()].sort((a, b) => a.t - b.t).slice(-80);
}

/** Positive when this chart's close is above its open, scaled by how much of the range it covered. */
export function biasOf(candles: Candle[]) {
  const shown = candles.slice(-48);
  if (shown.length < 2) return 0;
  const open = shown[0].o;
  const close = shown[shown.length - 1].c;
  if (!(open > 0)) return 0;
  let high = shown[0].h;
  let low = shown[0].l;
  for (const candle of shown) {
    high = Math.max(high, candle.h);
    low = Math.min(low, candle.l);
  }
  const ret = (close - open) / open;
  const range = Math.max((high - low) / open, 0.00008);
  return clamp(ret / (range * 0.65), -1, 1);
}

export function windowReturn(candles: Candle[]) {
  const shown = candles.slice(-48);
  if (!shown.length) return null;
  const open = shown[0].o;
  const close = shown[shown.length - 1].c;
  if (!(open > 0)) return null;
  return (close - open) / open;
}

export async function fetchCandles(frame: FrameId): Promise<Candle[]> {
  const res = await fetch(`/api/candles?frame=${frame}`);
  if (!res.ok) throw new Error("candles unavailable");
  const body = (await res.json()) as { candles?: Candle[] };
  return Array.isArray(body.candles) ? body.candles : [];
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}
