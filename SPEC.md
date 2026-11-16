# CoC Upgrade Planner — v1 Spec

A local website that reads a Clash of Clans account export and tells the player what to upgrade next, following a rush-first priority system. It also produces a 24-hour resource "shopping list" and lab/pet/equipment picks ranked by Legend League I usage.

**v1 = runs locally on Windows**, and the same static site is also published to **GitHub Pages** (§15): https://tropicalhibi.github.io/Hibiscus-clash-advisor/. No accounts, no backend. Meta and game-data refreshes still run only on the local machine (the API key is IP-locked); scheduled automation in CI is v2+.

---

## 1. Scope

**In scope (v1)**
- Home village only.
- Import the in-game account export JSON (pasted into the site).
- Priority engine + builder scheduler.
- Separate queues: Laboratory, Pet House. Blacksmith equipment upgrades are instant (ore-limited, no timer), so they are a ranked list, not a queue.
- 24h forecast of resources needed (no current-resource input).
- Wall "dump" line.
- Legend League I meta pipeline (local script → `meta.json`).
- Game-data sync script with validation tests.
- Static hosting on GitHub Pages, deployed by GitHub Actions on every push to `main` (§15).

**Out of scope (v1, revisit later)**
- Builder Base, Clan Capital.
- Sleep/awake windows for timing finishes.
- Scheduled CI jobs (daily meta / version check in GitHub Actions), multi-device sync.
- Entering current resources.

---

## 2. Stack

- **Vite + TypeScript** single-page app. `npm run dev` → `http://localhost:5173`. The Pages build is served under `/Hibiscus-clash-advisor/`, so runtime fetches (`meta.json`, any future image or data file) build their URL from `import.meta.env.BASE_URL`, never a hard-coded `/`.
- Plain TS + minimal DOM or a light framework (Preact or Svelte fine; no heavy UI kit).
- **Node scripts** in TypeScript run with `tsx`.
- **Vitest** for tests.
- `yaml` package for config files; `dotenv` for the API token.
- State stored in browser `localStorage` (export JSON + settings). Wrap reads/writes in try/catch.

### npm scripts
| Script | Does |
|---|---|
| `npm run dev` | Refresh stale game data / meta (§9a), then start the local site |
| `npm run dev:fast` | Start the local site without the refresh |
| `npm run sync` | Update game data, run validation, snapshot it and print the diff vs the last snapshot (`-- --offline`: no npm, validate + snapshot the installed version) |
| `npm run meta` | Pull Legend I battle logs, aggregate, write `public/meta.json` |
| `npm run push-meta` | Commit `public/meta.json` (only that file) as `meta: <generatedAt>` and push `main`, if it changed — redeploys the live site (§15) |
| `npm run build` | Typecheck + production build at base `/` |
| `npm run build:pages` | Same, at the GitHub Pages base `/Hibiscus-clash-advisor/` (used by CI) |
| `npm test` | Unit + validation tests |

---

## 3. Data sources

### 3.1 Game data — `clash-of-clans-data` (npm, repo `chiefpansancolt/clash-of-clans-data`)
- Install as a dependency. Package exports `.`, `./data/*`, `./images/*`. JSON lives under `data/home/<category>/<item>.json`.
- Categories used: `town-hall`, `defenses`, `army-buildings`, `resource-buildings`, `traps`, `walls`, `heroes`, `troops`, `spells`, `siege-machines`, `pets`, `hero-equipment`, `crafted-defenses`, `guardians`, `other/helpers`.
- Each item has a numeric **`dataId`** (e.g. Ricochet Cannon = `1000085`) which matches the IDs in the account export. **Join on `dataId`, never on names.**
- Building levels: `buildCost`, `buildCostResource`, `buildTime {days,hours,minutes,seconds}`, `townHallRequired`.
- Hero levels: `upgradeCost`, `upgradeCostResource`, `upgradeTime`, `heroHallLevelRequired`.
- Defenses that get merged have `availablePerTownHall[].countAfterMerges`. Merged defenses have their own files with `availablePerTownHall[].count`.
- Supercharge data is present on some defense files.
- Walls: `buildCostResource: "Gold or Elixir"`.

- `other/helpers`: Builder's Apprentice and Lab Assistant levels carry `workRate` (hours of progress per work hour), used by the scheduler (§10.1). The Prospector and Alchemist are recognised but don't affect timing.
- **Missing dataIds** go in `config/id-overrides.yaml` (`<dataId>: <file id>`). Today: `93000003: alchemist` (the Alchemist file has no `dataId`). If the data later ships its own dataId, the data wins, and a differing value shows a warning.
- **Images:** item files carry `images.icon` (troops, spells, sieges, heroes, pets, equipment) or per-level `levels[].images.normal` (buildings). The files are WebP saved as `.png`, some up to 4096 px, so the build resizes them (§13 Step 3).

