# Step 1 Report: CoC Upgrade Planner

**Status:** Step 1 is built. `npm test` passes (49 tests, 4 files; 44 at the original Step 1 hand-off) and `npm run build` succeeds. The plan for your real export is at the bottom of this file. Design choices and assumptions are in `DECISIONS.md`.

## Start the site

```powershell
npm install        # first time only
npm run dev        # → http://localhost:5173
```

1. The site opens on **Import & Settings**. Paste your export JSON (in-game: Settings → More Settings → Data Export → copy) and click **Import**.
2. Pick Gold Pass (None / Max) and set the hero order if you want.
3. Open **Plan**. The page saves everything in your browser (localStorage), so a reload keeps your export and settings.

Other commands:

| Command | What it does |
|---|---|
| `npm run plan -- samples/myexport.json` | Prints the plan in the terminal. Flags: `--gold-pass max`, `--hours 48`, `--at-export` (plan as of the export time instead of now) |
| `npm test` | Runs all tests (Vitest) |
| `npm run build` | Type-checks and builds |
| `npm run sync` | Updates `clash-of-clans-data`, prints the version, then runs the validation checks (levels, merge consumption, hero-cap mismatch) |

## What was built

- **Project setup:** Vite + TypeScript, Vitest, `tsx` scripts, a git repo. `samples/` and `.env` are git-ignored, so your export is never committed.
- **Data layer** (`src/data/`): loads 15 folders from clash-of-clans-data **0.19.1** into the `Item` model and joins on `dataId`. The browser and Node load the same data (a test checks this).
  - Real-data quirks it handles: supercharge levels hidden inside defense level lists, Town Hall weapons, Crafting Station modules, equipment with 3 ore types.
- **Merges:** recipes come from `config/merges.yaml`. Unlock TH, counts and required source levels are derived from the data. The merge-consumption check passes on 0.19.1.
- **Export parser** (`src/state/parseExport.ts`): built from your real export. It reads the top-level `timestamp`, `units` / `siege_machines`, `cnt`, `timer`, the `extra` (Goblin) flag and the Crafting Station modules. Unknown IDs show up as warnings and don't crash the import.
- **Priority engine** (`src/engine/tiers.ts`, `book.ts`):
  - Detects rush vs max-TH mode automatically.
  - Tier 0 Queen, then all tiers for both modes.
  - The hero book threshold comes from the data (currently 8d).
  - Hero caps come from per-level Hero Hall requirements, so the Archer Queen cap at Hero Hall 12 is 110, not the stale 105.
  - Merge chains (sources → merge → upgrades), with the TH-upgrading lookahead.
  - Missing buildings show up as "build new" upgrades.
  - Tiers 5–6 are ordered longest-first.
- **Scheduler** (`scheduler.ts`):
  - Simulates builders, lab, pet house and Goblin slots over time.
  - Running timers count down from the export timestamp.
  - Merges remove their source defenses in the simulation, and new buildings get added.
  - Gold Pass boost is one constant in `src/engine/constants.ts` (builder 20%, research 20%).
- **Forecast** (`forecast.ts`): resources needed in the next 24h with "needed by" times, ore for the top 3 equipment picks, and the wall overflow line.
- **UI:** Import & Settings tab and Plan tab. The Plan tab shows:
  - what to start now
  - a per-builder 24h timeline
  - resources and ore needed
  - book-ready heroes
  - the wall line
  - the current builder priority list with reasons
  - warnings

  The layout works on a phone. The footer shows the data version and meta date. The plan refreshes every minute.
- **Tests** (`tests/`): everything §13 asks for: export parsing, dataId join, Queen tier 0, book-ready cutoff, longest-first ordering, rush vs max-TH tier order, TH-upgrading merge lookahead and forecast totals. Also covered:
  - Gold Pass
  - Goblin slots
  - merge builds
  - wall line
  - data validation
  - a UI test that loads the page, imports an export and renders the plan

## What's stubbed

- **Meta:** `public/meta.json` ships with no data. Until Step 2, lab and pet lists fall back to shortest-first, and equipment to cheapest-first. Every item shows "Not seen in Legend I meta".
- **`npm run sync`** only updates the package, prints the version and runs the checks. Snapshots and diffs are Step 3.
- **Not built yet (out of Step 1 scope):** the Lab/Pets/Equipment tab with pins, and the Everything tab. The pin settings are already stored and the ranking code already supports them.

## Known gaps

