# Step 1 kickoff — instructions for the coding agent

You are building **Step 1 of the CoC Upgrade Planner** described in `SPEC.md` (read all of it first; §13 "Step 1" is your scope). The owner will be away while you work. **Work autonomously from start to finish.**

## Ground rules
- **Do not ask the owner questions.** When something is ambiguous, pick the most reasonable option, keep going, and record it in `DECISIONS.md` (one line each: decision + why).
- Environment: Windows, PowerShell, VS Code. Use cross-platform npm scripts (no bash-only syntax).
- Stay in scope: Step 1 only. **Do not call the Clash of Clans API** and do not build the meta pipeline (that's Step 2). Ship the stub `public/meta.json` as the spec says.
- Commit to git after each working milestone with a clear message (init the repo if needed). Never commit `samples/` or `.env` — add them to `.gitignore`.
- If a command fails, read the error, fix it, and retry. Don't stop at the first failure.

## Setup you should do yourself
1. Check `node -v` and `npm -v`. If Node is missing or older than 20, stop and write the problem to `REPORT.md`; that is the only thing you can't fix.
2. Scaffold the project in the current folder (Vite + TypeScript, keep existing files `SPEC.md`, `STEP1_PROMPT.md`, `config/`).
3. Install dependencies the spec names: `clash-of-clans-data`, `yaml`, `vitest`, `tsx`, plus anything else you need.
4. Install helpful VS Code extensions if the `code` CLI is available (skip silently if not):
   `code --install-extension dbaeumer.vscode-eslint`
   `code --install-extension vitest.explorer`
   `code --install-extension redhat.vscode-yaml`
5. Add npm scripts: `dev`, `build`, `test`, `sync` (minimal for Step 1), and a debug script `plan` that prints the plan for an export file in the terminal (handy for checking without the browser).

## Build order
1. **Data layer** — load every needed category from `clash-of-clans-data` (inspect the package's actual files under `node_modules/clash-of-clans-data/data/home/` before writing loaders; field names in the spec come from v0.19.1 and may differ slightly). Normalize to the `Item` model. Load `config/merges.yaml`.
2. **Export parser** — if `samples/my-export.json` exists, it's the owner's real export: **inspect its structure first** and build the parser to match it (sections, `data`, `lvl`, `cnt`, `timer`, any timestamp field). Record what you found in `DECISIONS.md`. If it doesn't exist, build from the spec and create a realistic synthetic fixture in `tests/fixtures/`.
3. **dataId join** — report any export IDs that don't resolve (print a warning list, don't crash).
4. **Priority engine** (§6) — modes, Tier 0 Queen, all tiers, book threshold, merges with TH-upgrading lookahead, hero caps from per-level `heroHallLevelRequired`.
5. **Scheduler + forecast** (§10) — Gold Pass toggle constant in one place, 24h totals, timeline, wall dump line.
6. **UI** — Import & Settings tab + Plan tab (§11), localStorage persistence, mobile-friendly, footer with data package version.
7. **Tests** — everything listed under Step 1 tests in §13. All must pass.

## Finish
- Run `npm test` and `npm run build`; both must succeed.
- Run `npm run plan -- samples/my-export.json` (or the fixture) and paste the output into `REPORT.md`.
- Write `REPORT.md` with:
  - How to start the site (`npm run dev`, URL).
  - What was built, what's stubbed, known gaps.
  - The plan output from above.
  - A short checklist of things the owner should verify in-game (e.g. Gold Pass %, whether the top builder picks look right).
- Final git commit.
