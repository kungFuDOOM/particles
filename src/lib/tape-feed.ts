import type { TapePayload } from "@/lib/coinbase-tape";

/** Snapshot of the tape through the app's server proxy. */
export async function fetchTape(): Promise<Partial<TapePayload> | null> {
  const res = await fetch("/api/tape");
  if (!res.ok) return null;
  return (await res.json()) as Partial<TapePayload>;
}