1. **Builder Apprentice, Lab Assistant and active boosts are not simulated** (Step 3). Running timers use the raw export values. `boosts` was `{}` in your export, so its format is still unknown.
2. **Supercharge progress format is a guess.** The parser expects a `supercharge` number on the building. Your export has no supercharges, so this is unverified. TH weapon level (`weapon`) is also a guess, but TH18 has no weapon so it doesn't matter today.
3. **Lab upgrades vs research:** the game won't let you upgrade the Laboratory or Pet House while research is running. The simulation doesn't enforce that (it does block research while the building upgrades). It doesn't affect you: both are maxed.
4. **Goblin Builder/Researcher** only finishes its current job. The planner never gives it new work.
5. **Gear-ups** (your Mortar has one) and **helpers** are not scheduled. The Alchemist helper (`93000003`) isn't in the data package yet, so it appears as a warning.
6. ~~Max-TH reading of tiers~~: resolved by the SPEC revision. See "Update: TH gate" at the end of this file.

## Check in-game

- [ ] **Gold Pass max boost %**: builder and research both assumed **20%** (`src/engine/constants.ts`).
- [ ] **Royal Champion → 38 now** (B5 just finished RC 37). Then **Minion Prince 53** when Grand Warden finishes at ~7:23 PM. Heroes run before defenses because max-TH mode puts heroes in tier 2.
- [ ] **Grand Warden 78 and Dragon Duke 23 are book-ready** (8d each), so the planner stops queuing them after the current upgrades. Agree?
- [ ] **Builder count = 6** (5 huts + B.O.B). The 7th running job (Multi-Archer Tower → 3) is read as the Goblin Builder.
- [ ] **Firespitter 2 → 3 shows 15d / 29M gold.** That's what the data package says. If the game shows less, it's a data error and the longest-first order will shift.
- [ ] **Heroes before defenses:** in max-TH mode, after heroes come the longest permanent-defense upgrades: Firespitter, then Multi-Archer Tower / Ricochet Cannon 1→2 (8d), then Skeleton Traps (7d).
- [ ] **Wall line:** 148 walls at 17 → 18 for 7M each. Correct?
- [ ] **Timers:** with the export ~22 min old, check the "done at" times against the game (e.g. Grand Warden 7:23 PM, Druid Thu 1:41 AM).
- [ ] **Hero Hall 13 (Nov 16):** run `npm run sync` once the data package updates. The validation output will flag hero-cap changes and a new max TH.

## Plan output for your export (`npm run plan -- samples/myexport.json`, Sunday 15 Nov 2026, 8:18 AM)

