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

The field is a stack of layers the browser composites on the GPU:

- a CSS backdrop with soft side glows that follow the buy/sell balance,
- a persistent trail canvas (screen-blended on dark grounds, multiplied on Paper) with a frame-rate-independent fade,
- a quarter-size bloom canvas,
- an overlay canvas for the front seam, shockwaves, flashes and drifting dust, cleared every frame,
- a CSS vignette.

**Save image** flattens the same stack into one PNG and stamps a caption with price, flow split and time.
