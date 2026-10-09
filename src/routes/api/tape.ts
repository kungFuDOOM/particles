import { createFileRoute } from "@tanstack/react-router";
import { readCoinbaseTape } from "@/lib/coinbase-tape";

async function readTape(): Promise<Response> {
  const tape = await readCoinbaseTape();
  if (!tape) return Response.json({ error: "tape unavailable" }, { status: 502 });
  return Response.json(tape, { headers: { "cache-control": "no-store" } });
}

export const Route = createFileRoute("/api/tape")({
  server: {
    handlers: {
      GET: () => readTape(),
    },
  },
});