```

Export: samples\myexport.json

CoC Upgrade Planner — TH18 (max TH18) · mode: MAX-TH · Hero Hall 12
Builders: 6 · Gold Pass: none · book threshold 8d · data v0.19.1
Export taken 11/15/2026, 7:55:48 AM (22m ago) · now 11/15/2026, 8:18:06 AM

== Now ==
  B5: start Royal Champion → 38 (180K DE, 5d) — Hero #5 in order; not book-ready (raw next level 5d < 8d threshold)

== Top builder priorities right now ==
  [T2 Heroes] Minion Prince 52 → 53 · 4d · 110K DE — Hero #6 in order; not book-ready (raw next level 4d < 8d threshold)
  [T5 Permanent defenses] Firespitter 2 → 3 · 15d · 29M gold — Permanent defense, longest first (LPT)
  [T5 Permanent defenses] Multi-Archer Tower 1 → 2 · 8d · 13M gold — Merge path: Multi-Archer Tower to max for TH18
  [T5 Permanent defenses] Multi-Archer Tower 1 → 2 · 8d · 13M gold — Merge path: Multi-Archer Tower to max for TH18
  [T5 Permanent defenses] Ricochet Cannon 1 → 2 · 8d · 13M gold — Merge path: Ricochet Cannon to max for TH18
  [T5 Permanent defenses] Ricochet Cannon 1 → 2 · 8d · 13M gold — Merge path: Ricochet Cannon to max for TH18
  [T5 Permanent defenses] Ricochet Cannon 1 → 2 · 8d · 13M gold — Merge path: Ricochet Cannon to max for TH18
  [T5 Permanent defenses] Skeleton Trap 4 → 5 · 7d · 18M gold — Permanent defense, longest first (LPT)
  [T5 Permanent defenses] Skeleton Trap 4 → 5 · 7d · 18M gold — Permanent defense, longest first (LPT)
  [T5 Permanent defenses] Skeleton Trap 4 → 5 · 7d · 18M gold — Permanent defense, longest first (LPT)

== Timeline (next 1d) ==
  B1 (Builder 1):
    busy: Scattershot → 3, done Tue 9:27 AM (in 2d 1h)
  B2 (Builder 2):
    busy: Scattershot → 3, done Tue 9:25 AM (in 2d 1h)
  B3 (Builder 3):
    busy: Barbarian King → 82, done Mon 9:36 AM (in 1d 1h)
  B4 (Builder 4):
    busy: Grand Warden → 77, done 7:23 PM (in 11h 5m)
    free 7:23 PM → Minion Prince 53 (110K DE, 4d, done Thu 7:23 PM)
  B5 (Builder 5):
    Royal Champion → 37 finished since the export
    free 8:18 AM → Royal Champion 38 (180K DE, 5d, done Fri 8:18 AM)
  B6 (Builder 6):
    busy: Dragon Duke → 22, done Tue 1:36 PM (in 2d 5h)
  LAB (Laboratory):
    busy: Druid → 4, done Thu 1:41 AM (in 3d 17h)
  PET (Pet House):
    busy: Sneezy → 7, done Tue 12:24 PM (in 2d 4h)
  GB (Goblin Builder):
    busy: Multi-Archer Tower → 3, done Wed 9:49 PM (in 3d 13h)
  GL (Goblin Researcher):
    busy: Wall Breaker → 14, done Fri 1:13 AM (in 4d 16h)

== Resources needed (upgrades starting in the next 1d) ==
  DE                290K   first needed 8:18 AM (Royal Champion 38)
  Ore (top 3 equipment): 360 shiny · 0 glowy · 0 starry
    - Frozen Arrow 1→2: 120 shiny / 0 glowy / 0 starry
    - Haste Vial 1→2: 120 shiny / 0 glowy / 0 starry
    - Heroic Torch 1→2: 120 shiny / 0 glowy / 0 starry

== Book-ready heroes (your call) ==
  Grand Warden 77→78: 25.5M elixir, 8d (after current upgrade)
  Dragon Duke 22→23: 440K DE, 8d (after current upgrade)

== Walls ==
  Overflow → walls: Lv 17→18 costs 7M gold or elixir each; 148 walls at Lv 17.

== Lab (top 5) ==
  Wizard 8→9 · 2d 12h · 4M elixir — Not seen in Legend I meta: shortest first (2d 12h)
  Skeleton Spell 5→6 · 3d · 50K DE — Not seen in Legend I meta: shortest first (3d)
  Miner 5→6 · 3d · 4.8M elixir — Not seen in Legend I meta: shortest first (3d)
  Giant 9→10 · 3d · 5M elixir — Not seen in Legend I meta: shortest first (3d)
  Flame Flinger 1→2 · 3d · 5.5M elixir — Not seen in Legend I meta: shortest first (3d)
== Pet House (top 3) ==
  Mighty Yak 1→2 · 1d · 40K DE — Not seen in Legend I meta: shortest first (1d)
  Poison Lizard 2→3 · 1d 12h · 75K DE — Not seen in Legend I meta: shortest first (1d 12h)
  Diggy 1→2 · 1d 12h · 90K DE — Not seen in Legend I meta: shortest first (1d 12h)

== Warnings ==
  - Unknown dataId 93000003 in "helpers" (not in game data 0.19.1); ignored.
```

---

## Update: TH gate (SPEC §6.2–6.4, §10.1 revision)

**Status:** `npm test` passes (49 tests: 5 new, 1 replaced, 2 updated) and `npm run build` succeeds.

### What changed in the engine (`src/engine/tiers.ts`)
- **Tier 0 = new buildings, then the Archer Queen (both modes).** Every unbuilt building now comes before the Queen, ordered offense → resources → defenses, then longest first. That includes extra copies, missing merge sources, and merges whose sources are maxed.
- **The TH gate replaces "merge path".** Every available merge must be performed, old ones as well as new.
  - Merge-source upgrades are rush tier 1 and max-TH tier 3.
  - The merge itself is tier 0.
  - Merged-defense upgrades past level 1 moved to tier 5 (permanent defenses, longest first).
- **Rush mode: the Town Hall upgrade waits for the gate.** It only appears once every new building is built and every performable merge is done. A merge that lacks sources never blocks it. See `DECISIONS.md` for how I read "as soon as it's available".
- Tier names changed: tier 0 "New buildings + Archer Queen"; rush tier 1 "Town Hall path + TH gate"; max-TH tier 3 "TH gate (merge sources)".

### New tests (`tests/engine.test.ts`)
- An unbuilt new building (extra X-Bow) outranks the Queen. It also keeps the TH gate closed.
- Several new buildings are ordered offense → resources → defenses, then longest first.
- A merge whose sources are maxed (2 spare Cannons at 21) lands in Tier 0, ahead of the Queen.
- Max TH with an unmerged older merge (Ricochet Cannon, Cannons at 19): the Cannon upgrades are TH gate items in tier 3, and there's no merge candidate yet. Once the Cannons are at 21, the merge jumps to Tier 0.
- Merged-defense upgrades past level 1 sit in tier 5 at TH17 (rush) and TH18 (max), mixed in with the other defenses longest first.
- Rush mode: the Town Hall is not a candidate while a merge is still open. Once the gate is clear, it's back at the top of tier 1.

