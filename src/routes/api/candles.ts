import { createFileRoute } from "@tanstack/react-router";
import { isFrame, type Candle, type FrameId } from "@/lib/candles";

const GRANULARITY: Record<"1m" | "5m" | "15m", number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
};

const cache = new Map<string, { at: number; candles: Candle[] }>();

function takerSide(makerSide: string): "buy" | "sell" {
  return makerSide === "sell" ? "buy" : "sell";
}

async function exchangeCandles(frame: "1m" | "5m" | "15m"): Promise<Candle[]> {
  const res = await fetch(
    `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=${GRANULARITY[frame]}`,
    { signal: AbortSignal.timeout(8000) },
  );
  if (!res.ok) throw new Error("candles");
  const raw = (await res.json()) as number[][];
  const candles: Candle[] = [];
  for (const row of raw) {
    const [t, low, high, open, close] = row;
    if (![t, low, high, open, close].every((n) => typeof n === "number")) continue;
    candles.push({ t: t * 1000, o: open, h: high, l: low, c: close, buy: 0, sell: 0 });
  }
  candles.sort((a, b) => a.t - b.t);
  return candles.slice(-70);
}

async function tradeCandles(ms: number): Promise<Candle[]> {
  const rows: { time: number; price: number; usd: number; side: "buy" | "sell" }[] = [];
  let after = "";
  let newest = 0;
  for (let page = 0; page < 14; page++) {
    const url = new URL("https://api.exchange.coinbase.com/products/BTC-USD/trades");
    url.searchParams.set("limit", "100");
    if (after) url.searchParams.set("after", after);
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) break;
    const batch = (await res.json()) as { time: string; price: string; size: string; side: string }[];
    if (!batch.length) break;
    for (const row of batch) {
      const price = Number(row.price);
      const size = Number(row.size);
      const time = Date.parse(row.time);
      if (!Number.isFinite(price) || !Number.isFinite(size) || !Number.isFinite(time)) continue;
      rows.push({ time, price, usd: price * size, side: takerSide(row.side) });
    }
    if (!newest) newest = Date.parse(batch[0].time);
    const oldest = Date.parse(batch[batch.length - 1].time);
    if (newest - oldest >= ms * 48) break;
    after = res.headers.get("cb-after") ?? "";
    if (!after) break;
  }
  rows.sort((a, b) => a.time - b.time);
  const buckets = new Map<number, Candle>();
  for (const row of rows) {
    const t = Math.floor(row.time / ms) * ms;
    const candle = buckets.get(t);
    if (!candle) {
      buckets.set(t, {
        t,
        o: row.price,
        h: row.price,
        l: row.price,
        c: row.price,
        buy: row.side === "buy" ? row.usd : 0,
        sell: row.side === "sell" ? row.usd : 0,
      });
      continue;
    }
    candle.h = Math.max(candle.h, row.price);
    candle.l = Math.min(candle.l, row.price);
    candle.c = row.price;
    if (row.side === "buy") candle.buy += row.usd;
    else candle.sell += row.usd;
  }
  return [...buckets.values()].sort((a, b) => a.t - b.t).slice(-70);
}

async function load(frame: FrameId): Promise<Candle[]> {
  const hit = cache.get(frame);
  if (hit && Date.now() - hit.at < 4000) return hit.candles;
  const candles = frame === "15s" || frame === "30s" ? await tradeCandles(frame === "15s" ? 15_000 : 30_000) : await exchangeCandles(frame);
  cache.set(frame, { at: Date.now(), candles });
  return candles;
}

async function readCandles(request: Request): Promise<Response> {
  const frame = new URL(request.url).searchParams.get("frame");
  if (!isFrame(frame)) return Response.json({ error: "bad frame" }, { status: 400 });
  try {
    const candles = await load(frame);
    return Response.json({ frame, candles }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "candles unavailable" }, { status: 502 });
  }
}

export const Route = createFileRoute("/api/candles")({
  server: {
    handlers: {
      GET: ({ request }) => readCandles(request),
    },
  },
});
