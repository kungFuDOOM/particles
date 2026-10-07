# Particles

Live Bitcoin tape. Buy prints are mint, sell prints are red, and they collide as a particle field.

A rush of one side detonates on that side. Whales and sharp price jumps throw a shockwave. The front moves toward whoever is spending more on the live tape.

## Run

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:8080`.

Prints come from the Coinbase exchange tape. The dev server proxies that feed, so the browser does not call Coinbase directly.