### Before / after on your export (`npm run plan -- samples/myexport.json --at-export`, same timestamp for both)

Your base has **no unbuilt buildings and no unperformed merges**, so Tier 0 and the TH gate are empty. The schedule, timeline, resources and wall line are **identical**. Only the reason on the Ricochet Cannon / Multi-Archer Tower upgrades changed. They were already in tier 5, and now they're there by rule rather than because they were "older merges".

```diff
@@ -10,11 +10,11 @@
 == Top builder priorities right now ==
   [T2 Heroes] Minion Prince 52 → 53 · 4d · 110K DE — Hero #6 in order; not book-ready (raw next level 4d < 8d threshold)
   [T5 Permanent defenses] Firespitter 2 → 3 · 15d · 29M gold — Permanent defense, longest first (LPT)
-  [T5 Permanent defenses] Multi-Archer Tower 1 → 2 · 8d · 13M gold — Merge path: Multi-Archer Tower to max for TH18
-  [T5 Permanent defenses] Multi-Archer Tower 1 → 2 · 8d · 13M gold — Merge path: Multi-Archer Tower to max for TH18
-  [T5 Permanent defenses] Ricochet Cannon 1 → 2 · 8d · 13M gold — Merge path: Ricochet Cannon to max for TH18
-  [T5 Permanent defenses] Ricochet Cannon 1 → 2 · 8d · 13M gold — Merge path: Ricochet Cannon to max for TH18
-  [T5 Permanent defenses] Ricochet Cannon 1 → 2 · 8d · 13M gold — Merge path: Ricochet Cannon to max for TH18
+  [T5 Permanent defenses] Multi-Archer Tower 1 → 2 · 8d · 13M gold — Merged defense upgrade (permanent defense, longest first)
+  [T5 Permanent defenses] Multi-Archer Tower 1 → 2 · 8d · 13M gold — Merged defense upgrade (permanent defense, longest first)
+  [T5 Permanent defenses] Ricochet Cannon 1 → 2 · 8d · 13M gold — Merged defense upgrade (permanent defense, longest first)
+  [T5 Permanent defenses] Ricochet Cannon 1 → 2 · 8d · 13M gold — Merged defense upgrade (permanent defense, longest first)
+  [T5 Permanent defenses] Ricochet Cannon 1 → 2 · 8d · 13M gold — Merged defense upgrade (permanent defense, longest first)
   [T5 Permanent defenses] Skeleton Trap 4 → 5 · 7d · 18M gold — Permanent defense, longest first (LPT)
   [T5 Permanent defenses] Skeleton Trap 4 → 5 · 7d · 18M gold — Permanent defense, longest first (LPT)
   [T5 Permanent defenses] Skeleton Trap 4 → 5 · 7d · 18M gold — Permanent defense, longest first (LPT)
```

Full "after" output (as of now, Sunday 15 Nov 2026, 1:46 PM):

