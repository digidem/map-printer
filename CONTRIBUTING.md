# Contributing

Map Printer exports print-resolution PNGs of a map area entirely in the
browser. It is a static site (Vite + TypeScript, Lit + Tailwind, maplibre-gl).

## Getting set up

You'll need Node 22. Then:

```bash
npm install
npm run dev
```

This starts the Vite dev server.

## Where things live

Each module lives under `src/lib/<name>/`, with `index.ts` as its only public
surface — nothing outside the module should import from anything else inside
it. Each module's contract (what it takes, what it returns, its invariants)
is documented in `docs/architecture.md`. UI code lives in `src/`.

## Before opening a PR

Run:

```bash
npm run typecheck
npm test           # Vitest unit tests, alongside the code as src/lib/**/*.test.ts
```

Browser-only modules are covered by Playwright e2e tests in `e2e/`. Install
the browsers once with `npm run test:e2e:install`, then run them with:

```bash
npm run test:e2e
```

CI runs typecheck, unit tests, build, and the chromium + webkit e2e tests on
every push and PR.

## PRs and commits

Commit and PR titles follow [Conventional
Commits](https://www.conventionalcommits.org/): `<type>(<optional scope>):
<subject>`.

Keep PRs small and focused on one change. If a PR changes a module's
contract, update `docs/architecture.md` to match.

For anything bigger than a small fix, please open an issue first to discuss
the approach before doing the work.
