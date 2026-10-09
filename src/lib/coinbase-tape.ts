import type { Side } from "@/lib/btc-tape";

export type TapeTrade = { id: number; side: Side; price: number; size: number };

export type TapePayload = { price: number | null; open: number | null; trades: TapeTrade[] };

/** Taker side. Coinbase `side` is the maker: a maker sell means someone lifted the offer. */
export function takerSide(makerSide: string): Side {
  return makerSide === "sell" ? "buy" : "sell";
}

const API = "https://api.exchange.coinbase.com/products/BTC-USD";

/** Recent BTC-USD prints and the 24h open from Coinbase's public REST API, newest first. */
export async function readCoinbaseTape(): Promise<TapePayload | null> {
  const [tradesRes, statsRes] = await Promise.all([
    fetch(`${API}/trades?limit=80`),
    fetch(`${API}/stats`).catch(() => null),
  ]);
  if (!tradesRes.ok) return null;
  const raw = (await tradesRes.json()) as { trade_id: number; side: string; price: string; size: string }[];
  const stats = statsRes?.ok ? ((await statsRes.json()) as { open?: string; last?: string }) : {};
  const trades: TapeTrade[] = [];
  for (const row of raw) {
    const price = Number(row.price);
    const size = Number(row.size);
    if (!Number.isFinite(price) || !Number.isFinite(size)) continue;
    trades.push({ id: row.trade_id, side: takerSide(row.side), price, size });
  }
  const open = stats.open ? Number(stats.open) : null;
  const price = stats.last ? Number(stats.last) : (trades[0]?.price ?? null);
  return { price, open, trades };
}