```
Export: samples\myexport.json

CoC Upgrade Planner — TH18 (max TH18) · mode: MAX-TH · Hero Hall 12
Builders: 6 · Gold Pass: none · book threshold 8d · data v0.19.1
Export taken 11/15/2026, 7:55:48 AM (5h 50m ago) · now 11/15/2026, 1:46:15 PM

== Now ==
  B5: start Royal Champion → 38 (180K DE, 5d) — Hero #5 in order; not book-ready (raw next level 5d < 8d threshold)

== Top builder priorities right now ==
  [T2 Heroes] Minion Prince 52 → 53 · 4d · 110K DE — Hero #6 in order; not book-ready (raw next level 4d < 8d threshold)
  [T5 Permanent defenses] Firespitter 2 → 3 · 15d · 29M gold — Permanent defense, longest first (LPT)
  [T5 Permanent defenses] Multi-Archer Tower 1 → 2 · 8d · 13M gold — Merged defense upgrade (permanent defense, longest first)
  [T5 Permanent defenses] Multi-Archer Tower 1 → 2 · 8d · 13M gold — Merged defense upgrade (permanent defense, longest first)
  [T5 Permanent defenses] Ricochet Cannon 1 → 2 · 8d · 13M gold — Merged defense upgrade (permanent defense, longest first)
  [T5 Permanent defenses] Ricochet Cannon 1 → 2 · 8d · 13M gold — Merged defense upgrade (permanent defense, longest first)
  [T5 Permanent defenses] Ricochet Cannon 1 → 2 · 8d · 13M gold — Merged defense upgrade (permanent defense, longest first)
  [T5 Permanent defenses] Skeleton Trap 4 → 5 · 7d · 18M gold — Permanent defense, longest first (LPT)
  [T5 Permanent defenses] Skeleton Trap 4 → 5 · 7d · 18M gold — Permanent defense, longest first (LPT)
  [T5 Permanent defenses] Skeleton Trap 4 → 5 · 7d · 18M gold — Permanent defense, longest first (LPT)

== Timeline (next 1d) ==
  B1 (Builder 1):
    busy: Scattershot → 3, done Tue 9:27 AM (in 1d 19h)
  B2 (Builder 2):
    busy: Scattershot → 3, done Tue 9:25 AM (in 1d 19h)
  B3 (Builder 3):
    busy: Barbarian King → 82, done Mon 9:36 AM (in 19h 50m)
    free Mon 9:36 AM → Barbarian King 83 (195K DE, 5d, done Sat 9:36 AM)
  B4 (Builder 4):
    busy: Grand Warden → 77, done 7:23 PM (in 5h 37m)
    free 7:23 PM → Minion Prince 53 (110K DE, 4d, done Thu 7:23 PM)
  B5 (Builder 5):
    Royal Champion → 37 finished since the export
    free 1:46 PM → Royal Champion 38 (180K DE, 5d, done Fri 1:46 PM)
  B6 (Builder 6):
    busy: Dragon Duke → 22, done Tue 1:36 PM (in 1d 23h)
  LAB (Laboratory):
    busy: Druid → 4, done Thu 1:41 AM (in 3d 11h)
  PET (Pet House):
    busy: Sneezy → 7, done Tue 12:24 PM (in 1d 22h)
  GB (Goblin Builder):
    busy: Multi-Archer Tower → 3, done Wed 9:49 PM (in 3d 8h)
  GL (Goblin Researcher):
    busy: Wall Breaker → 14, done Fri 1:13 AM (in 4d 11h)

== Resources needed (upgrades starting in the next 1d) ==
  DE                485K   first needed 1:46 PM (Royal Champion 38)
  Ore (top 3 equipment): 360 shiny · 0 glowy · 0 starry
    - Frozen Arrow 1→2: 120 shiny / 0 glowy / 0 starry
    - Haste Vial 1→2: 120 shiny / 0 glowy / 0 starry
    - Heroic Torch 1→2: 120 shiny / 0 glowy / 0 starry

== Book-ready heroes (your call) ==
  Grand Warden 77→78: 25.5M elixir, 8d (after current upgrade)
  Dragon Duke 22→23: 440K DE, 8d (after current upgrade)

== Walls ==
  Overflow → walls: Lv 17→18 costs 7M gold or elixir each; 148 walls at Lv 17.

== Lab (top 5) ==
  Wizard 8→9 · 2d 12h · 4M elixir — Not seen in Legend I meta: shortest first (2d 12h)
  Skeleton Spell 5→6 · 3d · 50K DE — Not seen in Legend I meta: shortest first (3d)
  Miner 5→6 · 3d · 4.8M elixir — Not seen in Legend I meta: shortest first (3d)
  Giant 9→10 · 3d · 5M elixir — Not seen in Legend I meta: shortest first (3d)
  Flame Flinger 1→2 · 3d · 5.5M elixir — Not seen in Legend I meta: shortest first (3d)
== Pet House (top 3) ==
  Mighty Yak 1→2 · 1d · 40K DE — Not seen in Legend I meta: shortest first (1d)
  Poison Lizard 2→3 · 1d 12h · 75K DE — Not seen in Legend I meta: shortest first (1d 12h)
  Diggy 1→2 · 1d 12h · 90K DE — Not seen in Legend I meta: shortest first (1d 12h)

== Warnings ==
  - Unknown dataId 93000003 in "helpers" (not in game data 0.19.1); ignored.
```

---

# Step 2 Report: Legend League I meta + Lab / Pets / Equipment tab

**Status:** Step 2 is built and has been run for real. `npm test` passes (91 tests in 6 files, up from 49) and `npm run build` succeeds. The API key works from this machine, with no 403. Design choices are in `DECISIONS.md` under "Step 2".

## How to use it

```powershell
npm run meta                        # ~2 min: 1000 Legend I players → data/meta/battles.jsonl → public/meta.json
npm run meta -- --max-players 50    # quick test (~6 s)
npm run meta -- --aggregate-only    # rebuild meta.json from the saved battles, no API calls
npm run meta -- --fresh             # ignore a half-finished run and start over
npm run dev                         # then open the "Lab / Pets / Equipment" tab
```

If a run is interrupted (Ctrl+C, a crash, a closed window), run `npm run meta` again. It picks up where it stopped. I tested this by killing a run at 242/300 players: the rerun fetched only the remaining 58.

## What was built

