# CoC Upgrade Planner — v1 Spec

A local website that reads a Clash of Clans account export and tells the player what to upgrade next, following a rush-first priority system. It also produces a 24-hour resource "shopping list" and lab/pet/equipment picks ranked by Legend League I usage.

**v1 = runs locally on Windows.** No hosting, no accounts, no backend. Hosting and automation are v2+.

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

**Out of scope (v1, revisit later)**
- Builder Base, Clan Capital.
- Sleep/awake windows for timing finishes.
- Hosting, GitHub Actions, multi-device sync.
- Entering current resources.

---

## 2. Stack

- **Vite + TypeScript** single-page app. `npm run dev` → `http://localhost:5173`.
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
| `npm run sync` | Update game data, run validation, print diff vs last snapshot |
| `npm run meta` | Pull Legend I battle logs, aggregate, write `public/meta.json` |
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

**Known data quirk:** Hero Hall `heroLevelCaps` is stale (says Archer Queen cap 105 at Hero Hall 12; in-game max is 110). **Derive hero caps from each hero level's `heroHallLevelRequired`, not from the Hero Hall's cap table.** Validation test (§9) logs the mismatch.

### 3.2 Account state — in-game export JSON
- Player copies it from in-game settings and pastes it into the site.
- Shape (from coc.py 4.0 `AccountData` parser): top-level sections are lists — `buildings`, `traps`, `heroes`, `troops`, `spells`, `pets`, `equipment`, `guardians`, `helpers`, `decorations`, `obstacles`, etc. Sections ending in `2` (e.g. `buildings2`) are Builder Base → ignore in v1.
- Item fields: `data` (dataId), `lvl`, `cnt` (number of instances at that level), `timer` (seconds remaining if upgrading), `extra` (true = Goblin Builder), `helper_timer`, `recurrent_helper`.
- Top-level `boosts` object: builder boost, lab boost, clock tower, etc.
- **No resource amounts** — that's why the forecast reports totals needed, not a deficit.
- **Verify on first real export:** is there a top-level timestamp? If yes, timers count down from it. If not, use the paste time as the baseline and show "imported at HH:MM".
- Builder count = number of Builder's Huts in `buildings`. Goblins are never counted as schedulable slots (§10.1).

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
  config/
    merges.yaml          # merge recipes (hand-maintained)
    settings.sample.yaml # defaults the UI starts from
  scripts/
    sync.ts              # npm run sync
    meta.ts              # npm run meta
    refresh.ts           # predev refresh (§9a)
  src/
    data/                # load + normalize clash-of-clans-data into Item model
    state/               # parse export JSON → AccountState
    engine/
      tiers.ts           # mode detection + tier assignment + eligibility
      scheduler.ts       # simulate builders/lab/pet house
      forecast.ts        # 24h needs + wall dump
      book.ts            # hero book-threshold logic
    meta/
      armyCode.ts        # armyShareCode parser
      aggregate.ts       # weighting + usage / army-share stats
    ui/                  # pages/components
    main.ts
  data/
    snapshots/           # dated normalized game-data snapshots (for diffs)
    meta/battles.jsonl   # raw deduped Legend I attacks (git-ignored)
    refresh-state.json   # last game-data check (git-ignored)
  public/
    meta.json            # aggregated meta the site reads
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

### 6.2 Tier 0 — New buildings + Archer Queen (both modes)
- **New unbuilt buildings come first.** Any building where owned count < `availablePerTownHall` count at the current TH (any category, including extra copies). A merge whose sources are already at the required level counts as a new building. Among several new buildings, order by the tier the building would normally belong to (offense before resources before defenses), then longest first.
- **Archer Queen:** if she is not **book-ready** (§6.5) and not already upgrading, she gets the next free builder after new buildings. She is always being upgraded otherwise and outranks the TH and everything below.

