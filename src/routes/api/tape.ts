import { createFileRoute } from "@tanstack/react-router";

type Side = "buy" | "sell";

type Trade = { id: number; side: Side; price: number; size: number };

function takerSide(makerSide: string): Side {
  return makerSide === "sell" ? "buy" : "sell";
}

async function readTape(): Promise<Response> {
  const [tradesRes, statsRes] = await Promise.all([
    fetch("https://api.exchange.coinbase.com/products/BTC-USD/trades?limit=80"),
    fetch("https://api.exchange.coinbase.com/products/BTC-USD/stats"),
  ]);
  if (!tradesRes.ok) {
    return Response.json({ error: "tape unavailable" }, { status: 502 });
  }
  const raw = (await tradesRes.json()) as { trade_id: number; side: string; price: string; size: string }[];
  const stats = statsRes.ok ? ((await statsRes.json()) as { open?: string; last?: string }) : {};
  const trades: Trade[] = [];
  for (const row of raw) {
    const price = Number(row.price);
    const size = Number(row.size);
    if (!Number.isFinite(price) || !Number.isFinite(size)) continue;
    trades.push({ id: row.trade_id, side: takerSide(row.side), price, size });
  }
  const open = stats.open ? Number(stats.open) : null;
  const price = stats.last ? Number(stats.last) : (trades[0]?.price ?? null);
  return Response.json(
    { price, open, trades },
    { headers: { "cache-control": "no-store" } },
  );
}

export const Route = createFileRoute("/api/tape")({
  server: {
    handlers: {
      GET: () => readTape(),
    },
  },
});