- **`npm run probe`** (`scripts/probe.ts`): makes 10 real API calls and saves **redacted** samples to `tests/fixtures/api/`. Tags are pseudonyms, names are replaced, and the token is never written. All tests use these fixtures, never the live API.
- **Army code parser** (`src/meta/armyCode.ts`): a port of ClashKing's clashy.go `ParseArmyRecipe` (MIT). It accepts a full link or a raw code. All Go test cases are ported, plus tests on real Legend I codes from the fixtures.
- **Collector** (`scripts/meta.ts`, `scripts/lib/`):
  - global + country rankings → Legend I players (tier 105000036), deduped and capped at `meta.maxPlayers`
  - fetches each player's battle log and keeps Legend I attacks
  - appends new rows deduped by tag + timestamp
  - 10 req/s throttle, retries on 429/5xx, progress line with ETA, resumable, `--max-players`
- **Aggregation** (`src/meta/aggregate.ts`): 14-day window with a 5-day half-life. Gives usage, 3★ rate and average quantity for troops, spells, sieges, pets and equipment, written to `public/meta.json` in the SPEC §8.3 shape.
- **Super troops:** the data package has no IDs for them, so `config/super-troops.yaml` maps the 17 super troop IDs to their base troop. A test checks the IDs against the API's own troop order. Super troop usage counts toward the base troop's lab upgrade (Rocket Balloon usage → Balloon).
- **Lab / Pets / Equipment tab:** three ranked lists, each item with a usage bar, usage %, 3★ rate, time and cost (ore for equipment), and a **Pin** button.
  - Unused items are at the bottom, at normal contrast, marked "Not seen in Legend I · 0% used".
  - Pins are saved in the browser.
  - The same ranking drives the Plan tab's lab and pet queue order and its ore picks.
  - The footer shows the meta date, attack count and player count.
  - With no `meta.json`, everything falls back to the Step 1 order, and a note says to run `npm run meta`.
- **Goblin test (mid-step request):** a Goblin Builder job and a Goblin Researcher job in the export each run out their timer inside the 24h window. After that, neither Goblin gets a new upgrade in the schedule, in "Now" or in the 24h forecast, and neither counts as a builder. I checked that the test fails if the rule is broken. The engine already followed SPEC §10.1, so no engine change was needed.

## What the probe confirmed

| Question | Answer |
|---|---|
| Battle log field names | `battleType`, `attack`, `armyShareCode`, `opponentPlayerTag`, `opponentName`, `opponentTownHallLevel`, `stars`, `destructionPercentage`, `lootedResources`, `extraLootedResources`, `availableLoot`, `battleTime` (seconds), `battleTimestamp` (`20261116T180741.000Z`) |
| `battleType` values | **lowercase**: `legend`, `ranked`, `homeVillage` (not `LEGEND` as SPEC §3.3 says) |
| Ranked player tier field | `leagueTier: { id: 105000036, name: "Legend League I" }`, plus a legacy `league: { id: 29000000, name: "Unranked" }` |
| Is `legend` = Legend League I? | **Yes.** A Legend League II player's attacks are all `ranked`, and so are an Electro 33 player's. A player promoted to Legend I this week has `ranked` attacks before the promotion and `legend` after it. The filter is `attack && battleType === 'legend'` |
| Battle log depth | **Up to 50 entries** (average 48.4 across 1000 players). That's about **16 Legend attacks ≈ 2 days** for an active Legend I player |
| Rankings pagination | At most **200 players per location**. Without `limit`, one call returns all 200. With `limit`, it pages via `cursors.after`, and paging past 200 returns nothing. `/locations` returns all 268 in one page. Small countries' top 200 include lower tiers, so the tier filter matters |

## Full run summary (`npm run meta`, Mon 16 Nov 2026, ~2 PM)

```
Found 1000 Legend I players.            (global + the first ~25–30 countries)
Players fetched:      1000/1000
Battle log entries:   48449 (avg 48.4 per player)
Legend I attacks kept: 13566 (11 without an army code skipped)
New rows:             26 · duplicates skipped: 13540
API requests:         1037 this session
battles.jsonl:        13629 rows
Aggregated:           13629 attacks by 889 players in the last 14 days (half-life 5d)
Units in meta.json:   122
Unknown IDs (8) — not in clash-of-clans-data 0.19.1 or config/super-troops.yaml:
  4000203  in 43 attacks · 4000205 in 36 · 4000197 in 31 · 4000199 in 24 · 4000204 in 18
  4000195  in 3 · 4000206 in 1   (home troops, counted)
  26000153 in 12 attacks (CC spell, not counted)
Elapsed:              1m 46s
```

This was the second full run of the day. The first one, about an hour earlier, collected the ~13.5k attacks (its summary scrolled away), so this run mostly found duplicates, which confirms the dedupe works. The data covers attacks from **11 Nov to 16 Nov 2026**. 56% of all stored attacks were three-stars (unweighted).