**Known data quirk:** Hero Hall `heroLevelCaps` is stale (says Archer Queen cap 105 at Hero Hall 12; in-game max is 110). **Derive hero caps from each hero level's `heroHallLevelRequired`, not from the Hero Hall's cap table.** Validation test (§9) logs the mismatch.

### 3.2 Account state — in-game export JSON
- Player copies it from in-game settings and pastes it into the site.
- Shape (from coc.py 4.0 `AccountData` parser): top-level sections are lists — `buildings`, `traps`, `heroes`, `troops`, `spells`, `pets`, `equipment`, `guardians`, `helpers`, `decorations`, `obstacles`, etc. Sections ending in `2` (e.g. `buildings2`) are Builder Base → ignore in v1.
- Item fields: `data` (dataId), `lvl`, `cnt` (number of instances at that level), `timer` (seconds remaining if upgrading), `extra` (true = Goblin Builder), `helper_timer` (seconds left of a helper's work hour on this upgrade), and the recurrent-helper flag. The real export spells it **`helper_recurrent`**; coc.py documents `recurrent_helper`. Both are accepted.
- `helpers` section: `{ data, lvl, helper_cooldown }`. All helpers share one cooldown (seconds until they can work again), as in coc.py.
- Top-level `boosts` object, keys as in coc.py's `Boosts` (seconds remaining at the export time): `builder_boost` (Builder Potion), `lab_boost` (Research Potion), `builder_consumable` (Builder Bite), `lab_consumable` (Study Soup), `clocktower_boost`, `clocktower_cooldown`, `helper_cooldown`. The real export had `boosts: {}`. Unknown keys or shapes produce a Plan-tab warning, never an error.
- **No resource amounts** — that's why the forecast reports totals needed, not a deficit.
- **Verify on first real export:** is there a top-level timestamp? If yes, timers count down from it. If not, use the paste time as the baseline and show "imported at HH:MM".
- Builder count = Builder's Huts (Σ `cnt`) + B.O.B's Hut in `buildings`. Goblins are never counted as schedulable slots (§10.1).

### 3.3 Official API — meta pipeline only
- Base URL `https://api.clashofclans.com/v1`, bearer token from `.env` (`COC_API_TOKEN`). In v1 the key is locked to the player's home IP.
- **The browser never calls the API** (CORS + would expose the key). Only `npm run meta` does.
- Endpoints:
  - `GET /locations` — list locations.
  - `GET /locations/{id}/rankings/players` — ranked players; each has `leagueTier {id, name}`.
  - `GET /players/{tag}/battlelog` — entries: `battleType` (`homeVillage` | `ranked` | `legend`, **lowercase** as returned by the API), `attack` (bool), `armyShareCode`, `stars`, `destructionPercentage`, `battleTimestamp`, `opponentTownHallLevel`, `battleTime`.
  - **`legend` = Legend League I only.** Legend League II/III attacks come back as `ranked`.
  - **A battle log holds ~50 entries (~2 days of Legend I attacks)**, so `npm run meta` must run **daily** to avoid gaps.
- **Legend League I** = league tier id `105000036` (8 battles/day, group size 1500).

---

## 4. Repo layout

```
coc-planner/
  SPEC.md
  .github/workflows/
    pages.yml            # test + build + deploy to GitHub Pages on push to main (§15)
  config/
    merges.yaml          # merge recipes (hand-maintained)
    id-overrides.yaml    # dataIds missing from the game data (§3.1)
    settings.sample.yaml # defaults the UI starts from
  scripts/
    sync.ts              # npm run sync
    meta.ts              # npm run meta
    refresh.ts           # predev refresh (§9a)
    push-meta.ts         # npm run push-meta (§15)
  src/
    data/                # load + normalize clash-of-clans-data into Item model
    state/               # parse export JSON → AccountState
    engine/
      tiers.ts           # mode detection + tier assignment + eligibility
      scheduler.ts       # simulate builders/lab/pet house
      boosts.ts          # active boosts (work clock) + helpers (§10.1)
      everything.ts      # Everything tab model (§11)
      forecast.ts        # 24h needs + wall dump
      book.ts            # hero book-threshold logic
    meta/
      armyCode.ts        # armyShareCode parser
      aggregate.ts       # weighting + usage / army-share stats
    ui/                  # pages/components
    main.ts
  data/
    snapshots/           # dated normalized game-data snapshots (for diffs; git-ignored, newest 2 kept)
    meta/battles.jsonl   # raw deduped Legend I attacks (git-ignored)
    refresh-state.json   # last game-data check (git-ignored)
  public/
    meta.json            # aggregated meta the site reads (committed; the live site serves the pushed copy)
    data-changes.json    # latest game-data diff for the "Game data updated" banner (written by sync, committed)
  tests/
```

---

## 5. Normalized model

```ts
type Resource = 'gold' | 'elixir' | 'darkElixir' | 'goldOrElixir'
              | 'shinyOre' | 'glowyOre' | 'starryOre';

interface LevelInfo {
  level: number;
  cost: number;
  resource: Resource;
  timeSec: number;            // raw, unboosted
  thRequired?: number;
  heroHallRequired?: number;
  labRequired?: number;       // for lab items, if present in data
}

type Category = 'townHall' | 'thWeapon' | 'defense' | 'mergedDefense' | 'army'
  | 'resourceStorage' | 'resourceCollector' | 'trap' | 'wall' | 'hero'
  | 'troop' | 'spell' | 'siege' | 'pet' | 'equipment'
  | 'supercharge' | 'craftedDefense' | 'guardian' | 'helper';

interface Item {
  dataId: number;
  name: string;
  category: Category;
  queue: 'builder' | 'lab' | 'petHouse' | 'blacksmith';
  levels: LevelInfo[];
}

interface OwnedInstance {
  dataId: number;
  level: number;
  upgradingTo?: number;
  remainingSec?: number;
  goblin?: boolean;          // in-progress Goblin job: finishes, never rescheduled
}

interface Candidate {        // one possible next upgrade
  item: Item;
  instance: OwnedInstance;
  toLevel: number;
  tier: number;              // see §6
  timeSec: number;           // boosted time
  cost: number;
  resource: Resource;
  reason: string;            // short human-readable "why", shown in UI
}
```

- Max level of an item **at a given TH** = highest level whose `thRequired` ≤ TH (and `heroHallRequired` ≤ Hero Hall level for heroes).
- Max TH = highest Town Hall level in the data. Recomputed after every sync.

---

## 6. Priority engine

### 6.1 Modes
- **Rush mode:** player TH < max TH.
- **Max-TH mode:** player TH == max TH.
- Detected automatically. When a new TH ships and data syncs, the mode flips back to rush with no code change.

### 6.2 Tier 0 — Laboratory, new buildings, Archer Queen (both modes)
Tier 0 order: **Laboratory upgrade → new unbuilt buildings → Archer Queen.** Applies in rush and max-TH mode.
- **Laboratory upgrade ranks above everything.** Whenever the Laboratory has a next level available at the current TH and isn't already upgrading, it takes the next free builder. It never counts against the TH gate. (The Pet House stays in the offense tier.)
- **New unbuilt buildings come next.** Any building where owned count < `availablePerTownHall` count at the current TH (any category, including extra copies). A merge whose sources are already at the required level counts as a new building. Among several new buildings, order by the tier the building would normally belong to (offense before resources before defenses; merges and missing merge sources count as defenses), then longest first.
- **Archer Queen:** if she is not **book-ready** (§6.5) and not already upgrading, she gets the next free builder after the Laboratory and new buildings. She is always being upgraded otherwise and outranks the TH and everything below.

### 6.3 Rush mode tiers
1. **Town Hall path**
   - Town Hall upgrade itself, **as soon as the TH gate is clear** (below). Until then it isn't a candidate.
   - TH weapon levels. The weapon shares the Town Hall's builder lock, so it is only picked while the TH itself can't be upgraded (gated or maxed for now).
   - **TH gate — everything that must be done before the next TH upgrade:**
     - **Every available merge is performed:** source defenses at the required level (§7), then the merge itself. Applies to all merged defenses available at the current TH, not just ones new to it. Ordered by the TH that unlocked them (soonest first), then `merges.yaml` order. A merge holds the gate only if it can actually be performed at the current TH: enough source buildings exist and every one of them can reach the required level at this TH. A started merge counts as done.
     - **Every new building that can be built is built.** These are handled in Tier 0 (§6.2), so they're done before the gate is checked. A building under construction counts as built.
     - Upgrading merged defenses past level 1 is **not** part of the gate; that goes in the permanent-defense tier.
   - **While the Town Hall itself is upgrading** (not while only its weapon is): keep working the gate, and immediately start on the **next** TH's (TH+1 only) merge source upgrades if any are available at the current TH. These lookahead items rank in tier 1 after the current TH's gate items and never hold the gate.
2. **Offense, non-hero** — Army Camps, Barracks, Dark Barracks, Spell Factory, Dark Spell Factory, Clan Castle, Workshop, Blacksmith, Pet House, Hero Hall. (The Laboratory is Tier 0. The Hero Banner has no levels in the data.)
3. **Heroes** in configured order (default: Archer Queen > Grand Warden > Dragon Duke > Barbarian King > Royal Champion > Minion Prince), each only until book-ready. A hero capped by Hero Hall level is skipped (the next one in order is used).
4. **Resources** — Storages (Gold, Elixir, Dark Elixir), then Collectors (Gold Mine, Elixir Collector, Dark Elixir Drill).
5. **Permanent defenses** (incl. traps, X-Bow, Inferno, Eagle, Scattershot, Spell Tower, Monolith, etc.) — builder-efficiency order (§6.6).
6. **Temporary / last** — supercharges (defense and collector), crafted defenses, guardians. Builder-efficiency order. A supercharge is offered when its base building is at its **max level for the current TH** and the supercharge level's `townHallRequired` ≤ TH (so a newer TH adding base levels doesn't remove supercharges for players below it).

