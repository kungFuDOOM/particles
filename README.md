# Particles

Live Bitcoin tape. Buy prints are mint, sell prints are red, and they collide as a particle field.

A rush of one side detonates on that side. Whales and sharp price jumps throw a shockwave. The front moves toward whoever is spending more on the live tape.

## Run

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:8080`.

Prints stream from Coinbase's public WebSocket feed. On load, and whenever the socket cannot connect, the app reads `/api/tape`, a server-side proxy of Coinbase's REST trades and 24h stats.

## GitHub Pages

The live site is <https://kungfudoom.github.io/particles/>. Pages only serves static files, so that build swaps `/api/tape` for direct calls to Coinbase's public REST API (CORS-open) via `src/lib/tape-feed.static.ts`. `.github/workflows/pages.yml` redeploys on every push to `main`.

One-time setup: Settings → Pages → Build and deployment → Source: **GitHub Actions**.

Build the static site locally:

```bash
PAGES_BASE=/particles/ npm run pages:build   # writes dist-pages/
```

## Rendering

With WebGL2 (`src/lib/trail-gl.ts`) the whole field is one opaque canvas, so the browser composites a single layer with no CSS blend modes:

- particle streaks are instanced, anti-aliased quads, one draw call per colour lane, accumulating in a half-float trail buffer with a frame-rate-independent fade,
- the final pass blooms the trail on the GPU and screens it over the backdrop glows (multiplies it into Paper), with the vignette; the backdrop is cached in a quarter-size texture and redrawn only when the buy/sell balance moves,
- dust, flashes, shockwave rings (as thin ring meshes) and the front seam are drawn on top.

Auto-quality lowers the render resolution while frames run long, then thins the particles if that is not enough, and restores both once frames recover. The Controls panel shows the renderer, frame rate and current scaling.

Without usable GPU acceleration the field falls back to Canvas2D layers (trail, glow, overlay) over a CSS backdrop and vignette.

**Save image** flattens what is on screen into one PNG and stamps a caption with price, flow split and time.
