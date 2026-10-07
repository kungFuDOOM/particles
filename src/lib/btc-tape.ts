export type Side = "buy" | "sell";

export type Print = {
  id: number;
  side: Side;
  price: number;
  notional: number;
};

export type TapeState = {
  price: number | null;
  change: number | null;
  buy: number;
  sell: number;
  status: "connecting" | "live";
  lastSide: Side | null;
};

type Whale = { side: Side; notional: number; id: number };

const WHALE_USD = 25_000;

type Listener = {
  onPrint: (print: Print) => void;
  onState: (state: TapeState) => void;
  onWhale: (whale: Whale) => void;
  getWindow?: () => number;
};

/** Taker side. Coinbase `side` is the maker: a maker sell means someone lifted the offer. */
export function takerSide(makerSide: string): Side {
  return makerSide === "sell" ? "buy" : "sell";
}

export function startTape(listener: Listener) {
  const seen = new Set<number>();
  const flow: { t: number; side: Side; usd: number }[] = [];
  let price: number | null = null;
  let open: number | null = null;
  let lastSide: Side | null = null;
  let status: TapeState["status"] = "connecting";
  let stopped = false;
  let ws: WebSocket | null = null;
  let pollTimer = 0;
  let stateTimer = 0;
  let pileTimer = 0;
  let reconnectTimer = 0;
  let gotLive = false;
  let synth = -1;
  const pile: Record<Side, number> = { buy: 0, sell: 0 };

  const emitState = () => {
    const keep = Date.now() - 16 * 60 * 1000;
    const windowMs = Math.min(16 * 60 * 1000, Math.max(15_000, listener.getWindow?.() ?? 60_000));
    const from = Date.now() - windowMs;
    let buy = 0;
    let sell = 0;
    let drop = 0;
    for (let i = 0; i < flow.length; i++) {
      if (flow[i].t < keep) drop = i + 1;
      else if (flow[i].t >= from) {
        if (flow[i].side === "buy") buy += flow[i].usd;
        else sell += flow[i].usd;
      }
    }
    if (drop) flow.splice(0, drop);
    const change = price != null && open != null && open > 0 ? (price - open) / open : null;
    listener.onState({ price, change, buy, sell, status, lastSide });
  };

  const push = (print: Print, announceWhale: boolean) => {
    if (seen.has(print.id)) return;
    seen.add(print.id);
    if (seen.size > 8000) {
      const drop = seen.size - 4000;
      let i = 0;
      for (const id of seen) {
        seen.delete(id);
        if (++i >= drop) break;
      }
    }
    price = print.price;
    lastSide = print.side;
    flow.push({ t: Date.now(), side: print.side, usd: print.notional });
    show(print, announceWhale);
    status = "live";
    gotLive = true;
  };

  const flushPile = () => {
    const sides: Side[] = ["buy", "sell"];
    for (const side of sides) {
      const usd = pile[side];
      if (usd < 40) continue;
      pile[side] = 0;
      const bundled: Print = { id: synth, side, price: price ?? 0, notional: usd };
      synth -= 1;
      listener.onPrint(bundled);
      if (usd >= WHALE_USD) listener.onWhale(bundled);
    }
  };

  const show = (print: Print, announceWhale: boolean) => {
    if (print.notional >= 1200) {
      listener.onPrint(print);
      if (announceWhale && print.notional >= WHALE_USD) listener.onWhale(print);
      return;
    }
    pile[print.side] += print.notional;
  };

  const takeRow = (row: { trade_id?: number; id?: number; side?: string; price?: string; size?: string }, announceWhale: boolean) => {
    const id = Number(row.trade_id ?? row.id);
    const px = Number(row.price);
    const size = Number(row.size);
    if (!Number.isFinite(id) || !Number.isFinite(px) || !Number.isFinite(size) || !row.side) return;
    push({ id, side: takerSide(row.side), price: px, notional: px * size }, announceWhale);
  };

  const applyPayload = (payload: { price?: number; open?: number; trades?: { id: number; side: Side; price: number; size: number }[] }, announceWhale: boolean) => {
    if (typeof payload.open === "number") open = payload.open;
    if (typeof payload.price === "number") price = payload.price;
    const trades = payload.trades ?? [];
    for (let i = trades.length - 1; i >= 0; i--) {
      const row = trades[i];
      push(
        { id: row.id, side: row.side, price: row.price, notional: row.price * row.size },
        announceWhale,
      );
    }
    emitState();
  };

  const poll = async () => {
    try {
      const res = await fetch("/api/tape");
      if (!res.ok) return;
      const body = (await res.json()) as {
        price?: number;
        open?: number;
        trades?: { id: number; side: Side; price: number; size: number }[];
      };
      applyPayload(body, true);
    } catch {
      /* next tick */
    }
  };

  const startPoll = () => {
    if (pollTimer || stopped) return;
    void poll();
    pollTimer = window.setInterval(() => void poll(), 1000);
  };

  const connect = () => {
    if (stopped) return;
    try {
      ws = new WebSocket("wss://ws-feed.exchange.coinbase.com");
    } catch {
      startPoll();
      return;
    }
    const watchdog = window.setTimeout(() => {
      if (!gotLive) {
        ws?.close();
        startPoll();
      }
    }, 4500);
    ws.onopen = () => {
      ws?.send(
        JSON.stringify({
          type: "subscribe",
          product_ids: ["BTC-USD"],
          channels: ["matches", "ticker", "heartbeat"],
        }),
      );
    };
    ws.onmessage = (event) => {
      let msg: {
        type?: string;
        trade_id?: number;
        side?: string;
        price?: string;
        size?: string;
        open_24h?: string;
      };
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg.type === "ticker" && msg.price) {
        price = Number(msg.price);
        if (msg.open_24h) open = Number(msg.open_24h);
        return;
      }
      if (msg.type === "match" || msg.type === "last_match") {
        window.clearTimeout(watchdog);
        takeRow(msg, msg.type === "match");
      }
    };
    ws.onerror = () => {
      ws?.close();
    };
    ws.onclose = () => {
      window.clearTimeout(watchdog);
      if (stopped) return;
      if (!gotLive) startPoll();
      else reconnectTimer = window.setTimeout(connect, 1500);
    };
  };

  void fetch("https://api.exchange.coinbase.com/products/BTC-USD/stats")
    .then((res) => (res.ok ? res.json() : null))
    .then((stats: { open?: string; last?: string } | null) => {
      if (!stats) return;
      if (stats.open) open = Number(stats.open);
      if (price == null && stats.last) price = Number(stats.last);
      emitState();
    })
    .catch(() => undefined);

  connect();
  stateTimer = window.setInterval(emitState, 250);
  pileTimer = window.setInterval(flushPile, 180);

  return () => {
    stopped = true;
    window.clearInterval(pollTimer);
    window.clearInterval(stateTimer);
    window.clearInterval(pileTimer);
    window.clearTimeout(reconnectTimer);
    ws?.close();
  };
}