### 6.4 Max-TH mode tiers
0. Laboratory upgrade, then new buildings, then Archer Queen (as above)
1. Offense, non-hero
2. Heroes (same rules)
3. TH gate items (same rules as rush tier 1): merge source upgrades so every available merge can be performed. New buildings are already in Tier 0. Merged-defense upgrades past level 1 go in tier 5.
4. Resources (storages > collectors)
5. Permanent defenses, including TH weapon levels if the max TH has a weapon
6. Temporary (supercharges, crafted defenses, guardians)

### 6.5 Hero book threshold
- `BOOK_THRESHOLD = max(timeSec)` across **all hero levels in the data** (currently 8d).
- Compare the hero's **raw** next-level time to the threshold. Gold Pass scales both sides equally, so the raw comparison is correct in either toggle state.
- A hero whose next level's raw time ≥ threshold is **book-ready**. It drops out of scheduling and shows on a "Book-ready — your call" list with cost/time. The listed time is Gold-Pass boosted when the toggle is on (the threshold comparison itself stays raw).
- The threshold must not be hard-coded. If a patch adds longer hero levels, it updates on sync.

### 6.6 Within-tier ordering
- Tiers 1–3: the order defined above (merge order, building list order, hero order).
- Tier 4: storages before collectors; within each, lowest level first.
- **Tiers 5–6 (builder efficiency):** longest-time-first (LPT). This minimizes total time to finish the tier across N builders. Tie-break: cheaper first.
- Each building instance can only have one upgrade at a time. A hero being upgraded can't be picked again. Crafted-defense modules share their crafted defense's lock (one module at a time).
- **Research and building upgrades run fully in parallel.** The Laboratory can be upgraded while research runs, and research continues during a Laboratory upgrade; the same holds for the Pet House and pet research. Neither blocks the other in the scheduler.
- Resources are **not** a scheduling constraint in v1 (player resources unknown).

