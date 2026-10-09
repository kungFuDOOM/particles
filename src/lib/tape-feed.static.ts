import { readCoinbaseTape, type TapePayload } from "@/lib/coinbase-tape";

/** The GitHub Pages build has no server, so it reads Coinbase's CORS-open REST API directly. */
export async function fetchTape(): Promise<Partial<TapePayload> | null> {
  return readCoinbaseTape();
}
