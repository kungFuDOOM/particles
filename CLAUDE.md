# Particles

## Shipping changes

The owner wants finished work merged without waiting for them:

- Work on a branch, open a pull request, and merge it yourself once the repo's checks pass
  (`npm run typecheck`, `npm run lint`, `npm run pages:build`).
- Merging to `main` redeploys https://kungfudoom.github.io/particles/ through `.github/workflows/pages.yml`.
- Still stop and ask before anything destructive or irreversible (force pushes, deleting branches or data).

`npm test` has 16 known failures in the app-builder template's own tests (they look for `.grok/` files that are not in this repo); they are not regressions.