The unknown IDs come after Sky Wagon in the game's ID order. They look like event troops (e.g. "Barch Squad"). They can't be researched, so they never affect your lab order.

## Top Legend I usage (as of 16 Nov 2026)

**Top 15 troops / spells / sieges**

| # | Unit | Type | Usage | 3★ rate | Avg qty |
|---|---|---|---|---|---|
| 1 | Archer | troop | 87.8% | 56.5% | 2.6 |
| 2 | Totem Spell | spell | 82.6% | 56.8% | 2.5 |
| 3 | Freeze Spell | spell | 70.5% | 57.0% | 1.8 |
| 4 | Ice Golem | troop | 58.1% | 57.2% | 1.7 |
| 5 | Rage Spell | spell | 57.4% | 54.9% | 1.5 |
| 6 | Poison Spell | spell | 55.4% | 58.5% | 1.0 |
| 7 | Healer | troop | 54.0% | 56.5% | 5.0 |
| 8 | Balloon | troop | 50.2% | 57.3% | 5.1 |
| 9 | Sky Wagon | siege | 49.6% | 54.4% | – |
| 10 | Super Wall Breaker | super troop | 49.2% | 57.0% | 2.2 |
| 11 | Baby Dragon | troop | 47.5% | 56.9% | 1.3 |
| 12 | Revive Spell | spell | 46.5% | 53.1% | 1.5 |
| 13 | Invisibility Spell | spell | 44.0% | 56.9% | 3.0 |
| 14 | Headhunter | troop | 43.2% | 56.9% | 1.5 |
| 15 | Apprentice Warden | troop | 35.7% | 55.9% | 1.1 |

Sieges: Sky Wagon 49.6% · Troop Launcher 30.9% · Log Launcher 8.8% · Flame Flinger 6.0% · Siege Barracks 4.4%.

**Top 5 pets**

| # | Pet | Usage | 3★ rate |
|---|---|---|---|
| 1 | Phoenix | 83.4% | 56.7% |
| 2 | Frosty | 79.3% | 56.2% |
| 3 | Sneezy | 69.1% | 56.4% |
| 4 | Greedy Raven | 48.7% | 55.6% |
| 5 | Spirit Fox | 39.2% | 55.4% |

**Top 10 equipment**

| # | Equipment | Usage | 3★ rate |
|---|---|---|---|
| 1 | Action Figure | 90.3% | 55.9% |
| 2 | Fire Heart | 62.8% | 55.7% |
| 3 | Eternal Tome | 59.2% | 54.8% |
| 4 | Revenge Deck | 55.7% | 56.8% |
| 5 | Spiky Ball | 53.3% | 57.3% |
| 6 | Giant Arrow | 52.7% | 55.0% |
| 7 | Snake Bracelet | 38.0% | 56.8% |
| 8 | Rocket Backpack | 37.5% | 55.9% |
| 9 | Meteor Staff | 37.2% | 55.5% |
| 10 | Rage Gem | 36.4% | 58.8% |

3★ rates sit in a narrow band (52–59%) for almost everything. That's expected at this level: they mostly reflect who's attacking whom, not the unit. Usage is the more useful signal, and it's what the ranking uses.

## How your plan changed (`samples/myexport.json`)

The builder plan is unchanged. Only the lab, pet house and blacksmith order changed.

**Laboratory (top of the ranked list)**
- Before (stub meta, shortest first): Wizard 8→9, Skeleton Spell 5→6, Miner 5→6, Giant 9→10, Flame Flinger 1→2, …
- After: **Archer 11→12** (88.0%), **Balloon 10→11** (80.6%, incl. Rocket Balloon 30.4%), **Ice Golem 6→7** (58.1%), **Baby Dragon 7→8** (57.1%, incl. Inferno Dragon), **Poison Spell 7→8** (55.4%), **Sky Wagon 1→2** (49.6%), Minion 10→11 (44.1%, incl. Super Minion), Apprentice Warden 3→4, Dragon 11→12, Troop Launcher 1→2, … Unused at the bottom: Jump Spell, Bat Spell, Wall Wrecker.
- 30-day lab simulation (Gold Pass off): before, Wizard → Skeleton Spell → Miner → Giant → Flame Flinger → Barbarian → Hog Rider → P.E.K.K.A → Wizard. After: **Archer 12 → 13 → 14** (see "Check" below).

**Pet House**
- Before: Mighty Yak 1→2, Poison Lizard 2→3, Diggy 1→2, Electro Owl 2→3, …
- After: **Frosty 10→11** (79.3%), **Greedy Raven 1→2** (48.7%), Poison Lizard 2→3 (29.3%), Angry Jelly 1→2 (23.1%), Diggy 1→2 (10.3%), Electro Owl 2→3. Unused: Mighty Yak, L.A.S.S.I.
- 30-day pet simulation: before, Mighty Yak / Poison Lizard / Diggy levels. After: Frosty 11 → 12 → 13 → 14.