### 6.3 Rush mode tiers
1. **Town Hall path**
   - Town Hall upgrade itself (as soon as it's available).
   - TH weapon levels.
   - **TH gate — everything that must be done before the next TH upgrade:**
     - **Every available merge is performed:** source defenses at the required level (§7), then the merge itself. Applies to all merged defenses available at the current TH, not just ones new to it. Ordered by the TH that unlocked them (soonest first).
     - **Every new building that can be built is built.** These are handled in Tier 0 (§6.2), so they're done before the gate is checked.
     - Upgrading merged defenses past level 1 is **not** part of the gate; that goes in the permanent-defense tier.
   - **While the TH is upgrading:** keep working the gate, and immediately start on the **next** TH's merge source upgrades if any are available at the current TH.
2. **Offense, non-hero** — Laboratory, Army Camps, Barracks, Dark Barracks, Spell Factory, Dark Spell Factory, Clan Castle, Workshop, Blacksmith, Pet House, Hero Hall, Hero Banner.
3. **Heroes** in configured order (default: Archer Queen > Grand Warden > Dragon Duke > Barbarian King > Royal Champion > Minion Prince), each only until book-ready. A hero capped by Hero Hall level is skipped (the next one in order is used).
4. **Resources** — Storages (Gold, Elixir, Dark Elixir), then Collectors (Gold Mine, Elixir Collector, Dark Elixir Drill).
5. **Permanent defenses** (incl. traps, X-Bow, Inferno, Eagle, Scattershot, Spell Tower, Monolith, etc.) — builder-efficiency order (§6.6).
6. **Temporary / last** — supercharges (defense and collector), crafted defenses, guardians. Builder-efficiency order.

### 6.4 Max-TH mode tiers
0. New buildings, then Archer Queen (as above)
1. Offense, non-hero
2. Heroes (same rules)
3. TH gate items (same rules as rush tier 1): merge source upgrades so every available merge can be performed. New buildings are already in Tier 0. Merged-defense upgrades past level 1 go in tier 5.
4. Resources (storages > collectors)
5. Permanent defenses
6. Temporary (supercharges, crafted defenses, guardians)

### 6.5 Hero book threshold
- `BOOK_THRESHOLD = max(timeSec)` across **all hero levels in the data** (currently 8d).
- Compare the hero's **raw** next-level time to the threshold. Gold Pass scales both sides equally, so the raw comparison is correct in either toggle state.
- A hero whose next level's raw time ≥ threshold is **book-ready**. It drops out of scheduling and shows on a "Book-ready — your call" list with cost/time.
- The threshold must not be hard-coded. If a patch adds longer hero levels, it updates on sync.

### 6.6 Within-tier ordering
- Tiers 1–3: the order defined above (merge order, building list order, hero order).
- Tier 4: storages before collectors; within each, lowest level first.
- **Tiers 5–6 (builder efficiency):** longest-time-first (LPT). This minimizes total time to finish the tier across N builders. Tie-break: cheaper first.
- Each building instance can only have one upgrade at a time. A hero being upgraded can't be picked again.
- Resources are **not** a scheduling constraint in v1 (player resources unknown).

### 6.7 Lab queue
- Candidates: all troops, spells, siege machines with an available next level (respecting TH/lab level).
- Order by meta score (§8) descending. **Unused items are still listed at the bottom** (not greyed out), ordered by shortest time.
- Siege machines are ranked by the same meta score. Sieges with high Legend I usage rank high.
- Player can pin overrides (move item to top). Pinned items stay pinned until unpinned.

### 6.8 Pet House queue
Same as lab: meta score descending, unused at bottom, pins allowed.

### 6.9 Blacksmith (equipment)
- Upgrades are instant; the constraint is ore. Show a ranked list by meta score (= usage share) with ore costs per next level. Ore cost does not affect the order.
- Include ore totals in the forecast for the top-ranked items (see §10).

---

## 7. Merges

`config/merges.yaml` holds the recipes. Everything else is derived from data:
- **Unlock TH** = merged defense's first `availablePerTownHall` entry (or level 1 `townHallRequired`).
- **Count needed per TH** = merged defense's `availablePerTownHall[].count`.
- **Required source level** = max level of the source defense in the data. Cannon and Archer Tower max out before they are fully merged.
- **Source consumption check:** for each source, `count − countAfterMerges` at a TH must equal Σ(recipe inputs × merged count) across recipes using it. If it doesn't, the validation test fails. That means a new merge needs adding to `merges.yaml`.

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
6. Throttle (~10 req/s, configurable). Retry 429/5xx with exponential backoff. Log progress.
7. Run **daily** (battle logs only reach back ~2 days). Automated by the `npm run dev` refresh (§9a), never by an OS scheduler. No patch-triggered runs.

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

1. `npm update clash-of-clans-data` (or install latest). Record version.
2. Normalize into the `Item` model; write `data/snapshots/<date>_<version>.json`.
3. Diff vs the previous snapshot and print human-readable changes, e.g. `Archer Tower 21: 18d → 16d`, `Gold Mine 17: 8.0M → 7.2M`, `NEW: Hero Hall 13`.
4. Run validation tests; print warnings (don't block the site):
   - Every dataId in a sample export resolves to an item.
   - Levels are contiguous and costs/times are non-negative.
   - **Hero cap mismatch:** Hero Hall `heroLevelCaps` vs per-level `heroHallLevelRequired` (known mismatch today — log, don't fail).
   - **Merge consumption check** (§7).
   - Max TH changed → print "mode may flip to rush".
5. Site footer shows: data version + snapshot date, meta `generatedAt`.

## 9a. Automatic refresh — no OS schedulers

The player never uses Windows Task Scheduler (or cron). Freshness comes from starting the site:

- `npm run dev` runs a `predev` refresh (`scripts/refresh.ts`) before Vite starts:
  1. **Game data:** if the last check was >24h ago (`data/refresh-state.json`, git-ignored), ask npm for the newest `clash-of-clans-data`; if it is newer than the installed one, run the full `npm run sync`.
  2. **Meta:** if `public/meta.json` (`generatedAt`) is >24h old or missing **and** `.env` has `COC_API_TOKEN`, run `npm run meta`.
  3. **Any failure** (offline, 403, no token, sync error) prints a **one-line warning** and the site starts anyway. A failed check is retried on the next start.
- `npm run dev:fast` skips the refresh.

---

## 10. Scheduler & 24h forecast

### 10.1 Scheduler
- Discrete-event simulation starting at "now" (export baseline + elapsed time).
- Resources: N builders, lab, pet house. **Goblin Builder / Goblin Researcher are never scheduled:** an in-progress Goblin job (`extra: true`) runs out its timer, but the Goblin is never given a new suggestion. In-progress upgrades occupy their slot until `remainingSec` elapses.
- When a slot frees: pick the highest-priority eligible candidate for that queue (§6), apply Gold Pass boost to its time, occupy the slot, then mark the instance's new level as the next candidate.
- Tier 0 rule: free builders take new unbuilt buildings first; then, if the Queen is eligible and not upgrading, the next free builder takes her.
- Active boosts and helpers (Builder's Apprentice, Lab Assistant) are Step 3. Until then, use raw remaining timers.

### 10.2 Gold Pass toggle
- Two states: **No Gold Pass** / **Max Gold Pass**.
- Max applies the builder-time boost to builder upgrades **including supercharges**, and the research boost to lab/pet upgrades.
- Constant `GOLD_PASS_MAX_BOOST` in one place (verify the current % in-game before release — expected 20%).

### 10.3 Forecast output (next 24h)
- Sum cost by resource for every upgrade that **starts** within 24h in the simulation.
- Show a per-slot timeline: `B2 free 11:40 PM → Cannon 21 (3.0M gold)`.
- Show "needed by" times so the player knows which resource to farm first.
- Ore: sum ore for the top-N blacksmith picks (N configurable, default 3).
- Already-running upgrades are not counted (already paid).

### 10.4 Wall dump line
- Find the lowest wall level the player owns where the next level is available.
- Show: `Overflow → walls: Lv 17→18 costs X gold or elixir each; N walls at Lv 17.`

---

## 11. UI

Mobile-friendly layout (the player checks on a phone later), single page with tabs:

1. **Import & Settings** — paste export JSON → parse → save. Toggles: Gold Pass (none / max). Hero order (drag to reorder, default as §6.3). Show import time and TH / mode detected.
2. **Plan** (default tab)
   - "Now": what each free builder should start, with the `reason` string.
   - 24h timeline per slot.
   - Resources needed in 24h (gold, elixir, DE, each ore).
   - Book-ready heroes list.
   - Wall dump line.
3. **Lab / Pets / Equipment** — ranked lists with the meta score (army share for troops/spells), Legend I usage % and 3★ rate, pin buttons. Equipment rows show ore cost.
4. **Everything** — all remaining upgrades grouped by tier, with time-to-max per tier and total cost per resource.
5. **Footer** — data version/date, meta date, "rerun `npm run sync` / `npm run meta`" hint.

---

## 12. Config files

- `config/merges.yaml` — recipes (§7).
- `config/settings.sample.yaml` — defaults loaded into the UI on first run. The UI persists edits to localStorage; the YAML is the reset point.

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

### Step 3 — Polish
- Full `npm run sync`: snapshots, diffs, validation checks (§9).
- Everything tab (§11), hero order drag-reorder, active boosts and helpers in the scheduler.

---

## 14. Verify during build

- Export JSON: top-level timestamp field present? exact `boosts` shape?
- ~~`battleType === 'LEGEND'` corresponds to Legend League I battles~~ → resolved: lowercase `legend`, Legend I only (§3.3).
- ~~How many entries a battle log returns~~ → resolved: ~50 (~2 days), run daily (§3.3, §9a).
- Gold Pass max boost % (builder and research).
- **Hero Hall 13 releases Monday (Nov 16, 2026):** first real test of `npm run sync` + diff + cap logic.

---

## 15. v2+ (not now)

- Hosting (GitHub Pages or similar) + GitHub Actions: daily version check / rebuild, daily meta.
- Sleep/awake windows for finish-time fitting.
- Multi-device state.
- Builder Base / Clan Capital.