### 6.7 Lab queue
- Candidates: all troops, spells, siege machines with an available next level (respecting TH/lab level).
- **Lab tab: three sections — Troops, Spells, Sieges** — each ordered by its own meta score (§8.3) descending: troops and spells by share of housing space, sieges by usage share. **Unused items are still listed at the bottom of each section** (not greyed out), ordered by shortest time.
- **Lab queue pick (scheduler + 24h forecast):** normalize within kind, then weight:
  - `normScore = score ÷ top score of its kind`, where the top is the highest score of any unit of that kind in the Legend I meta (so each kind's Legend I #1 = 1.0; the player's best upgrade of a kind can be < 1.0).
  - `pickValue = normScore × kindWeight`, weights from settings `lab.kindWeights` (defaults: troops 1.0, spells 0.7, sieges 0.5).
  - **Weight 0 = never auto-pick that kind:** the scheduler and the 24h forecast never start an item of that kind on their own. Such items stay listed in their Lab tab section and sit at the bottom of the lab queue order. A pin overrides it (a pinned item is researched whatever its kind's weight).
  - The next lab upgrade is the highest `pickValue` across the kinds with weight > 0. Ties: used before unused, then higher `normScore`, then shortest time. Unused items (value 0) come last among them, shortest first.
  - Consecutive levels of the same unit are allowed (no repeat penalty).
- Player can pin overrides (move item to top of its section and of the lab queue, in pin order). Pinned items stay pinned until unpinned.
- **"Next in lab" line** at the top of the Lab tab: the pick, its kind, and its `pickValue` vs the top pick of the other two kinds (or "pinned"); if the lab is busy, when it starts.

### 6.8 Pet House queue
One list (no kinds, no weights): meta score (usage share) descending, unused at bottom (shortest first), pins allowed. Unchanged by the §6.7 lab pick.

### 6.9 Blacksmith (equipment)
- Upgrades are instant; the constraint is ore. Show a ranked list by meta score (= usage share) with ore costs per next level. Ore cost does not affect the order.
- Include ore totals in the forecast for the top-ranked items (see §10).

---

## 7. Merges

`config/merges.yaml` holds the recipes. Everything else is derived from data:
- **Unlock TH** = merged defense's first `availablePerTownHall` entry (or level 1 `townHallRequired`).
- **Count needed per TH** = merged defense's `availablePerTownHall[].count`.
- **Required source level** = the source defense's **max level at the merge's unlock TH**. Cannon and Archer Tower max out before they are fully merged. Levels a later TH adds to a source never raise the requirement for an older merge.
- **Source consumption check:** for each source, `count − countAfterMerges` at a TH must equal Σ(recipe inputs × merged count) across recipes using it. If it doesn't, the validation test fails. That means a new merge needs adding to `merges.yaml`.
  - The same check runs **in the browser** and shows a warning on the Plan tab until `merges.yaml` is fixed.
  - Until then, the planner **never suggests building copies** of an item that has `countAfterMerges` but no recipe (its raw count would ask for buildings that were merged away).

Current recipes (derived from TH17/18 counts — see `merges.yaml`):
- Ricochet Cannon = 2 Cannon (TH16)
- Multi-Archer Tower = 2 Archer Tower (TH16)
- Multi-Gear Tower = 1 Cannon + 1 Archer Tower (TH17)
- Super Wizard Tower = 2 Wizard Tower (TH18)

---

## 8. Meta pipeline (`npm run meta`)

### 8.1 Collect
1. Load token from `.env`. Fail with a clear message if missing.
2. Get locations; for each (global + countries), fetch player rankings (paginate as allowed). Keep players with `leagueTier.id === 105000036`. Dedupe tags. Stop at `meta.maxPlayers` (default 1000).
3. For each player: `GET /players/{tag}/battlelog`. Keep entries where `attack === true && battleType.toLowerCase() === 'legend'`.
4. **No Town Hall filter.** Legend I attackers are effectively max TH, and a troop used by a lower-TH Legend I player is still a valid recommendation.
5. Dedupe key: `playerTag + battleTimestamp`. Append new rows to `data/meta/battles.jsonl`: `{ tag, ts, stars, destruction, armyShareCode }`.
6. Throttle (~10 req/s, configurable). Retry 429/5xx/network errors with exponential backoff, using the server's `Retry-After` when it is longer (capped at 60 s). 401/403 abort the run. A location whose rankings keep failing is skipped and logged. Log progress.
7. Run **daily** (battle logs only reach back ~2 days). Automated by the `npm run dev` refresh (§9a), never by an OS scheduler. No patch-triggered runs.
8. **Resumable:** an interrupted run resumes within 24 h. Players a run couldn't fetch are retried first by the next run (if it starts within 7 days), so partial failures aren't lost to the daily cadence.

### 8.2 Parse `armyShareCode`
Port from the ClashKing `clashy.go` parser (`game.go: ParseArmyRecipe`). The payload may be a full link (`...?army=<payload>`) or raw.
- Sections start with a marker letter: `h` heroes, `u` troops, `s` spells, `i` Clan Castle troops, `d` Clan Castle spells.
- `u/s/i/d` items: `-`-separated `qtyxid` (e.g. `12x23`). Full dataId = base + id.
- `h` items: `-`-separated, regex `^(\d+)(?:m\d+)?(?:p(\d+))?(?:e(\d+)(?:_(\d+))?)?$` → hero id, pet id, equipment 1, equipment 2.
- Base IDs: troops `4000000`, spells `26000000`, heroes `28000000`, pets `73000000`, equipment `90000000`.
- **Siege machines usually appear in the Clan Castle section (`i`).** Count CC sieges toward siege usage. Ignore other CC troops/spells for usage.

### 8.3 Aggregate
- Window: last **14 days** of battles in `battles.jsonl`; drop older rows from aggregation (keep the file, or prune > 60 days).
- Recency weight: exponential decay, half-life **5 days** (configurable), so older metas fade fast. No "stale meta" warnings needed.
- For each troop / spell / siege / pet / equipment:
  - `usage` = weighted share of attacks that include it (0–1).
  - `threeStarRate` = weighted 3★ rate of attacks that include it.
  - `avgQty` for troops/spells.
  - `armyShare` for troops, super troops and spells (see below).
- **Meta score:**
  - **Troops:** average share of army housing space. Per attack: `(qty × housingSpace) ÷ total troop housing space in that army`, 0 if the troop isn't in it; then the weighted average across all attacks in the window using the recency weights above.
  - **Super troops** use their own housing space and count toward the base troop (base score = own + super, capped at 1).
  - **Spells:** same formula with spell housing space (÷ total spell space in that army).
  - **Sieges, pets, equipment:** plain `usage` (one siege per attack; pets/equipment are on or off).
  - Housing space comes from the game data (super troops: the `superTroop` block of the base troop file). A unit missing it is listed in the run summary and ranked by `usage` instead. Unknown IDs are left out of the per-attack totals.
  - A `meta.json` without `armyShare` (older file) falls back to `usage`.
- Keep `usage` and `threeStarRate` in the output for display and later tuning.
- Write `public/meta.json`: `{ generatedAt, windowDays, halfLifeDays, attacks, players, units: { [dataId]: { name, usage, threeStarRate, avgQty?, armyShare?, kind?, baseId? } } }`.

---

## 9. Game-data sync (`npm run sync`)

1. Install the newest `clash-of-clans-data` **within the current major** (never jump a major automatically). Record the version.
   - Load and validate it. If it can't be used (normalize throws, or levels are broken), **restore the last known-good version**, record the failure in `data/refresh-state.json`, and exit non-zero.
   - The `npm run dev` refresh (§9a) warns about the recorded failure on every start until a sync succeeds.
   - Merge-consumption and hero-cap findings are warnings, not failures (the site warns about merges itself, §7).
2. Normalize into the `Item` model; write `data/snapshots/<date>_<version>.json` (Item model only, no raw JSON or image paths), once per data version. Snapshots are ~0.3 MB each, so `data/snapshots/` is **git-ignored** and only the newest two are kept on disk.
3. Diff vs the newest snapshot of another version and print human-readable changes: new / removed items, new / removed levels, renames, and per-level cost, time and requirement changes. Examples: `Archer Tower 21: 18d → 16d`, `Gold Mine 17: 8M gold → 7.2M gold`, `NEW: Town Hall 19 (…)`, `NEW ITEM: …`, `REMOVED ITEM: …`. Items match by key (dataId), never by name. Equipment compares all three ores.
   - The diff is saved to `public/data-changes.json` (`{ version, previousVersion, date, changes[] }`). It's committed with `package.json` / `package-lock.json`, so the live site gets it too.
   - The Plan tab shows a dismissible **"Game data updated: N changes"** banner with the list when `data-changes.json` matches the bundled data version and that version hasn't been dismissed yet (dismissal is per version, in localStorage).
   - The first snapshot has nothing to compare with and writes no diff. A snapshot/diff failure is a warning, not a failed sync.
   - `npm run sync -- --offline` validates and snapshots the installed version without asking npm.
4. Run validation tests; print warnings (don't block the site):
   - Every dataId in a sample export resolves to an item.
   - Levels are contiguous and costs/times are non-negative.
   - **Hero cap mismatch:** Hero Hall `heroLevelCaps` vs per-level `heroHallLevelRequired` (known mismatch today — log, don't fail).
   - **Merge consumption check** (§7).
   - Max TH changed → print "mode may flip to rush".
5. Site footer shows: data version + snapshot date (from `data-changes.json` when it matches), meta `generatedAt`.

## 9a. Automatic refresh — no OS schedulers

The player never uses Windows Task Scheduler (or cron). Freshness comes from starting the site:

- `npm run dev` runs a `predev` refresh (`scripts/refresh.ts`) before Vite starts:
  1. **Game data:** if the last check was >24h ago (`data/refresh-state.json`, git-ignored), ask npm for the newest `clash-of-clans-data` within the installed major; if it is newer than the installed one, run the full `npm run sync`. A version that sync already recorded as unusable isn't reinstalled on every start; a newer release, or `npm run sync` by hand after a fix, retries.
  2. **Meta:** if `public/meta.json` (`generatedAt`) is >24h old or missing **and** `.env` has `COC_API_TOKEN`, run `npm run meta`. Staleness means "last aggregation" (`generatedAt`), so `npm run meta -- --aggregate-only` also resets the 24 h clock.
  3. **Any failure** (offline, 403, no token, sync error) prints a **one-line warning** and the site starts anyway. A failed check is retried on the next start. A meta run where some players failed counts as updated; those players are retried by the next run (§8.1).
  4. While sync has a recorded data failure, **every start** prints a one-line warning that the site is running on the last known-good data.
  5. After a meta pull that wrote `public/meta.json` (exit 0, or exit 2 = partial), print one line: `run npm run push-meta to update the live site`. The refresh **never pushes** by itself (§15).
- `npm run dev:fast` skips the refresh.
- The refresh runs only locally; the GitHub Pages workflow never runs it (§15).

---

## 10. Scheduler & 24h forecast

### 10.1 Scheduler
- Discrete-event simulation starting at "now" (export baseline + elapsed time). An export timestamp more than 5 minutes in the future is treated as "now" and reported as clock skew.
- **Ranked lists reflect "now":** the top builder priorities, lab / pet / equipment lists, "Next in lab" and the book-ready list use the state at "now", with every job that finished since the export applied.
- Resources: N builders, lab, pet house. **Goblin Builder / Goblin Researcher are never scheduled:** an in-progress Goblin job (`extra: true`) runs out its timer, but the Goblin is never given a new suggestion. In-progress upgrades occupy their slot until `remainingSec` elapses.
- When a slot frees: pick the highest-priority eligible candidate for that queue (§6), apply Gold Pass boost to its time, occupy the slot, then mark the instance's new level as the next candidate.
- Tier 0 rule: free builders take the Laboratory upgrade first (if available and not already upgrading), then new unbuilt buildings; then, if the Queen is eligible and not upgrading, the next free builder takes her.
- Research slots never wait for a Laboratory / Pet House building upgrade, and those upgrades never wait for research (§6.6).
- The lab slot starts the first pinned or auto-pickable item of the lab queue (§6.7); with nothing auto-pickable it stays idle.
- **Active boosts and helpers** (setting `simulateHelpers`, default on; off = raw timers as before):
  - **Boosts** run from the export time. Builder Potion = builders ×10, Research Potion = lab + pet house ×24, Builder Bite ×2, Study Soup ×4 (the snack values are assumptions; all live in `BOOST_MULTIPLIER`). They apply to running and new jobs while active, including Goblin jobs. The Clock Tower is Builder Base only and is ignored. Export timers are taken as remaining *work* time.
  - **Helpers:** the Builder's Apprentice (builder jobs) and the Lab Assistant (Laboratory research, not pets) each work one hour a day (1 h work + 23 h rest). In that hour the job runs at 1 + `workRate` speed, so it gains `workRate` hours (less if it finishes inside the hour). `workRate` comes from the helper's level in `other/helpers`; an unknown higher level uses the highest known level and shows a warning.
  - **When:** the first work hour is when the shared `helper_cooldown` ends (counted from the export; no cooldown = now), then every 24 h. Hours between the export and now apply to jobs that were running then. `helper_timer` on an upgrade = a helper already working on it: it adds the rest of that hour.
  - **Which job:** the job on the instance the export marks recurrent, if it's running. Otherwise the Apprentice takes the builder job with the most time left, and the Assistant takes the running research. Never a Goblin job (it frees no slot).
  - The Alchemist and Prospector don't affect timing.

### 10.2 Gold Pass toggle
- Two states: **No Gold Pass** / **Max Gold Pass**.
- Max applies the builder-time boost to builder upgrades **including supercharges**, and the research boost to lab/pet upgrades.
- Constant `GOLD_PASS_MAX_BOOST` in one place (verify the current % in-game before release — expected 20%).

### 10.3 Forecast output (next 24h)
- Sum cost by resource for every upgrade that **starts** within 24h in the simulation.
- Show a per-slot timeline: `B2 free 11:40 PM → Cannon 21 (3.0M gold)`.
- Show "needed by" times so the player knows which resource to farm first.
- Ore: sum ore for the top-N blacksmith picks (N configurable, default 3), counting only each piece's **next** level.
- Already-running upgrades are not counted (already paid).

### 10.4 Wall dump line
- Find the lowest wall level the player owns where the next level is available.
- Show: `Overflow → walls: Lv 17→18 costs X gold or elixir each; N walls at Lv 17.`

---

## 11. UI

Mobile-friendly layout (the player checks on a phone later), single page with tabs:

1. **Import & Settings** — paste export JSON → parse → save. Toggles: Gold Pass (none / max), **Simulate helpers and boosts** (§10.1). Hero order: drag to reorder on desktop, ↑ / ↓ buttons everywhere (touch), "Reset hero order to default", saved in localStorage. The UI says that the Archer Queen's Tier 0 rule belongs to the Queen, not to slot 1. Show import time and TH / mode detected.
2. **Plan** (default tab). The "Game data updated" banner (§9) sits on top when a new data version arrives.
   - "Now": what each free builder should start, with the `reason` string.
   - 24h timeline per slot.
   - Resources needed in 24h (gold, elixir, DE, each ore).
   - Book-ready heroes list.
   - Wall dump line.
3. **Lab / Pets / Equipment** — "Next in lab" line (§6.7), then Lab sections Troops / Spells / Sieges, Pet House, Blacksmith. Ranked lists with the meta score (army share for troops/spells), Legend I usage % and 3★ rate, pin buttons. Equipment rows show ore cost.
4. **Everything** — every upgrade left at the **current Town Hall** from "now", from one full scheduler run with the Town Hall frozen:
   - Builder upgrades grouped by the tier the engine assigns (with the tier name). Per tier: count, total builder time raw and with Gold Pass, cost per resource, and when the tier's last job finishes. Rows are summed per item (e.g. "Cannon · 14 upgrades · 19 → 21").
   - Totals on top: builder time to max from the scheduler (all builders, locks, tiers, helpers), shown for the current Gold Pass setting and the other one; Lab / Pet House done times; total cost per resource and total ore.
   - Laboratory, Pet House (scheduler order), Blacksmith (every remaining level up to the max at the final Blacksmith level, ore totals) and Walls (count × cost per level), each with its own totals.
   - **Not scheduled:** book-ready hero levels, lab kinds with weight 0, and in rush mode the next Town Hall. Not counted in time to max.
   - Each section is a collapsible `<details>` (closed by default) so a phone shows the totals first. It's computed when the tab opens, not on the 60 s refresh.
5. **Footer** — data version/date, meta date, "rerun `npm run sync` / `npm run meta`" hint.

---

## 12. Config files

- `config/merges.yaml` — recipes (§7).
- `config/settings.sample.yaml` — defaults loaded into the UI on first run. The UI persists edits to localStorage; the YAML is the reset point. Includes `lab.kindWeights` (troop / spell / siege, §6.7) and `simulateHelpers` (§10.1), both editable in the Settings tab. A saved hero order keeps its order, drops duplicates and gets any missing default hero appended.
- `config/id-overrides.yaml` — dataIds the game data is missing (§3.1).

---

## 13. Build steps

### Step 1 — Functional v1 (end-to-end test)
Goal: run `npm run dev`, paste a real export, and get a correct upgrade plan.
- Project scaffold (Vite + TS, Vitest, scripts wired up).
- Data layer: load `clash-of-clans-data`, normalize to the `Item` model (§5), merges from `merges.yaml` (§7).
- Export parser (§3.2) + dataId join.
- Full priority engine (§6): mode detection, Tier 0 Queen, all tiers for both modes, book threshold, merge logic incl. TH-upgrading lookahead, Hero Hall caps from per-level data.
- Scheduler + Gold Pass toggle + 24h forecast + wall dump (§10).
- Lab / pet / blacksmith ordering reads `public/meta.json`; ship a **stub meta.json** (empty `units`) so lists fall back to shortest-first until Step 2.
- UI: Import & Settings tab and Plan tab (§11), localStorage persistence, footer with data version.
- `npm run sync` minimal: update package, print version.
- Tests: export parsing, dataId join, Queen tier 0, book-ready cutoff, LPT ordering, rush vs max-TH tier order, TH-upgrading merge lookahead, forecast totals.

**Done when:** your own export produces a plan you agree with in-game.

### Step 2 — Legend I meta
- `npm run meta` (§8): collect, armyShareCode parser (port + tests from clashy.go), aggregation, real `meta.json`.
- Lab / Pets / Equipment tab with usage %, 3★ rate, and pins.

### Step 3 — Polish (done)
- Full `npm run sync`: snapshots, diffs, validation checks (§9).
- Everything tab (§11), hero order drag-reorder, active boosts and helpers in the scheduler (§10.1).
- **Item images** from `clash-of-clans-data/images/*` next to every item in the Plan, Lab / Pets / Equipment and Everything tabs (and the hero order list):
  - **one image per item**, chosen at build time by the `virtual:item-images` Vite plugin: the first of the item's candidates (icon, then level images from the top level down) that exists. No size cap. Only those images are bundled, not the folder. The account's levels are only known in the browser, so one image per item, not per level;
  - **resized at build time** (`vite build`, so also in the Pages workflow) with `sharp` (dev dependency) to **96×96 WebP** (fit inside, transparent padding, quality 80). Results are cached in `.cache/item-images/` (git-ignored), keyed by a hash of the source bytes plus the resize settings, so unchanged images are never reprocessed; icons no longer referenced are removed. The Pages workflow keeps that folder between runs with `actions/cache`. The dev server and tests use the original files (no sharp needed). An image that can't be read or resized is a build warning, and that item shows its name only;
  - lazy-load (`loading="lazy"`, `width`/`height` attributes so the layout doesn't jump), kept as separate files (never inlined into the JS);
  - text fallback: if an image is missing or fails to load (`onerror` removes the `<img>`), show the name only.

---

## 14. Verify during build

- ~~Export JSON: top-level timestamp field present?~~ → yes (`timestamp`). `boosts` shape: empty in the real export; the coc.py keys are supported (§3.2), so check the first export taken with a potion running.
- ~~`battleType === 'LEGEND'` corresponds to Legend League I battles~~ → resolved: lowercase `legend`, Legend I only (§3.3).
- ~~How many entries a battle log returns~~ → resolved: ~50 (~2 days), run daily (§3.3, §9a).
- Gold Pass max boost % (builder and research).
- **Hero Hall 13 releases Monday (Nov 16, 2026):** first real test of `npm run sync` + diff + cap logic.

---

## 15. Hosting (GitHub Pages) and v2+

### 15.1 GitHub Pages (done)

- **Live site:** https://tropicalhibi.github.io/Hibiscus-clash-advisor/ — the repo `TropicalHibi/Hibiscus-clash-advisor` is public. Pages source = "GitHub Actions".
- **Workflow** `.github/workflows/pages.yml`, on every push to `main` (and manual dispatch): `npm ci` → `npm test` → `npm run build:pages` → upload `dist/` → deploy. A failing test stops the job before the build, so nothing is deployed.
- **No token in CI.** The workflow never runs the predev refresh (it never calls `npm run dev`), `npm run meta`, `npm run sync` or `npm run push-meta`. The site ships the committed `public/meta.json` and the `clash-of-clans-data` version locked in `package-lock.json`.
- **Base path:** only `vite build --mode pages` uses base `/Hibiscus-clash-advisor/`; `npm run dev`, `npm run build` and tests stay at `/`. Every runtime fetch uses `import.meta.env.BASE_URL` (§2).
- **Meta on the site:** the live site only gets new meta when `public/meta.json` is pushed. `npm run push-meta` commits that file alone (`meta: <generatedAt>`) and pushes `main` if it changed; it does nothing when unchanged and refuses off `main`. The predev refresh reminds after a successful meta pull (§9a step 5) but never pushes.
- **Game-data updates** reach the site the same way: `npm run sync` locally updates `package.json` / `package-lock.json`; committing and pushing them redeploys.
- **Privacy:** user data stays in each browser's `localStorage`; nothing is uploaded. Committed fixtures are redacted (§8.1 / `scripts/lib/redact.ts`); `.env`, `samples/`, `battles.jsonl` and run-state files are git-ignored and were never committed.

### 15.2 v2+ (not now)

- GitHub Actions on a schedule: daily version check / rebuild, daily meta (needs an API key that isn't IP-locked to the home network).
- Sleep/awake windows for finish-time fitting.
- Multi-device state.
- Builder Base / Clan Capital.
