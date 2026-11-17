# CoC Upgrade Planner — v1 Spec

A local website that reads a Clash of Clans account export and tells the player what to upgrade next, following a rush-first priority system. It also produces a 24-hour resource "shopping list" and lab/pet/equipment picks ranked by Legend League I usage.

**v1 = runs locally on Windows**, and the same static site is also published to **GitHub Pages** (§15): https://tropicalhibi.github.io/Hibiscus-clash-advisor/. No accounts, no backend. Game data (§9b) and the Legend I meta (§8.4) are kept current on the live site by daily GitHub Actions. The meta Action logs in to the developer site to get a key for its own IP, so an IP-locked key is no longer a problem.

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
- Multi-device sync. (The daily game-data update (§9b) and the daily meta (§8.4) are in scope.)
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
| `npm run sync` | Update game data (ClashKing, pinned in `data/clashking/`; clash-of-clans-data for images / backup), run validation, snapshot it, print the diff vs the last snapshot and the ClashKing vs clash-of-clans-data cross-check (`-- --offline`: no GitHub / npm, validate + snapshot what's pinned and installed) |
| `npm run meta` | Pull Legend I battle logs, aggregate, write `public/meta.json` |
| `npm run push-meta` | Commit `public/meta.json` (only that file) as `meta: <generatedAt>` and push `main`, if it changed — redeploys the live site (§15) |
| `npm run build` | Typecheck + production build at base `/` |
| `npm run build:pages` | Same, at the GitHub Pages base `/Hibiscus-clash-advisor/` (used by CI) |
| `npm test` | Unit + validation tests |

---

## 3. Data sources

### 3.1 Game data — ClashKing static data (primary), `clash-of-clans-data` (images, TH weapons, backup)

**Primary: `static/static_data.json` from [ClashKingInc/clashy.go](https://github.com/ClashKingInc/clashy.go).**
- `npm run sync` and the daily Action (§9, §9b) download it from the **latest release tag** (main when no release has the file), **at that tag's commit**, and pin it in `data/clashking/` (committed): `static_data.json` (trimmed to the sections below, home village only, no `info` / `TID` text) and `pin.json` (`repo`, `ref`, `tag`, `commit`, `sha256` of the downloaded file, `version` such as `clashking-v0.1.20` or `clashking-main-<sha7>`, `fetchedAt`, `maxTH`, `items`). The site and the scripts only ever read the pinned copy.
- Sections used: `buildings`, `traps`, `troops` (incl. siege machines: `production_building: "Workshop"`), `spells`, `heroes`, `pets`, `equipment`, `guardians`, `helpers`.
- Each entry's **`_id`** is the dataId used in the account export. **Join on dataId, never on names.** Item ids (`cannon`, `archer-queen`, …) are slugs of the names (`Builder's Hut` → `builders-hut`, `P.E.K.K.A` → `pekka`), the same as the old clash-of-clans-data file ids.
- **Level semantics** (verified level by level against clash-of-clans-data, DECISIONS):
  - buildings, traps, crafted-defense modules, supercharges: `build_cost` / `build_time` (seconds) on level N = the cost and time **of level N**;
  - troops, spells, heroes, pets, guardians, equipment: `upgrade_cost` / `upgrade_time` on level N = the cost of going **N → N+1**, so level N's cost and time are taken from row N−1 and level 1 costs nothing. Equipment `upgrade_cost` is `{shiny_ore, glowy_ore, starry_ore}`;
  - every `required_*` field on level N (`required_townhall`, `required_hero_tavern_level`, `required_lab_level`, `required_pet_house_level`, `required_blacksmith_level`) is the requirement **to have level N** (not shifted). Equipment keeps only the Blacksmith requirement, heroes only the Hero Hall requirement (both are TH-gated themselves), as before.
- Resources: the item's `upgrade_resource`; a level with `alt_upgrade_resource` (walls) costs gold **or** elixir. Troops and spells carry `housing_space`.
- **Supercharges:** the `supercharge` block on a building's top level (`upgrade_resource`, `required_townhall`, `levels[]`) becomes the `<id>:sc` item.
- **Building counts per TH** = running sum of the Town Hall levels' `unlocks[].quantity` (pre-merge totals). A Town Hall level with its own `merge_requirement` absorbs those buildings (TH17 takes the Eagle Artillery). Guardians count 1 from their first level's TH.
- **TH upgrade requirements:** any building level a Town Hall level lists (any array on the level whose entries name a building or trap `_id` with a `level`; today TH17's `merge_requirement`: Eagle Artillery 7) is required before upgrading to that TH. They go into the TH gate (§6.3). Read generically: no building is hard-coded. The clash-of-clans-data backup has none.
- **Merges:** a building whose **level 1** has `merge_requirement` is a merged defense; the entries name the sources and their **exact** required levels (2 entries of the same `_id` = 2 copies). Counts after merges are derived (§7).
- **Super troops:** troops with `super_troop {original_id, original_min_level}` have their own dataId and housing space and are credited to the base troop (§8.3). They are not lab items.
- **Seasonal units** (`is_seasonal`): recognised (no unknown-id warning) but never in the lab queue, the Lab tab or the meta.
- **Crafting Station:** `seasonal_defenses[].modules[]` → one item per module (`<defense>:m<module>`), with their own levels and TH requirements.
- **Helpers:** `boost_multiplier` per level = the Builder's Apprentice / Lab Assistant work rate (hours of progress per work hour, §10.1). The Alchemist and Prospector are recognised but don't affect timing.
- **TH weapons are not in ClashKing's data**: they're taken from clash-of-clans-data's `town-hall.json`.
- ClashKing has no Hero Hall cap table: hero caps come from each level's `required_hero_tavern_level` (as before).

**Optional overrides** (`config/merges.yaml`, `config/super-troops.yaml`, `config/id-overrides.yaml`, §12) ship **empty**. An entry that exists **wins** over the data (a differing dataId is a warning; two items on one dataId too).

**`clash-of-clans-data` (npm, `chiefpansancolt/clash-of-clans-data`)** stays a dependency for:
- **Item images:** `images.icon` or per-level `levels[].images.normal`, matched to ClashKing items by item id, then dataId. The files are WebP saved as `.png`, some up to 4096 px, so the build resizes them (§13 Step 3). Items only ClashKing has show their name only.
- **TH weapon levels** (above).
- **Backup source:** if there is no usable ClashKing copy (missing, or the pinned file can't be loaded), the planner normalizes clash-of-clans-data instead (its `availablePerTownHall`, `buildCost`/`researchCost`, `townHallRequired`, …) and shows a **visible warning** on the Plan tab, in `npm run sync` and on every `npm run dev`. Its merge recipes, super-troop table and the Alchemist's dataId (which it lacks) are built in (`src/data/cocDataBackup.ts`, frozen at 0.19.1); the override files still win. In the browser it's a separate chunk, fetched only then.
- The cross-check report (§9).

**Known clash-of-clans-data quirks** (backup only now): Hero Hall `heroLevelCaps` is stale (Archer Queen cap 105 at Hero Hall 12; in-game max 110), so hero caps come from per-level requirements; Monolith Arrow / Electro Fangs and Alchemist / Prospector have swapped dataIds (ClashKing's match the army codes and the export).

### 3.2 Account state — in-game export JSON
- Player copies it from in-game settings and pastes it into the site.
- Shape (from coc.py 4.0 `AccountData` parser): top-level sections are lists — `buildings`, `traps`, `heroes`, `troops`, `spells`, `pets`, `equipment`, `guardians`, `helpers`, `decorations`, `obstacles`, etc. Sections ending in `2` (e.g. `buildings2`) are Builder Base → ignore in v1.
- Item fields: `data` (dataId), `lvl`, `cnt` (number of instances at that level), `timer` (seconds remaining if upgrading), `extra` (true = Goblin Builder), `helper_timer` (seconds left of a helper's work hour on this upgrade), and the recurrent-helper flag. The real export spells it **`helper_recurrent`**; coc.py documents `recurrent_helper`. Both are accepted.
- `helpers` section: `{ data, lvl, helper_cooldown }`. All helpers share one cooldown (seconds until they can be assigned again), as in coc.py.
- **Unknown ids:** an entry whose dataId isn't in the game data is a Plan-tab warning. If it has a `timer`, it still **occupies its slot** until the timer runs out, and the timeline shows it as `Unknown item <dataId> (not in game data yet)`. Buildings, traps, heroes, guardians and crafted-defense modules hold a builder; units, spells and sieges the lab; pets the pet house; with `extra: true`, a goblin slot. Example: a new building from a patch newer than the data, under construction at level 0.
- Top-level `boosts` object, keys as in coc.py's `Boosts` (seconds at the export time): `builder_boost` (seconds of Builder Potion left), `lab_boost` (Research Potion), `builder_consumable` (Builder Bite), `lab_consumable` (Study Soup), `clocktower_boost`, `clocktower_cooldown` (a **cooldown**, not an active boost), `helper_cooldown`. The Pet Potion's key isn't documented; `pet_boost` is assumed. Seen in a real export: `{"builder_boost": 3578, "clocktower_cooldown": 16501}`. Unknown keys or shapes produce a Plan-tab warning, never an error.
- **No resource amounts** — that's why the forecast reports totals needed, not a deficit.
- **Verify on first real export:** is there a top-level timestamp? If yes, timers count down from it. If not, use the paste time as the baseline and show "imported at HH:MM".
- Builder count = Builder's Huts (Σ `cnt`) + B.O.B's Hut in `buildings`. Goblins are never counted as schedulable slots (§10.1).

### 3.3 Official API — meta pipeline only
- Base URL `https://api.clashofclans.com/v1`. The bearer token comes from a developer-site login (`COC_DEV_EMAIL` / `COC_DEV_PASSWORD`, a key created for the current IP) or, without a login, from `.env` (`COC_API_TOKEN`, locked to one IP). See §8.1.
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
    data-update.yml      # daily ClashKing + clash-of-clans-data update → commit → deploy, or an issue (§9b)
  config/
    merges.yaml          # optional merge-recipe overrides (ships empty; ClashKing has the merges)
    super-troops.yaml    # optional super-troop overrides (ships empty)
    id-overrides.yaml    # optional dataId overrides (ships empty)
    settings.sample.yaml # defaults the UI starts from
  scripts/
    sync.ts              # npm run sync
    meta.ts              # npm run meta
    refresh.ts           # predev refresh (§9a)
    data-update.ts       # the daily data-update Action's steps (§9b)
    push-meta.ts         # npm run push-meta (§15)
    meta-ci.ts           # the daily meta Action's steps (§8.4)
  src/
    data/                # load + normalize ClashKing (clashking.ts) or the clash-of-clans-data backup (normalize.ts) into the Item model; overrides, cross-check
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
    clashking/           # pinned ClashKing static data: static_data.json (trimmed) + pin.json (committed, §3.1)
    snapshots/           # dated normalized game-data snapshots (for diffs; git-ignored, newest 2 kept)
    meta/battles.jsonl   # raw deduped Legend I attacks (git-ignored; the Action keeps its own copy on the meta-data branch, §8.4)
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
  cost: number;               // cost of reaching this level (ClashKing: build_cost, or the previous row's upgrade_cost, §3.1)
  resource: Resource;
  timeSec: number;            // raw, unboosted, seconds
  thRequired?: number;        // required_townhall
  heroHallRequired?: number;  // required_hero_tavern_level
  labRequired?: number;       // required_lab_level
  petHouseRequired?: number;  // required_pet_house_level
  blacksmithRequired?: number;// required_blacksmith_level
  ore?: { shinyOre: number; glowyOre: number; starryOre: number }; // equipment
}

type Category = 'townHall' | 'thWeapon' | 'defense' | 'mergedDefense' | 'army'
  | 'resourceStorage' | 'resourceCollector' | 'trap' | 'wall' | 'hero'
  | 'troop' | 'spell' | 'siege' | 'pet' | 'equipment'
  | 'supercharge' | 'craftedDefense' | 'guardian' | 'helper';

interface Item {
  dataId: number;
  id: string;                // slug of the name, e.g. "cannon"
  name: string;
  category: Category;
  queue: 'builder' | 'lab' | 'petHouse' | 'blacksmith' | 'none';
  levels: LevelInfo[];
  countPerTH?: Record<number, number>;            // cumulative Town Hall unlocks
  countAfterMergesPerTH?: Record<number, number>; // merge sources (§7)
  housingSpace?: number; superHousingSpace?: number;
  helperWorkRates?: Record<number, number>;
  seasonal?: boolean;        // is_seasonal: never in the lab queue or the meta
}
// GameData also carries: source ('clashking' | 'clash-of-clans-data'), version (e.g. "clashking-v0.1.20"),
// maxTH, bookThresholdSec, merges (§7), superTroops (dataId → base troop),
// thRequirements (TH level → [{ id, dataId, level, qty }], §6.3), warnings.

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
     - **Every available merge is performed:** source defenses at the required level (§7), then the merge itself. Applies to all merged defenses available at the current TH, not just ones new to it. Ordered by the TH that unlocked them (soonest first), then recipe order (the former `merges.yaml` order — Ricochet Cannon, Multi-Archer Tower, Multi-Gear Tower, Super Wizard Tower — then newer merges in Town Hall `unlocks` order). A merge holds the gate only if it can actually be performed at the current TH: enough source buildings exist and every one of them can reach the required level at this TH. A started merge counts as done.
     - **Every new building that can be built is built.** These are handled in Tier 0 (§6.2), so they're done before the gate is checked. A building under construction counts as built.
     - **Every building level the next TH requires is reached** (§3.1 TH upgrade requirements, e.g. "TH17 requires Eagle Artillery 7"). The highest copies of that building (as many as required) are upgraded as tier-1 gate items, after the merge-source items, with that text as the reason. An upgrade in progress doesn't count until it finishes. Like a merge, a requirement holds the gate only if it can be met at the current TH (enough copies, level reachable). Once met, the Town Hall's reason lists it ("TH17 requirements met: Eagle Artillery 7").
     - Upgrading merged defenses past level 1 is **not** part of the gate; that goes in the permanent-defense tier.
   - **While the Town Hall itself is upgrading** (not while only its weapon is): keep working the gate, and immediately start on the **next** TH's (TH+1 only) merge source upgrades if any are available at the current TH, and on the building levels required by the TH after the one being reached (e.g. upgrading TH15 → 16: "TH-upgrade lookahead: TH17 requires Eagle Artillery 7"), as far as the current TH allows. These lookahead items rank in tier 1 after the current TH's gate items and never hold the gate.
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
- **Ore is never forecast.** It's time-gated (daily attacks, wars, raids, events): you can't farm it on demand, so a "needed in 24 h" ore total would be meaningless. Each row shows the next level's **ore cost** (informational, no "needed by" time) on the Lab / Pets / Equipment tab, and in the `npm run plan` Blacksmith list. The Everything tab's Blacksmith section totals the remaining ore, also informational.

---

## 7. Merges

The recipes come from **ClashKing's data**: the merged defense's **level-1 `merge_requirement`** (one entry per source copy, with the exact level). A new merge in a data release needs no hand edit. `config/merges.yaml` is an optional override (ships empty): an entry for a merged defense **replaces** the data's recipe (`sources: [{ id, qty, level? }]`).
- **Unlock TH** = the merged defense's first TH with a count (cumulative Town Hall `unlocks`), or its level-1 TH requirement.
- **Count needed per TH** = the merged defense's count per TH.
- **Required source level** = the level in `merge_requirement` (or the override's `level`). Without one (the clash-of-clans-data backup, or an override without `level`), the source's **max level at the merge's unlock TH**. Either way, levels a later TH adds to a source never raise the requirement for an older merge.
- **Counts after merges** (sources): count − Σ(recipe qty × merged count) at each TH from the first merge's unlock TH. (ClashKing's counts are pre-merge totals; the derived values equal clash-of-clans-data's `countAfterMerges` at TH16–18.) `geared_up` in `merge_requirement` is informational: gear-ups aren't modelled.
- **Source consumption check:** for each source, `count − countAfterMerges` at a TH must equal Σ(recipe inputs × merged count) across recipes using it. With ClashKing it holds by construction; it still catches a bad override, and on the clash-of-clans-data backup (whose recipes are built in) a merge the recipes don't know. The daily Action fails on it (§9b).
  - The same check runs **in the browser** and shows a warning on the Plan tab until it's fixed (an entry in `config/merges.yaml`).
  - Until then, the planner **never suggests building copies** of an item that has `countAfterMerges` but no recipe (its raw count would ask for buildings that were merged away).

Current recipes (ClashKing v0.1.20):
- Ricochet Cannon = 2 Cannon 21 (TH16)
- Multi-Archer Tower = 2 Archer Tower 21 (TH16)
- Multi-Gear Tower = 1 Cannon 21 + 1 Archer Tower 21, both geared up (TH17)
- Super Wizard Tower = 2 Wizard Tower 17 (TH18)
- **Firecracker Tower = 1 Archer Tower 21 + 1 Scattershot 7 (TH19, 2 of them)** — new; at TH19 every Archer Tower is merged.

---

## 8. Meta pipeline (`npm run meta`)

### 8.1 Collect
1. **Get a token** (`scripts/lib/auth.ts`). Fail with a clear message if there are no credentials.
   - **Login** (preferred): with `COC_DEV_EMAIL` + `COC_DEV_PASSWORD` (repository secrets in CI, `.env` locally), `clashofclans.js` logs in to developer.clashofclans.com and returns a key for the current public IP under a **dedicated key name**: `hibiscus-ci` in GitHub Actions, `hibiscus-local` on the PC. It only revokes or creates keys with that exact name, so the owner's other keys are never touched, and a changed IP just replaces that one key. Only the token is taken from clashofclans.js; collection stays on the project's own raw-HTTP client.
   - **Fallback:** `COC_API_TOKEN` from `.env` (a fixed key for one IP), as before.
   - The email, password and token are never printed. In GitHub Actions the token is masked (`::add-mask::`) the moment it exists. Error messages are redacted: secrets, JWT-like strings, email addresses, player tags and IPs are removed.
2. Get locations; for each (global + countries), fetch player rankings (paginate as allowed). Keep players with `leagueTier.id === 105000036`. Dedupe tags. Stop at `meta.maxPlayers` (default 1000).
3. For each player: `GET /players/{tag}/battlelog`. Keep entries where `attack === true && battleType.toLowerCase() === 'legend'`.
4. **No Town Hall filter.** Legend I attackers are effectively max TH, and a troop used by a lower-TH Legend I player is still a valid recommendation.
5. Dedupe key: `playerTag + battleTimestamp`. Append new rows to `data/meta/battles.jsonl`: `{ tag, ts, stars, destruction, armyShareCode }`.
6. Throttle (~10 req/s, configurable). Retry 429/5xx/network errors with exponential backoff, using the server's `Retry-After` when it is longer (capped at 60 s). 401/403 abort the run. A location whose rankings keep failing is skipped and logged. Log progress.
7. Run **daily** (battle logs only reach back ~2 days). Automated by the daily GitHub Action (§8.4); the `npm run dev` refresh (§9a) runs it locally only when the Action missed a day. Never by an OS scheduler. No patch-triggered runs.
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
  - Housing space comes from the game data (`housing_space`; super troops: their own entry, mapped to the base troop by `super_troop.original_id`, §3.1). A unit missing it (today: Baby Dragon Squad, P.E.K.K.A Titan Squad) is listed in the run summary and ranked by `usage` instead. Unknown IDs and seasonal units are left out of the per-attack totals.
  - A `meta.json` without `armyShare` (older file) falls back to `usage`.
- Keep `usage` and `threeStarRate` in the output for display and later tuning.
- Write `public/meta.json`: `{ generatedAt, windowDays, halfLifeDays, attacks, players, units: { [dataId]: { name, usage, threeStarRate, avgQty?, armyShare?, kind?, baseId? } } }`.

### 8.4 Daily meta Action (`.github/workflows/meta.yml`)

Runs **daily at 11:07 UTC** and on **manual dispatch**. Secrets: `COC_DEV_EMAIL`, `COC_DEV_PASSWORD` only, passed to the meta step and the issue step (for redaction) and never echoed. Concurrency group `meta`; job timeout 30 min.

1. **Restore** `data/meta/battles.jsonl` from the **`meta-data` branch** (`battles.jsonl.gz`), if the branch exists; otherwise start empty.
2. **Collect** (`scripts/meta-ci.ts run`): log in (key `hibiscus-ci`, token masked), then run the same collector and aggregation as `npm run meta`, with three CI differences:
   - rows older than the **14-day window** are pruned;
   - new rows store a **pseudonym** instead of the player tag (`h` + 16 hex of a SHA-256), because the branch is public. Dedupe and the player count still work, since the same tag always maps to the same pseudonym;
   - no run state is kept between runs (no resume or carry-over in CI: each daily run gathers players afresh).
3. **Decide** whether the new `meta.json` may replace the committed one. It's never replaced by a worse one. **Commit only if all hold:**
   - players were gathered and battle logs fetched (not "API down");
   - at least **2,000 attacks** in the window (`MIN_META_ATTACKS`; a normal run has ~13.7k);
   - a partial run fetched at least **50 %** of the players it gathered;
   - at least **50 %** of the current meta's attack count;
   - something besides `generatedAt` changed.
4. **Commit** `public/meta.json` alone to `main` as `meta: <generatedAt>` (rebase on `main`, our copy wins a conflict on that file) and start the Pages workflow by `workflow_dispatch`, like the data-update Action (§9b): a `GITHUB_TOKEN` push alone wouldn't trigger it.
5. **Store**: gzip the pruned `battles.jsonl` and force-push it to `meta-data` as **one parentless commit** (built with `git commit-tree`, so the branch never grows history), whenever the run collected new attacks, even if the meta wasn't committed.
6. **Failures** (no credentials, login failed, 401/403, API down, too few attacks or players, worse than current, a failing git step) and **partial runs** open or update **one** issue titled **"Meta update failed"**. It holds the step, the redacted reason, the numbers and the minimums. A partial run that passes the minimums still commits, and the issue says so. The next clean run closes the issue with a "Recovered" comment.

---

## 9. Game-data sync (`npm run sync`)

1. **clash-of-clans-data** (item images, TH weapons, backup source, §3.1): install the newest version **within the current major** (never jump a major automatically). If it can't be loaded, **restore the last known-good version**, record the failure in `data/refresh-state.json`, and exit non-zero.
   **ClashKing** (the game data): ask GitHub for the latest `clashy.go` release (main when no release has the file). Same commit as `data/clashking/pin.json` → nothing to do. Otherwise **snapshot the pinned data first** (step 2; a no-op when its snapshot exists, so even a fresh checkout has a "before"), download `static/static_data.json` **at that commit**, trim it, normalize it and **validate it before anything is replaced**: it must load, have levels that pass §9 step 4's level checks, contain the core items (Laboratory, Archer Queen, Cannon, Barbarian, Builder's Hut), not lower the max TH and not lose more than 10 % of the items. Pass → write `static_data.json` + `pin.json` (commit, sha256, version). Fail → **keep the previous pinned copy** (known-good rollback), record `clashKingFailure` in `data/refresh-state.json`, exit non-zero (the daily Action opens / updates its issue, §9b).
   - With **no usable ClashKing copy at all** (none pinned and GitHub unreachable, or the pinned file can't be loaded), the planner falls back to clash-of-clans-data with a visible warning (§3.1).
   - The `npm run dev` refresh (§9a) warns about a recorded failure (either source) on every start until a sync succeeds, and whenever the backup is in use.
   - Merge-consumption and hero-cap findings are warnings, not failures (the site warns about merges itself, §7).
2. Normalize the active data (ClashKing, or the backup) into the `Item` model; write `data/snapshots/<date>_<version>.json` (Item model only, no raw JSON or image paths), once per data version (`clashking-v0.1.20`, …; the backup uses the clash-of-clans-data version). Snapshots are ~0.3 MB each, so `data/snapshots/` is **git-ignored** and only the newest two are kept on disk.
3. Diff vs the newest snapshot of another version and print human-readable changes: new / removed items, new / removed levels, renames, and per-level cost, time and requirement changes. Examples: `Archer Tower 21: 18d → 16d`, `Gold Mine 17: 8M gold → 7.2M gold`, `NEW: Town Hall 19 (…)`, `NEW ITEM: …`, `REMOVED ITEM: …`. Items match by key (dataId), never by name. Equipment compares all three ores.
   - The diff is saved to `public/data-changes.json` (`{ version, previousVersion, date, changes[] }`). It's committed with `data/clashking/` (and `package.json` / `package-lock.json`), so the live site gets it too. If the file already holds the same diff (same versions and changes), it isn't rewritten, so the date alone never dirties the working tree (e.g. a local sync after pulling the Action's commit).
   - The Plan tab shows a dismissible **"Game data updated: N changes"** banner with the list when `data-changes.json` matches the bundled data version and that version hasn't been dismissed yet (dismissal is per version, in localStorage).
   - The first snapshot has nothing to compare with and writes no diff. A snapshot/diff failure is a warning, not a failed sync.
   - `npm run sync -- --offline` validates and snapshots the pinned / installed data without asking GitHub or npm.
4. Run validation tests; print warnings (don't block the site):
   - Every dataId in a sample export resolves to an item.
   - Levels are contiguous and costs/times are non-negative.
   - **Hero cap mismatch:** Hero Hall `heroLevelCaps` vs per-level `heroHallLevelRequired` (clash-of-clans-data backup only; ClashKing has no cap table — log, don't fail).
   - **Merge consumption check** (§7).
   - Max TH changed → print "mode may flip to rush".
5. **Cross-check report** (every sync, and in the daily Action's log and step summary): compare the normalized ClashKing data with clash-of-clans-data, item by item (by key) and level by level: **cost** (incl. resource and ore), **time** and **TH requirement**. Print the differences (capped at 60 lines, counts always complete); **never fail** on them. Also print which source has the **higher max TH** and which has **newer items** (items / levels only one side has), so after a patch (e.g. TH19) it's visible which source updated first. TH weapons (taken from clash-of-clans-data in both) aren't compared.
6. Site footer shows: data source and version (`ClashKing v0.1.20`, or `clash-of-clans-data 0.19.1 (backup)`) + snapshot date (from `data-changes.json` when it matches), meta `generatedAt`.

## 9a. Automatic refresh — no OS schedulers

The player never uses Windows Task Scheduler (or cron). Freshness comes from starting the site (and, for game data on the live site, from the daily Action in §9b):

- `npm run dev` runs a `predev` refresh (`scripts/refresh.ts`) before Vite starts:
  0. **Git:** `git pull --ff-only` (30 s timeout, no credential prompt), so the local copy has whatever the daily Action committed. Silent when already up to date; prints one line when commits came in. If the pull changed `package.json` / `package-lock.json`, it runs `npm install` (node_modules must match the committed data version), then `npm run sync -- --offline` to record the local snapshot. If the pull can't fast-forward (uncommitted changes, diverged history, offline, not a git checkout), it prints a one-line warning and continues with the local copy.
  1. **Game data:** if the last check was >24h ago (`data/refresh-state.json`, git-ignored), ask GitHub for the latest ClashKing release commit and npm for the newest `clash-of-clans-data` within the installed major; if either is newer than what's pinned / installed, run the full `npm run sync`. A version that sync already recorded as unusable (either source) isn't retried on every start; a newer release, or `npm run sync` by hand after a fix, retries. GitHub or npm being unreachable is one warning line each. Usually step 0 already pulled the Action's pinned copy, so this finds nothing.
  2. **Meta:** the daily Action (§8.4) normally keeps `public/meta.json` fresh, and step 0 pulled its copy. So `npm run meta` runs only if that `meta.json` (`generatedAt`) is **>24h old** or missing, **and** `.env` has `COC_DEV_EMAIL` + `COC_DEV_PASSWORD` (login, key `hibiscus-local`) or `COC_API_TOKEN`. Staleness means "last aggregation" (`generatedAt`), so `npm run meta -- --aggregate-only` also resets the 24 h clock.
  3. **Any failure** (offline, 403, no token, sync error) prints a **one-line warning** and the site starts anyway. A failed check is retried on the next start. A meta run where some players failed counts as updated; those players are retried by the next run (§8.1).
  4. While sync has a recorded data failure, **every start** prints a one-line warning that the site is running on the last known-good data.
  5. After a local meta pull that wrote `public/meta.json` (exit 0, or exit 2 = partial), print one line: the daily Meta Action normally does this; run `npm run push-meta` only to put this copy on the live site now. The refresh **never pushes** by itself (§15).
- `npm run dev:fast` skips the refresh.
- The refresh runs only locally; the GitHub Pages workflow never runs it (§15).

## 9b. Daily game-data update (GitHub Action)

`.github/workflows/data-update.yml` keeps the game data current on the live site without the local machine: **ClashKing** (the game data) and **clash-of-clans-data** (images, TH weapons, backup). It runs **daily at 10:17 UTC** and on **manual dispatch**. **No secrets**: it talks to GitHub (ClashKing's releases; the workflow's own `GITHUB_TOKEN` is passed only for API rate limits and never printed), the npm registry and this repo, and never runs `npm run meta`.

1. `npm ci`, then `scripts/data-update.ts check`. That's the same code as `npm run sync` (§9): clash-of-clans-data within the current major (`syncData`), then ClashKing's latest release (`syncClashKing`). If neither is newer, the run **ends successfully** ("Nothing new").
2. If newer: snapshot the pinned data, download + validate the new ClashKing file (the **known-good copy stays** if it fails), pin it, snapshot it, diff the two and write `public/data-changes.json`. A new clash-of-clans-data alone (images / backup) commits with no game-data diff. The cross-check report goes to the log and the step summary. The CI path and a local `npm run sync` produce the same diff (tested).
3. **Stricter than local, because nobody is watching:** a merge the recipes don't explain (§7 consumption check) **fails** the update instead of being a warning. So does a missing diff for a new ClashKing version. Hero-cap mismatches stay warnings.
4. `npm test` on the new data.
5. All good → commit **only** `data/clashking/`, `package.json`, `package-lock.json` and `public/data-changes.json` to `main` as `data: ClashKing <old> → <new>, clash-of-clans-data <old> → <new> (N changes)` (only the parts that changed; author `github-actions[bot]`), rebase on `main` and push. Then start the Pages workflow with `gh workflow run pages.yml --ref main`. A push made with the workflow's `GITHUB_TOKEN` doesn't trigger other workflows, but a `workflow_dispatch` does. Pages then runs its own `npm test` + build on the new commit and deploys.
6. **Anything fails → nothing is committed** (the live site keeps the known-good data), and the run opens an issue titled **`Data update failed: <new version>`** (`clashking-v…` for a ClashKing failure, `… ClashKing check` when GitHub couldn't be asked, `… npm check` when npm couldn't be asked). If an open issue with that exact title exists, it's updated and gets a "Failed again" comment instead of a duplicate. The body names the failing step and has the reason, the sync/validation output, the diff summary and, for a test failure, the end of the test log. If the cause is a merge the recipes don't explain, it says so plainly and names the new merged defense and its sources (candidates derived from the counts and ranked: new in this release, then the name contains a source's name, then ≤ 2 of each source); the fix is an entry in `config/merges.yaml`.
7. Permissions: `contents: write` (push), `issues: write` (report), `actions: write` (dispatch Pages). Concurrency group `data-update`, never cancelled midway.

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
  - **Boosts** run from the export time and apply to running and new jobs while active, including Goblin jobs and running upgrades on unknown ids. Constants live in `BOOST_MULTIPLIER`.
    - Builder Potion = builders ×10. Builder Bite = +1×, stacking additively (potion + bite = ×11, bite alone ×2).
    - Research Potion = **Laboratory only**, ×24. Study Soup ×4, Laboratory only (assumed).
    - The Pet House has its **own Pet Potion** (×24). The Research Potion never speeds up the Pet House.
    - The Clock Tower (boost and `clocktower_cooldown`) is Builder Base only and is never applied; a cooldown is never an active boost.
    - Export timers are taken as remaining *work* time.
  - **Helpers:** the Builder's Apprentice (builder jobs) and the Lab Assistant (Laboratory research, not pets) each work for one hour per cycle. **Level L = L× speed for that hour = L hours saved** (`workRate` = L from `other/helpers`), less if the job finishes inside the hour. The helper's gain is added on top of the queue's own progress: a Builder Potion or Builder Bite **never speeds up the Apprentice's own work** (potion + Apprentice L8 in the same hour = 9 + 8 extra hours, not 80). An unknown higher level uses the highest known level and shows a warning.
  - **When:** the helpers share one **23-hour cycle** that starts when a helper is assigned. The next work hour is when the export's shared `helper_cooldown` ends (counted from the export; no cooldown = now), then every 23 h. Hours between the export and now apply to jobs that were running then. `helper_timer` on an upgrade = a helper already working on it: it adds the rest of that hour.
  - **Which job:** the job on the instance the export marks recurrent, if it's running. Otherwise the Apprentice takes the builder job with the most time left, and the Assistant takes the running research. Never a Goblin job (it frees no slot).
  - The Alchemist and Prospector don't affect timing.

### 10.2 Gold Pass toggle
- Two states: **No Gold Pass** / **Max Gold Pass**.
- Max applies the builder-time boost to builder upgrades **including supercharges**, and the research boost to lab/pet upgrades.
- Constant `GOLD_PASS_MAX_BOOST` in one place (verify the current % in-game before release — expected 20%).

### 10.3 Forecast output (next 24h)
- Sum cost by resource for every upgrade that **starts** within 24h in the simulation.
- Show a per-slot timeline: `B2 free 11:40 PM → Cannon 21 (3.0M gold)`. Times show the clock today, the weekday within 6 days ("Wed 11:40 PM"), and the date beyond that ("Tue Nov 24, 9:24 AM").
- Show "needed by" times so the player knows which resource to farm first.
- **No ore.** Ore is time-gated (daily attacks, wars, raids, events), so it never appears in "Resources needed": no ore tiles, totals or "needed by" rows in the Plan tab or the CLI. Equipment ore costs are informational only (§6.9). The old `forecast.blacksmithTopN` setting is gone; a saved value is ignored.
- Already-running upgrades are not counted (already paid).

### 10.4 Wall dump line
- Find the lowest wall level the player owns where the next level is available.
- Show: `Overflow → walls: Lv 17→18 costs X gold or elixir each; N walls at Lv 17.`

---

## 11. UI

Mobile-friendly layout (the player checks on a phone later), single page with tabs:

1. **Import & Settings** — paste export JSON → parse → save. Toggles: Gold Pass (none / max), **Simulate helpers and boosts** (§10.1). Hero order: drag to reorder on desktop, ↑ / ↓ buttons everywhere (touch), "Reset hero order to default", saved in localStorage. **The Archer Queen is locked at position 1:** her row is greyed out with no drag handle and no ↑ / ↓, she's not a drop target, and nothing can move above her (#2's ↑ is disabled). The help text says she's locked because of her Tier 0 rule. The other five stay reorderable; reset keeps her at 1. Show import time and TH / mode detected.
2. **Plan** (default tab). The "Game data updated" banner (§9) sits on top when a new data version arrives.
   - "Now": what each free builder should start, with the `reason` string.
   - 24h timeline per slot.
   - Resources needed in 24h (gold, elixir, DE; never ore, §10.3).
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

- `config/merges.yaml` — optional merge-recipe overrides (§7). Ships empty.
- `config/super-troops.yaml` — optional super-troop overrides (`<dataId>: { name, base }`, §8.3). Ships empty.
- `config/settings.sample.yaml` — defaults loaded into the UI on first run. The UI persists edits to localStorage; the YAML is the reset point. Includes `lab.kindWeights` (troop / spell / siege, §6.7) and `simulateHelpers` (§10.1), both editable in the Settings tab. A saved hero order keeps its order, drops duplicates and gets any missing default hero appended; the Archer Queen is moved to the front if she's elsewhere (YAML or localStorage).
- `config/id-overrides.yaml` — optional dataId overrides (`ids: { <dataId>: <item id> }`, §3.1). Ships empty.
- All three: an entry that exists wins over ClashKing's data (and over the backup's built-in tables).

---

## 13. Build steps

### Step 1 — Functional v1 (end-to-end test)
Goal: run `npm run dev`, paste a real export, and get a correct upgrade plan.
- Project scaffold (Vite + TS, Vitest, scripts wired up).
- Data layer: load `clash-of-clans-data`, normalize to the `Item` model (§5), merges from `merges.yaml` (§7). (Since replaced: game data comes from ClashKing, §3.1.)
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
- **No token in the Pages workflow.** It never runs the predev refresh (it never calls `npm run dev`), `npm run meta`, `npm run sync` or `npm run push-meta`. The site ships the committed `public/meta.json`, the pinned ClashKing copy in `data/clashking/` and the `clash-of-clans-data` version locked in `package-lock.json` (images, TH weapons, backup). Only the meta Action (§8.4) uses secrets.
- **Base path:** only `vite build --mode pages` uses base `/Hibiscus-clash-advisor/`; `npm run dev`, `npm run build` and tests stay at `/`. Every runtime fetch uses `import.meta.env.BASE_URL` (§2).
- **Meta on the site:** the daily meta Action (§8.4) commits `public/meta.json` and redeploys. By hand, `npm run push-meta` still commits that file alone (`meta: <generatedAt>`) and pushes `main` if it changed; it does nothing when unchanged and refuses off `main`. The predev refresh reminds after a local meta pull (§9a step 5) but never pushes.
- **Game-data updates** reach the site **automatically** through the daily data-update Action (§9b): it commits the new version and starts this workflow by `workflow_dispatch`. A local `npm run sync` + commit + push still works too. `npm run dev` pulls the Action's commits first (§9a step 0).
- **Privacy:** user data stays in each browser's `localStorage`; nothing is uploaded. Committed fixtures are redacted (§8.1 / `scripts/lib/redact.ts`); `.env`, `samples/`, the local `battles.jsonl` and run-state files are git-ignored and were never committed. The Action's `battles.jsonl` on the public `meta-data` branch stores **pseudonyms, not player tags** (§8.4); it holds timestamps, stars, destruction and army codes. The pseudonyms are stable, so someone hashing every tag from the public rankings could match them; that's pseudonymity, not anonymity.

### 15.2 v2+ (not now)

- ~~Daily version check / rebuild in GitHub Actions~~ → done (§9b).
- ~~Daily meta in GitHub Actions~~ → done (§8.4), using developer-site login for a per-runner key.
- Sleep/awake windows for finish-time fitting.
- Multi-device state.
- Builder Base / Clan Capital.
