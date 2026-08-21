# Project Hawk — Project Finance Model

An interactive project-finance model (solar PPA asset), ported from an Excel/`.xlsb`
workbook into a standalone React app with a live-editable input panel, charts, and
period-by-period schedules.

## What's inside

- **Calc engine** (`src/App.jsx`, top half of the file) — a sequential, period-by-period
  JS port of the original workbook's `Inputs` / `Calc` / `FS` / `Solver` sheets:
  construction funding & debt sizing (including the circular interest-during-construction
  problem, solved via fixed-point iteration), operating cash flows, DSCR-sculpted debt
  repayment, depreciation, tax, dividends, a reconstructed balance sheet, and an XIRR-based
  Equity IRR.
- **UI** (`src/App.jsx`, bottom half) — a dark/light-themeable, responsive dashboard: a
  collapsible input sidebar (desktop) / slide-over drawer (mobile), a custom date picker,
  headline Equity IRR / Tariff stats, KPI cards, charts (Recharts), and tabbed data tables
  for the debt schedule, cash flow, and balance sheet.

## Requirements

- [Node.js](https://nodejs.org/) 18+ and npm

## Getting started

```bash
npm install
npm run dev
```

Then open the local URL Vite prints (typically `http://localhost:5173`).

## Build for production

```bash
npm run build
npm run preview   # sanity-check the production build locally
```

The static site is output to `dist/`.

## Deploying

### GitHub Pages (included workflow)

This repo ships with `.github/workflows/deploy.yml`, which builds the app and deploys
`dist/` to GitHub Pages automatically on every push to `main`.

To enable it:

1. Push this repo to GitHub.
2. In the repo, go to **Settings → Pages** and set **Source** to **GitHub Actions**.
3. Push to `main` (or run the workflow manually from the **Actions** tab).

Your site will be published at `https://<your-username>.github.io/<repo-name>/`.

### Other static hosts

The build output in `dist/` is a plain static site — it deploys as-is to Vercel, Netlify,
Cloudflare Pages, or any static file host. `vite.config.js` uses a relative `base: "./"`,
which works for both root-domain and sub-path deployments.

## Project structure

```
.
├── .github/workflows/deploy.yml   # GitHub Pages CI/CD
├── index.html                     # Vite entry HTML
├── package.json
├── vite.config.js
├── src/
│   ├── main.jsx                   # React root
│   ├── index.css                  # global styles
│   └── App.jsx                    # engine + UI (see comments at the top of the file)
└── README.md
```

## Known simplifications vs. the original workbook

Documented in the header comment of `src/App.jsx`:

- The construction draw curve is replicated exactly (EPC/Development/Insurance: flat
  1/12 per month; SPV costs: 50/50 in the final two construction months) but is not
  user-editable as a curve — only the total amounts are.
- The balance sheet is a compact reconstruction (assets / liabilities / equity
  roll-forward), not a cell-for-cell port of every original `FS` sheet row.

## Ownership & License

Owned by **Mohammad Tahsin Kawadri** and **Mohammed Zaman Ahmed** (50% co-owner).

**This is proprietary, closed-source software — not open source.** All rights are
reserved; no use, copying, modification, or distribution is permitted except as
authorized in writing by both owners. See [LICENSE](./LICENSE) for the full terms.
