# Step 2 kickoff — instructions for the coding agent

You are building **Step 2 of the CoC Upgrade Planner**: the Legend League I meta pipeline and the Lab / Pets / Equipment tab. Read `SPEC.md` (§3.3, §6.7–6.9, §8, §11, §13 "Step 2"), plus `REPORT.md` and `DECISIONS.md` from Step 1, before writing code. **Work autonomously from start to finish.**

## Ground rules
- **Do not ask the owner questions.** When something is ambiguous, pick the most reasonable option, keep going, and add a line to `DECISIONS.md`.
- Windows, PowerShell, VS Code. Cross-platform npm scripts only.
- Scope is Step 2 only. Don't start Step 3 work (sync diffs, Everything tab, helpers/boosts).
- **Never print, log or commit the API token.** It's in `.env` as `COC_API_TOKEN` (already git-ignored). Load it with `dotenv`.
- **Tests must not call the live API.** Use recorded fixtures.
- Commit after each working milestone. `data/meta/battles.jsonl` may be committed only if it is small (< 5 MB); otherwise git-ignore it and note that in `DECISIONS.md`.
- If a command fails, read the error, fix it, and retry.

## 1. Probe the real API first
Before building the collector, write a small script `scripts/probe.ts` that makes a handful of real calls and saves **redacted** samples to `tests/fixtures/api/`:
- `GET /locations` (first page)
- `GET /locations/global/rankings/players?limit=5` and one country's rankings
- `GET /players/{tag}/battlelog` for 2–3 players from those rankings
- `GET /players/{tag}` for one of them

Use the samples to confirm (and record in `DECISIONS.md`):
- The exact field names for battle log entries (`battleType`, `attack`, `armyShareCode`, `battleTimestamp`, `stars`, etc.) and for `leagueTier` on ranked players.
- That `battleType === 'LEGEND'` entries come from Legend League I players (league tier id `105000036`). If not, filter on whatever the data shows identifies Legend I attacks, and explain it.
- How many entries a battle log returns. This decides how often `npm run meta` should run; put the recommendation in `REPORT.md`.
- How location rankings paginate (limit and cursor behaviour).

If any call returns **403**, the key is probably locked to a different IP. Stop, and write in `REPORT.md` exactly what the error said and that the owner should create a key for their current public IP at developer.clashofclans.com. That's the only blocker you can't fix.

## 2. Army share code parser — `src/meta/armyCode.ts`
- Port the parser from the ClashKing Go SDK (`github.com/clashkinginc/clashy.go`, MIT, `game.go: ParseArmyRecipe` and its tests). Clone it into a scratch folder outside the project for reference; don't add it as a dependency.
- Behaviour per SPEC §8.2: sections `h` `u` `s` `i` `d`; `qtyxid` items; hero regex with pet and two equipment slots; base IDs (troops 4000000, spells 26000000, heroes 28000000, pets 73000000, equipment 90000000). Accept a full link or a raw payload.
- Port the Go test cases to Vitest, and add cases built from real `armyShareCode` values in your fixtures.
- **Sieges usually sit in the Clan Castle section (`i`)**; count them toward siege usage. Ignore other CC troops and spells for usage.
- Resolve every parsed ID against the game data. Unknown IDs: keep counting them, but list them in the run summary.

## 3. Collector — `npm run meta`
Per SPEC §8.1, with these specifics:
- Gather Legend I players from global + country rankings, dedupe, stop at `meta.maxPlayers` from `config/settings.sample.yaml`.
- Fetch each player's battle log; keep attacks that are Legend I ranked attacks (per your probe findings). **No Town Hall filter.**
- Append new rows to `data/meta/battles.jsonl`, deduped by `playerTag + battleTimestamp`.
- Throttle to `meta.requestsPerSecond`, retry 429/5xx with exponential backoff, show progress, and make the run **resumable**: if it's interrupted, rerunning skips players already fetched in this run.
- Add `--max-players <n>` to override the config for quick tests.
- Run summary at the end: players fetched, attacks kept, new vs duplicate rows, unknown IDs, elapsed time.

## 4. Aggregation → `public/meta.json`
Per SPEC §8.3: 14-day window, exponential recency weighting (half-life from config, default 5 days). For each troop, spell, siege, pet and equipment piece: `usage`, `threeStarRate`, and `avgQty` (troops and spells). Output shape exactly as in §8.3. Unit-test the weighting with hand-made rows.

## 5. UI — Lab / Pets / Equipment tab
- Ranked lists per SPEC §6.7–6.9: meta score descending, unused items **at the bottom, not greyed out**, showing usage % and 3★ rate.
- Pin buttons that move an item to the top; pins persist in localStorage.
- The 24h forecast and Plan tab use the same ranking (lab and pet queue order, blacksmith ore picks).
- Footer shows `meta.json` `generatedAt` and attack count. If meta is missing or empty, fall back to Step 1 behaviour without errors.

## 6. Run it for real
1. `npm run meta -- --max-players 50` as a smoke test.
2. If that works, a full `npm run meta`.
3. `npm test` and `npm run build` must pass.
4. `npm run plan -- samples/myexport.json` with the real meta.

## Finish — append a "Step 2" section to `REPORT.md`
- What you confirmed from the probe (fields, Legend I filter, battle log depth, pagination).
- Run summary from the full meta run.
- Top 15 troops/spells/sieges by usage, top 5 pets, top 10 equipment, each with usage % and 3★ rate.
- How the lab, pet and equipment order in the owner's plan changed.
- Recommended run frequency for `npm run meta`, based on the battle log depth.
- Anything the owner should check.
- Final git commit.