**Blacksmith (ore picks in the 24h forecast)**
- Before: Frozen Arrow, Haste Vial and Heroic Torch 1→2 (360 shiny ore in total).
- After: **Action Figure 26→27** (3600 shiny / 600 glowy / 150 starry), **Eternal Tome 17→18** (2700 / 600 / 0), **Spiky Ball 16→17** (2600 / 0 / 0). Total: **8.9K shiny · 1.2K glowy · 150 starry**. Next: Snake Bracelet, Rocket Backpack, Meteor Staff, Heroic Torch 1→2 (31.7%), Monolith Arrow 1→2.

Plan output excerpt (`npm run plan -- samples/myexport.json`, 16 Nov 2026, 2:01 PM):

```
== Resources needed (upgrades starting in the next 1d) ==
  DE                685K   first needed 2:01 PM (Barbarian King 83)
  gold               52M   first needed Tue 9:25 AM (Firespitter 3)
  Ore (top 3 equipment): 8.9K shiny · 1.2K glowy · 150 starry
    - Action Figure 26→27: 3600 shiny / 600 glowy / 150 starry
    - Eternal Tome 17→18: 2700 shiny / 600 glowy / 0 starry
    - Spiky Ball 16→17: 2600 shiny / 0 glowy / 0 starry

== Lab (top 5) ==
  Archer 11→12 · 4d 12h · 9M elixir — Legend I usage 88.0% (incl. Super Archer 0.2%)
  Balloon 10→11 · 8d 12h · 14M elixir — Legend I usage 80.6% (incl. Rocket Balloon 30.4%)
  Ice Golem 6→7 · 7d 12h · 140K DE — Legend I usage 58.1%
  Baby Dragon 7→8 · 6d · 9.5M elixir — Legend I usage 57.1% (incl. Inferno Dragon 9.6%)
  Poison Spell 7→8 · 6d 12h · 100K DE — Legend I usage 55.4%
== Pet House (top 3) ==
  Frosty 10→11 · 7d · 200K DE — Legend I usage 79.3%
  Greedy Raven 1→2 · 8d · 260K DE — Legend I usage 48.7%
  Poison Lizard 2→3 · 1d 12h · 75K DE — Legend I usage 29.3%
```

(The lab and pet house are still busy with Druid 4 until Thu and Sneezy 7 until Tue, so these picks apply when they free up.)

## Recommended run frequency: daily

A battle log holds the last ~50 battles. For a Legend I player that's about 2 days of Legend attacks (8 a day). **Run `npm run meta` once a day**, and never leave more than 2 days between runs. Weekly runs (the SPEC §8.1 default) would capture only ~2 of every 7 days. A daily run takes about 2 minutes and ~1,040 requests.

To automate it with Windows Task Scheduler: create a daily task with the action `cmd /c cd /d "C:\Users\Ben\Documents\torn\Clash Stuff\Clash Advisor" && npm run meta >> data\meta\last-run.log 2>&1` (`*.log` is git-ignored). The key is tied to your home IP, so the task only works on this network.

`data/meta/battles.jsonl` is **git-ignored**. It's already 3.1 MB and grows ~1.8 MB a day with daily runs. Rows older than 60 days are pruned automatically. `public/meta.json` (18 KB) is committed.

## Check

- [ ] **Archer at #1 in the lab.** Archer is in 88% of Legend I armies, but only ~2.6 per army: it's a filler. Because the meta score is plain usage share (SPEC §8.3), the planner would research Archer 12 → 13 → 14 back to back before Balloon. If that's not what you want, pin Balloon (or whatever you care about) in the Lab tab, or decide whether the score should weight by housing space or average quantity. That's a one-line change in `metaStats`, but it changes the SPEC formula, so I didn't make it.
- [ ] **Frosty 11 → 14 in a row** in the Pet House, for the same reason. Pin Greedy Raven if you'd rather spread levels.
- [ ] **Super troop credit:** Balloon gets Rocket Balloon's 30% on top of its own 50%. Agree that super troop usage should drive the base troop's lab priority?
- [ ] **Equipment ranking ignores ore cost.** Action Figure 26→27 costs 150 starry ore, but it's ranked first purely on usage. Pin cheaper pieces if starry ore is tight.
- [ ] **Unknown event troop IDs** (4000195–4000206) are listed in every run summary. If one turns out to be a permanent, lab-upgradable troop, it needs a clash-of-clans-data update (`npm run sync`).
- [ ] **Hero Hall 13 is out today (Nov 16):** run `npm run sync` once clash-of-clans-data publishes it. That's Step 3 work for the diff output, but the cap logic should pick it up automatically.
