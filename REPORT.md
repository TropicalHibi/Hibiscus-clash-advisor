# Step 1 Report: CoC Upgrade Planner

**Live site:** https://tropicalhibi.github.io/Hibiscus-clash-advisor/ (GitHub Pages; redeploys on every push to `main` once tests pass. To publish fresh meta after `npm run dev` pulls it, run `npm run push-meta`. See SPEC §15.)

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

A battle log holds the last ~50 battles. For a Legend I player that's about 2 days of Legend attacks (8 a day). **Run `npm run meta` once a day**, and never leave more than 2 days between runs. Weekly runs (the original SPEC §8.1 default) would capture only ~2 of every 7 days. A daily run takes about 2 minutes and ~1,040 requests.

This is automated by `npm run dev` (see "Step 2 follow-up" below): it runs `npm run meta` first whenever `public/meta.json` is over 24h old. No OS scheduler needed.

`data/meta/battles.jsonl` is **git-ignored**. It's already 3.1 MB and grows ~1.8 MB a day with daily runs. Rows older than 60 days are pruned automatically. `public/meta.json` (18 KB) is committed.

## Check

- [ ] **Archer at #1 in the lab.** Archer is in 88% of Legend I armies, but only ~2.6 per army: it's a filler. Because the meta score is plain usage share (SPEC §8.3), the planner would research Archer 12 → 13 → 14 back to back before Balloon. If that's not what you want, pin Balloon (or whatever you care about) in the Lab tab, or decide whether the score should weight by housing space or average quantity. That's a one-line change in `metaStats`, but it changes the SPEC formula, so I didn't make it.
- [ ] **Frosty 11 → 14 in a row** in the Pet House, for the same reason. Pin Greedy Raven if you'd rather spread levels.
- [ ] **Super troop credit:** Balloon gets Rocket Balloon's 30% on top of its own 50%. Agree that super troop usage should drive the base troop's lab priority?
- [ ] **Equipment ranking ignores ore cost.** Action Figure 26→27 costs 150 starry ore, but it's ranked first purely on usage. Pin cheaper pieces if starry ore is tight.
- [ ] **Unknown event troop IDs** (4000195–4000206) are listed in every run summary. If one turns out to be a permanent, lab-upgradable troop, it needs a clash-of-clans-data update (`npm run sync`).
- [ ] **Hero Hall 13 is out today (Nov 16):** run `npm run sync` once clash-of-clans-data publishes it. That's Step 3 work for the diff output, but the cap logic should pick it up automatically.

---

# Step 2 follow-up: army-share score + automatic refresh

## What changed

1. **SPEC updated:**
   - Battle log facts: lowercase `battleType`; `legend` = Legend I only; ~50 entries, about 2 days, so meta runs daily.
   - New §9a, automatic refresh with no OS schedulers.
   - New meta score in §8.3.
   - Equipment wording in §6.9/§11. Equipment behaviour is unchanged.
2. **`npm run dev` now refreshes first** (`predev`):
   - Game data: if the last check was over 24h ago, it asks npm for a newer `clash-of-clans-data` and runs the full `npm run sync` if there is one.
   - Meta: if `public/meta.json` is over 24h old and `.env` has a token, it runs `npm run meta` (about 2 min).
   - Any failure (offline, 403, no token) prints one warning line and the site starts anyway.
   - `npm run dev:fast` skips the refresh, and `npm run refresh` runs the refresh on its own.
   - The Task Scheduler instructions are gone from this report.
3. **New lab meta score: average share of army housing space.**
   - **Troops:** for each attack, (qty × housing space) ÷ that army's troop space, 0 if the troop isn't used. This is averaged over all attacks in the 14-day window with the same recency weights.
   - **Super troops:** they use their own housing space and count toward the base troop.
   - **Spells:** the same formula against spell space.
   - **Sieges, pets and equipment:** they keep plain usage share.
   - **Housing data:** it comes from the game data, and was found for every troop and spell. Any unit without it would be listed in the run summary and ranked by usage.
   - **Lab tab:** each row shows the score ("15% of troop space") next to usage % and 3★.
4. **Equipment:** unchanged (usage share, ore cost shown).

**Tests:** 107 pass (up from 91). New tests cover:
- the share formula, recency averaging, super troop housing and crediting;
- the missing-housing fallback, siege/pet/equipment usage scoring and the old-file fallback;
- filler-vs-core ranking, plus a check that all game data has housing;
- every refresh branch (fake npm and API, no network);
- the UI score display.

I mutation-checked the ranking test: sorting by usage again makes it fail. `npm run build` passes.

## Regenerated meta.json (`npm run meta -- --aggregate-only`, no API calls)

```
battles.jsonl:        13629 rows
Aggregated:           13629 attacks by 889 players in the last 14 days (half-life 5d)
Units in meta.json:   122
Housing space:        found for every known troop and spell
Unknown IDs (8):      4000195–4000206 (event troops) and CC spell 26000153, unchanged
```

As a check, the troop shares across all units sum to 99.95% (the rest is the unknown event troops) and the spell shares to 99.93%.

## New top 15 lab order for your export (`samples/myexport.json`)

| # | Upgrade | Score | Used in | Old rank |
|---|---|---|---|---|
| 1 | Sky Wagon 1→2 | 49.6% usage (siege) | 49.6% | 6 |
| 2 | Troop Launcher 1→2 | 30.9% usage (siege) | 30.9% | 10 |
| 3 | Dragon 11→12 | 15.0% of troop space (incl. Super Dragon 1.3%) | 33.9% | 9 |
| 4 | Dragon Rider 2→3 | 12.0% of troop space | 30.3% | 11 |
| 5 | Bowler 5→6 | 10.5% of troop space (all Super Bowler) | 24.8% | 12 |
| 6 | Log Launcher 3→4 | 8.8% usage (siege) | 8.8% | 17 |
| 7 | Balloon 10→11 | 7.8% of troop space (incl. Rocket Balloon 4.1%) | 80.6% | 2 |
| 8 | Flame Flinger 1→2 | 6.0% usage (siege) | 6.0% | 18 |
| 9 | Yeti 6→7 | 5.8% of troop space (incl. Super Yeti 5.4%) | 16.5% | 15 |
| 10 | Poison Spell 7→8 | 5.2% of spell space | 55.4% | 5 |
| 11 | Siege Barracks 3→4 | 4.4% usage (siege) | 4.4% | 20 |
| 12 | Ice Golem 6→7 | 4.1% of troop space | 58.1% | 3 |
| 13 | Baby Dragon 7→8 | 2.6% of troop space (incl. Inferno Dragon 0.9%) | 57.1% | 4 |
| 14 | Apprentice Warden 3→4 | 2.1% of troop space | 35.7% | 8 |
| 15 | Minion 10→11 | 1.8% of troop space (incl. Super Minion 1.5%) | 44.1% | 7 |

**Archer has dropped from #1 to #18** (0.8% of troop space, even though it's in 88% of armies), and Barbarian from #13 to #19.

For reference, the top lab units across Legend I by the new score (whether or not you can upgrade them):
1. Sky Wagon 49.6% usage
2. Troop Launcher 30.9% usage
3. Totem Spell 19.6% of spell space
4. Rage 16.3% of spell space
5. Dragon 15.0% of troop space
6. Revive 13.2%
7. Freeze 12.1%
8. Invisibility 12.1%
9. Dragon Rider 12.0%
10. Healer 10.8%
11. Bowler 10.5%
12. Log Launcher 8.8% usage
13. Earthquake 8.5%
14. Balloon 7.8%
15. Thrower 7.4%

## How your lab queue changed

- **Next 24 hours: no change.** The Laboratory is busy with Druid 4 for 89.8h more and the Goblin Researcher with Wall Breaker 14. Nothing new starts in the forecast window.
- **Builder plan, 24h resources, pets and ore picks: identical.** I diffed `npm run plan -- samples/myexport.json --at-export` before and after: only the five "lab picks" lines changed.
- **30-day lab simulation:**
  - Before: Druid 4 (running, done day 3.7) → **Archer 12 → 13 → 14** (days 3.7–30.7).
  - After: Druid 4 → **Sky Wagon 2 → 3 → 4** (days 3.7–43.2; 22M elixir for the first level alone).
- Lab picks in the plan: Archer, Balloon, Ice Golem, Baby Dragon, Poison was the old order. It's now **Sky Wagon, Troop Launcher, Dragon, Dragon Rider, Bowler**.

## Check

- [ ] **Sieges now lead the lab, and the reason is the scale, not the meta.** As specified, sieges keep plain usage share (Sky Wagon 49.6%), while troops are scored by share of troop space (top troop: Dragon 15.0%). The two numbers measure different things, so any well-used siege beats every troop. Spell shares are also bigger than troop shares, because an army has far fewer spell slots. Options I didn't take, because they change your formula:
  - rank sieges by usage × a factor (e.g. ÷ 3);
  - normalise each kind against its own top unit;
  - interleave kinds.
- [ ] **Back-to-back levels are still possible.** The score is per unit, not per level, so whatever ranks first gets every level in a row: Sky Wagon 2, 3 and 4 fill about 40 days of lab time. Pin something else in the Lab tab to break it up, or consider a per-level decay.
- [ ] **Balloon fell from #2 to #7.** It's in 81% of armies but averages only 7.8% of troop space. That's what the new formula measures; pin it if you're running a balloon army.
- [ ] **Refresh on a newer data release** hasn't run for real yet (0.19.1 is still the newest), and neither has a stale-meta pull from `predev`. Both paths are covered by tests with fake npm/API. The first `npm run dev` after tomorrow ~3 PM will do a real meta pull (about 2 min) before the site starts.

---

# Lab sections + normalized lab pick

## What changed

- **Lab tab split into three sections: Troops, Spells, Sieges.**
  - Each is ranked by its own score: share of troop space, share of spell space, or siege usage share.
  - Unused items sit at the bottom of each section, and pins still work.
- **Lab queue pick, used by the scheduler and the 24h forecast:**
  - Each unit's score is divided by the **top score of its kind in Legend I**, so each kind's #1 is 1.0.
  - That is multiplied by a kind weight: troops 1.0, spells 0.7, sieges 0.5. The weights are in `config/settings.sample.yaml` under `lab.kindWeights` and editable in the Settings tab.
  - The highest value across the three kinds is the next research. Pinned items still go first, and consecutive levels are allowed.
  - **Why the Legend I top and not your own best?** Dividing by your own best upgrade would make each kind's #1 exactly 1.0 every time, so the top troop would always win and spells and sieges would never be picked.
- **"Next in lab" line** at the top of the Lab tab: the pick, its kind, and its value against the top pick of the other two kinds. It also says when the lab frees up.
- **Pet House and Blacksmith:** unchanged.
- **SPEC Step 3:** item images were added to the plan (only used images bundled, lazy-loaded, text fallback). Not built.

**Tests:** 115 pass (up from 107), and `npm run build` passes. The new tests cover:
- the weight settings;
- normalizing against the Legend I top rather than your own candidates;
- the pick order and ties, and weights changing the scheduler's pick and the forecast;
- pins, and section ranking;
- the "Next in lab" line and the weight inputs in the UI.

I mutation-checked one case: removing the weight from the pick value fails two tests.

meta.json was regenerated from the existing battles (13,629 attacks, 889 players, no API calls). The Legend I top scores per kind are: troop 15.0% (Dragon), spell 19.6% (Totem Spell), siege 49.6% (Sky Wagon).

## New lab order for your export (`samples/myexport.json`)

**Next in lab: Dragon 11→12** (troop · pick value 1.00 vs top spell Poison Spell 0.19, top siege Sky Wagon 0.50), starting when Druid 4 finishes (day 3.7).

**Troops** (by share of troop space)
| # | Upgrade | Score | ÷ top | Pick value | Used in |
|---|---|---|---|---|---|
| 1 | Dragon 11→12 | 15.0% | 1.00 | 1.00 | 33.9% |
| 2 | Dragon Rider 2→3 | 12.0% | 0.80 | 0.80 | 30.3% |
| 3 | Bowler 5→6 | 10.5% | 0.70 | 0.70 | 24.8% |
| 4 | Balloon 10→11 | 7.8% | 0.52 | 0.52 | 80.6% |
| 5 | Yeti 6→7 | 5.8% | 0.39 | 0.39 | 16.5% |

**Spells** (by share of spell space; weight 0.7)
| # | Upgrade | Score | ÷ top | Pick value | Used in |
|---|---|---|---|---|---|
| 1 | Poison Spell 7→8 | 5.2% | 0.26 | 0.19 | 55.4% |
| 2 | Skeleton Spell 5→6 | 1.4% | 0.07 | 0.05 | 14.7% |
| 3 | Recall Spell 2→3 | 0.8% | 0.04 | 0.03 | 4.4% |
| 4 | Lightning Spell 9→10 | 0.4% | 0.02 | 0.02 | 1.8% |
| 5 | Clone Spell 6→7 | 0.3% | 0.02 | 0.01 | 0.4% |

**Sieges** (by usage share; weight 0.5)
| # | Upgrade | Score | ÷ top | Pick value | Used in |
|---|---|---|---|---|---|
| 1 | Sky Wagon 1→2 | 49.6% | 1.00 | 0.50 | 49.6% |
| 2 | Troop Launcher 1→2 | 30.9% | 0.62 | 0.31 | 30.9% |
| 3 | Log Launcher 3→4 | 8.8% | 0.18 | 0.09 | 8.8% |
| 4 | Flame Flinger 1→2 | 6.0% | 0.12 | 0.06 | 6.0% |
| 5 | Siege Barracks 3→4 | 4.4% | 0.09 | 0.04 | 4.4% |

**Combined lab queue order:**
1. Dragon 1.00
2. Dragon Rider 0.80
3. Bowler 0.70
4. Balloon 0.52
5. Sky Wagon 0.50
6. Yeti 0.39
7. Troop Launcher 0.31
8. Ice Golem 0.27

## 30-day lab queue (Gold Pass off)

| Days | Research |
|---|---|
| 0.0 – 3.7 | Druid → 4 (running) |
| 3.7 – 13.7 | **Dragon → 12** |
| 13.7 – 28.7 | **Dragon → 13** |
| 28.7 – 36.7 | **Dragon Rider → 3** |

Earlier versions for comparison: plain usage share gave Archer 12 → 13 → 14; army share with sieges at raw usage gave Sky Wagon 2 → 3 → 4. The next 24 hours are unchanged, because the lab is busy with Druid 4.

## Check

- [ ] **Your spells barely register.** Your best spell upgrade is Poison at 0.26 of the top spell. The spells Legend I leans on (Totem, Rage, Revive, Freeze, Invisibility) aren't among your current upgrades: they're maxed for your lab level or not unlocked. With weight 0.7, spells won't be picked for a long time. Raise the spell weight in Settings if you want Poison sooner.
- [ ] **Dragon twice in a row (25 days)**, as asked (repeats allowed). Pin Dragon Rider or Sky Wagon to break it up.

---

# Review fixes (REVIEW.md)

**Status:** findings 1, 3–15 and 17–19 are fixed. Finding 16 (bundle size) is skipped for v2, as asked. Finding 2 turned out not to be a bug and was replaced by the parallel-research rule below. `npm test` passes (**182 tests in 10 files**, up from 115; one weak test was replaced by a stronger one) and `npm run build` succeeds. SPEC.md has the new rules and resolves all 13 "Spec ambiguities". The reasoning is in DECISIONS.md under "review fixes".

## New rules
- **Laboratory first.** Tier 0 is now Laboratory upgrade → new unbuilt buildings → Archer Queen, in both modes. The Lab upgrade never holds the TH gate. The Pet House stays in the offense tier.
- **Research runs alongside building upgrades.** The Laboratory and the Pet House can upgrade while research runs, and research keeps going during their upgrades. The scheduler no longer blocks either.

## What changed per finding

| # | Change |
|---|---|
| 1 | A merge now needs its sources at their max level **at the merge's unlock TH**, so a newer TH adding source levels can't raise the bar. A merge only holds the TH gate if its sources can actually reach that level at your TH. Test: the TH19 scenario from the review (Wizard Tower 18 added) now merges the Super Wizard Towers and upgrades the TH. Before, it never upgraded the TH. |
| 2 | Not a bug (see "Research runs alongside building upgrades" above). Tested for both buildings. |
| 3 | A lab kind with weight 0 is never started automatically (scheduler, forecast, "Next in lab"). It stays listed in its Lab tab section, at the bottom of the queue order, marked "not auto-picked". A pin still overrides it. |
| 4 | The merge-consumption check runs in the browser and shows a Plan-tab warning. The planner never suggests building copies of a merge source that `merges.yaml` doesn't explain. |
| 5 | Supercharges are offered when the base is at its max **for your TH**, so a TH19 level no longer removes TH18 supercharges. |
| 6 | Top builder priorities, the lab / pet / equipment lists, "Next in lab" and the book-ready list now use the state at "now", so upgrades that finished since the export are counted. |
| 7 | `npm run sync` installs the newest release **within the current major** and checks it. If it won't load, sync puts back the last known-good version and records the failure. `npm run dev` then warns on every start until a sync succeeds, without reinstalling the bad version each time. |
| 8 | A TH weapon upgrade no longer starts the next-TH merge prep; only a Town Hall upgrade does. |
| 9 | Players a meta run couldn't fetch are retried first by the next run (within 7 days), so "the next run retries them" is now true. |
| 10 | An export timestamp more than 5 minutes in the future gives a clock warning. The test fixture is now dated 21 Sep 2026 (only its timestamp changed). |
| 11 | Fixture redaction drops league group tags, any other tag value and player profile stats. The committed `player.json` was re-redacted without any API call, and a test scans every fixture for leftover tags. **The old tag `#8UG890J` is still in git history.** Removing it needs a history rewrite and force-push, which I didn't do without asking. |
| 12 | A rankings location that keeps failing is skipped (401/403 still stop the run). The server's `Retry-After` is honoured. |
| 13 | `npm run plan -- <path>` with a missing file now errors instead of planning `samples/`. |
| 14 | Dead code removed. Building levels are derived in one place. The engine uses the recipe's unlock TH. |
| 15 | `builderCandidates` is split into small generators. Each candidate gets its final tier once, in one function. |
| 17 | An unknown cost resource in the data shows a warning. `super-troops.yaml` points at the real check. |
| 18 | The book threshold is tested against a modified data copy (a 9-day level raises it to 9d). "One upgrade at a time" is checked for every building lock over 30 days. Gold Pass is tested on research, pet and supercharge jobs. |
| 19 | Both UI test suites run on a fixed clock. |

**Spec ambiguities**, as now written in SPEC.md:
1. The TH waits for the gate.
2. The required source level is taken at the unlock TH.
3. Weight 0 = listed, never auto-picked, pins override.
4. Research runs in parallel with building upgrades.
5. Ranked lists reflect "now".
6. The lookahead runs only while the Town Hall itself upgrades, covers TH+1, ranks after the current gate, and never holds it.
7. Supercharge needs the base at its max for your TH.
8. Builders = huts + B.O.B.
9. Merges rank as defenses inside Tier 0.
10. The TH weapon is tier 5 at max TH.
11. Meta staleness = last aggregation, and partial failures are retried.
12. The book-ready list shows Gold-Pass time when the toggle is on.
13. Ore counts the next level only.

**New tests** (68), covering:
- `tests/engine-rules.test.ts`: Tier 0 order in both modes; parallel research for the Lab and the Pet House; TH19 deadlock; unreachable sources; busy merge sources; gate order; weight 0; unknown merges; supercharges; "now" lists; TH weapon in both modes; clock skew; custom hero order; crafted-module lock; every-lock check; horizon edge; Gold Pass; book threshold vs data; wall dump; equipment order; pins across meta files.
- `tests/tooling.test.ts`: every sync branch; refresh warnings; the real Node wiring with fake npm; meta run (clean, exit 2 + carry-over, resume, `--fresh`, maxPlayers change, prune/dedupe, 403 abort); API retries, `Retry-After`, skipped locations; redaction.
- `tests/edges.test.ts`: aggregation window edges; empty armies; future timestamps; a siege in both the home army and the Clan Castle; encoded and repeated army codes; validation that must fail; throwing localStorage; old saved settings.
- `tests/ui.test.ts`: an export without a timestamp.

## Plan before / after

**Your export** (`npm run plan -- samples/myexport.json --at-export`): **identical** before and after. Your Laboratory is maxed, nothing is unbuilt and every merge is done, so none of the new rules change your builders, lab, pets, resources or walls.

As of now (16 Nov, 4:13 PM, export 1d 8h old), finding 6 shows. The priority list now includes the heroes whose upgrades finished since the export, matching "Now". Grand Warden is listed as book-ready at 77→78 without "(after current upgrade)", because that upgrade is done:

```
== Now ==
  B3: start Barbarian King → 83 (195K DE, 5d) — Hero #4 in order; not book-ready (raw next level 5d < 8d threshold)
  B4: start Royal Champion → 38 (180K DE, 5d) — Hero #5 in order; not book-ready (raw next level 5d < 8d threshold)
  B5: start Minion Prince → 53 (110K DE, 4d) — Hero #6 in order; not book-ready (raw next level 4d < 8d threshold)

== Top builder priorities right now ==
  [T2 Heroes] Barbarian King 82 → 83 · 5d · 195K DE — …
  [T2 Heroes] Royal Champion 37 → 38 · 5d · 180K DE — …
  [T2 Heroes] Minion Prince 52 → 53 · 4d · 110K DE — …
  [T5 Permanent defenses] Firespitter 2 → 3 · 15d · 29M gold — Permanent defense, longest first (LPT)

== Book-ready heroes (your call) ==
  Grand Warden 77→78: 25.5M elixir, 8d
  Dragon Duke 22→23: 440K DE, 8d (after current upgrade)
```

Before this fix, the priority list at the same moment would have left out BK 83 and RC 38, because it still treated them as upgrading.

**Committed fixture** (`npm run plan -- tests/fixtures/export-th16.json --at-export`, TH16 rush). Besides the new date, the Laboratory moves to Tier 0, ahead of the Town Hall. The Lab upgrade starts while Balloon 4 keeps researching, which is now allowed. 24h totals are unchanged (75M elixir, 16M gold, 30K DE), and only their order changed because elixir is now needed first.

```diff
 == Now ==
-  B4: start Town Hall → 17 (16M gold, 10d) — Rush: Town Hall upgrade, TH gate clear (…)
-  B5: start Laboratory → 14 (13M elixir, 9d) — Offense building (non-hero)
+  B4: start Laboratory → 14 (13M elixir, 9d) — Tier 0: Laboratory upgrade first (research speed and new lab levels)
+  B5: start Town Hall → 17 (16M gold, 10d) — Rush: Town Hall upgrade, TH gate clear (…)
   B6: start Barracks → 18 (15M elixir, 9d) — Offense building (non-hero)
   PET: start L.A.S.S.I → 3 (30K DE, 1d 12h) — …

 == Top builder priorities right now ==
+  [T0 Laboratory + new buildings + Archer Queen] Laboratory 13 → 14 · 9d · 13M elixir — Tier 0: …
   [T1 Town Hall path + TH gate] Town Hall 16 → 17 · 10d · 16M gold — …
-  [T2 Offense] Laboratory 13 → 14 · 9d · 13M elixir — Offense building (non-hero)
   [T2 Offense] Barracks 17 → 18 · 9d · 15M elixir — …
```

## Check
- [ ] **Laboratory first:** on a rushed account the Lab now beats the Town Hall and the Queen for the first free builder. Agree in practice?
- [ ] **Weight 0 + pins:** a pinned item is researched even if its kind's weight is 0. Say if you'd rather weight 0 win.
- [ ] **What blocks a data update:** only data that can't be loaded or has broken levels. A merge `merges.yaml` doesn't know yet installs anyway and shows a Plan-tab warning. Say if you'd rather that block the update too.
- [ ] **Git history:** say if you want `#8UG890J` removed from history (it needs a force-push to `main`).


# Step 3 Report: Polish (last step of v1)

**Status:** all five Step 3 items are built and pushed to `main`. `npm test` passes (**229 tests in 14 files**, up from 189; none of the old tests changed). `npm run build` succeeds. The GitHub Pages workflow passed on the first run after its actions were bumped and deployed the site. SPEC.md has the new rules (§3.1, §3.2, §4, §9, §10.1, §11, §12, §13, §14). The reasoning is in DECISIONS.md under "Step 3".

## What was built

### 1. Full `npm run sync` (SPEC §9)
- After validation, sync writes a snapshot of the normalized data (the `Item` model only) to `data/snapshots/<date>_<version>.json`, once per data version.
- It then prints the changes since the previous version's snapshot: new / removed items, new / removed levels, renames, and cost, time and requirement changes per level. Lines look like `Archer Tower 21: 18d → 16d`, `Gold Mine 17: 8M gold → 7.2M gold`, `NEW: Town Hall 19 (…)`, `NEW ITEM: …`, `REMOVED ITEM: …`. A test checks each kind on a modified copy of the data (changed cost, changed time, new level, new item, removed item).
- The diff is saved to **`public/data-changes.json`**. The Plan tab shows a dismissible **"Game data updated: N changes"** banner with the list, the first time the site loads that version (until you dismiss it).
- **Snapshots are not committed:** each one is ~0.33 MB, and a new one comes with every data release. The folder is git-ignored and keeps the newest two. `data-changes.json` is small and is committed, so the live site gets the banner too.
- The validation checks and the known-good rollback are unchanged. A snapshot problem is a warning, never a failed sync.
- New flag: **`npm run sync -- --offline`** checks and snapshots the installed version without asking npm. I used it to record the baseline snapshot for 0.19.1. I didn't run a real `npm run sync`, so no new data version was installed during this step (Hero Hall 13 is due today). **Your next `npm run dev` or `npm run sync` will install it, print the diff against this baseline and write the banner file.** Commit `public/data-changes.json` together with `package.json` / `package-lock.json`.

### 2. Everything tab (SPEC §11)
- A new tab lists every upgrade left at your **current** Town Hall, from "now". It comes from one full scheduler run with the Town Hall frozen, so the time to max respects every builder, tier, lock and helper. It isn't a plain sum.
- **On top:** builder time to max (with and without Gold Pass), when the Lab and the Pet House finish, total cost per resource and total ore.
- **One collapsible section per tier**, named after the tier. Each shows the number of upgrades, builder time (raw and with Gold Pass), cost per resource and when the tier's last job finishes. Inside, rows are summed per item (e.g. "Cannon · 14 upgrades · 19 → 21").
- Laboratory, Pet House, Blacksmith (ore) and Walls sections, each with its own totals. A **Not scheduled** section holds book-ready hero levels, lab kinds with weight 0, and the next Town Hall in rush mode.

### 3. Hero order drag-reorder
- **Drag a hero row** to reorder it on desktop. The **↑ / ↓ buttons** are still there for phones. The new **"Reset hero order to default"** button restores AQ > GW > DD > BK > RC > MP. The order is saved in your browser.
- The card now says the Archer Queen's Tier 0 rule belongs to the Queen herself, wherever she sits in the list, and her row is marked "· Tier 0". A test moves her to last place and checks that she still gets Tier 0, and that the custom order changes the other heroes' order.

### 4. Active boosts and helpers in the scheduler (SPEC §10.1)
- **Boosts** *(rules corrected in "Follow-up: helpers, boosts, unknown jobs" below)* from the export speed up their queue while they last: Builder Potion ×10 for builders, Research Potion ×24 for the lab and pet house, Builder Bite ×2, Study Soup ×4. The Clock Tower is Builder Base only, so it's ignored. An unknown boost shows a warning, not a crash.
- **Helpers** *(cycle corrected to 23 h in the follow-up below)*: once a day, the Builder's Apprentice takes its level in hours off one builder job, and the Lab Assistant does the same for the running research (L8 = 8 h, L7 = 7 h, from the game data). They help the job the export says they repeat on, if it's running. Otherwise the Apprentice takes the builder job with the most time left and the Assistant takes the research. They never help a Goblin job. Helper hours that passed since the export count too.
- **Alchemist:** `config/id-overrides.yaml` maps `93000003 → alchemist`, so its unknown-ID warning is gone. It doesn't affect timing.
- **New setting "Simulate helpers and boosts"** (on by default). Off = exactly the old raw timers, so you can compare. The Plan tab summary names your helpers and their next work hour, and timeline rows show `helpers −8h` where a helper helped. `npm run plan -- <file> --no-helpers` does the same in the terminal.

### 5. Item images
- Every item in the Plan, Lab / Pets / Equipment and Everything tabs (and the hero order list) has its icon next to it. The images load lazily, have a fixed size so the layout doesn't jump, and disappear if they fail to load (name only, no broken-image icon).
- **Only one image per item is bundled**, not the 52 MB folder: its icon, else its top-level picture. Your levels are only known in your browser, so a per-level picture would mean shipping every level.
- ~~Size cap of 300 KB per image~~ → replaced by build-time resizing (see "Follow-up: icons resized with sharp" below). **Every item now has an icon.**

### 6. CI
- `.github/workflows/pages.yml` now uses `actions/checkout@v7`, `actions/setup-node@v7`, `actions/upload-pages-artifact@v5` and `actions/deploy-pages@v5`. All run on Node 24. The run after the bump passed (test → build → deploy). Its only annotation is GitHub's notice that `ubuntu-latest` moves to Ubuntu 26; there's no Node 20 deprecation warning.

## What your real export says about boosts and helpers
- **`boosts` is empty (`{}`):** nothing was running when you exported, so the real shape is still unseen. The planner reads the keys the coc.py parser documents (`builder_boost`, `lab_boost`, `builder_consumable`, `lab_consumable`, `clocktower_boost`, `clocktower_cooldown`, `helper_cooldown`).
- **Helpers:** Builder's Apprentice L8, Lab Assistant L7, Prospector L2, Alchemist L1. Each has `helper_cooldown: 8426` (≈2 h 20 m until they could work again), which I read as one shared cooldown.
- **The repeat flag is called `helper_recurrent`** in your file (coc.py calls it `recurrent_helper`; both work). It's on **Grand Warden** (the Builder's Apprentice) and on **Druid** (4000123, the Lab Assistant). There's no `helper_timer` field (a helper mid-hour) in your file. *(Corrected: an earlier version of this report said the Lab Assistant was on Archer.)*

## Plan before / after with helpers (your export, `npm run plan -- samples/myexport.json`, Mon 16 Nov 4:57 PM, export 1 d 9 h old)

```diff
-Helpers: not simulated (Settings → Simulate helpers and boosts is off)
+Helpers: Builder's Apprentice L8 (−8h/day), Lab Assistant L7 (−7h/day); next work hour Tue 10:16 AM
 …
   B2 (Builder 2):
     busy: Scattershot → 3, done Tue 9:25 AM (in 16h 28m)
-    free Tue 9:25 AM → Firespitter 3 (29M gold, 15d)
+    free Tue 9:25 AM → Scattershot 4 (11.5M gold, 8d)
   B4 (Builder 4):
-    Grand Warden → 77 finished since the export
+    Grand Warden → 77 finished since the export · helpers −8h
   B6 (Builder 6):
-    busy: Dragon Duke → 22, done Tue 1:36 PM (in 20h 39m)
-    free Tue 1:36 PM → Scattershot 4 (11.5M gold, 8d)
+    busy: Dragon Duke → 22, done Tue 5:36 AM (in 12h 39m) · helpers −8h
+    free Tue 5:36 AM → Firespitter 3 (29M gold, 14d 16h) · helpers −8h
   LAB (Laboratory):
-    busy: Druid → 4, done Thu 1:41 AM (in 2d 8h)
+    busy: Druid → 4, done Wed 4:41 AM (in 1d 11h) · helpers −21h
 …
-  gold   52M   first needed Tue 9:25 AM (Firespitter 3)
+  gold   52M   first needed Tue 5:36 AM (Firespitter 3)
```

What happened:
- Sunday's work hour went to Grand Warden (the repeat target), which finished earlier.
- Monday's went to Dragon Duke: Grand Warden was done, so it fell back to the builder job with the most time left. DD now frees up 8 h earlier and takes the 15-day Firespitter, which gets Tuesday's hour.
- The Lab Assistant is set to repeat on Druid, which was researching, so it helped Druid on all three days (3 × 7 h).
- "Now", the top priorities, the 24 h totals (685K DE, 52M gold) and the walls line are unchanged.

**Long run** (Everything tab, everything left at TH18):

| | Helpers off | Helpers on |
|---|---|---|
| Builders done (no Gold Pass) | 552d 15h | **521d 9h** |
| Builders done (Max Gold Pass) | 442d 2h | **417d 11h** |
| Laboratory done | 1311d 16h | **1019d 10h** |
| Pet House done | 519d 19h | 519d 19h (the Assistant doesn't help pets) |

Everything tab for your account (helpers on): Heroes 49 upgrades (286d raw / 229d with Gold Pass, 10.4M DE); Permanent defenses 558 (2205d / 1764d, 4.2B gold); Temporary 224 (619d / 495d); Laboratory 145; Pet House 90; Blacksmith 448 levels (1M shiny, 72K glowy, 6.8K starry ore); Walls 4.3B gold or elixir; Not scheduled 51 book-ready hero levels.

**Committed fixture** (`npm run plan -- tests/fixtures/export-th16.json`): it has no helpers or boosts, so its plan is the same as before Step 3 (Laboratory → 14 and Town Hall → 17 first, Rage Spell 4 in the lab).

## Bundle size

| | Before Step 3 | After |
|---|---|---|
| `dist/` total | 992 KB (4 files) | **9.8 MB** (175 files) |
| JS bundle | 981.8 kB (140.3 kB gzip) | 1,009 kB (149.7 kB gzip) |
| Images | none | **171 files, 8.8 MB** (one per item, ≤ 300 KB each) |
| Without the size cap | | 21 MB (190 files) |

The images are lazy-loaded, so a page only downloads the icons on screen. The Everything tab's sections start closed, so their icons load when you open one. *(Superseded: the follow-up below resizes every icon, and the build is now 2.0 MB.)*

## Check in-game
- [x] ~~Helper time savings / cycle~~ → confirmed by you: L hours saved, shared 23-hour cycle (follow-up below).
- [ ] **Repeat target not upgrading:** when a helper's repeat target isn't upgrading, the planner assumes it helps the default job instead (Apprentice: the builder job with the most time left; Assistant: the running research). In-game, does it do that, or does it sit idle? (Your Lab Assistant repeats on Druid, which is researching, so this doesn't affect your plan today.)
- [ ] **Boosts:** ~~key names, Bite, Research Potion on pets~~ → answered in the follow-up below. Still open: Study Soup ×4 (my guess), the Pet Potion's export key (assumed `pet_boost`), and whether an export `timer` already includes a running potion.
- [ ] **Hero Hall 13 / new data:** run `npm run dev` (or `npm run sync`). Check that the printed diff and the Plan-tab banner make sense, then commit `public/data-changes.json` with `package.json` / `package-lock.json`.
- [x] ~~Icons: 16 items show their name only~~ → fixed by the sharp follow-up: all items have an icon.
- [ ] Not changed, but noticed: timeline end times show only the weekday ("done Wed 9:25 AM" for a 15-day job lands two weeks later). Say if you want dates there.


## Follow-up: icons resized with sharp

**Status:** `sharp` is now a dev dependency. Every item image the site uses is resized to a **96×96 WebP** at build time, both locally and in the GitHub Pages workflow. The 300 KB cap is gone, so **every item has an icon (226 of 226; before: 20 without)**. `npm test` passes (**235 tests in 15 files**) and `npm run build` succeeds.

**How it works:**
- `vite build` picks one image per item (as before, but without the size cap), shrinks it with sharp to 96×96 (whole picture kept, transparent edges, WebP quality 80), and ships the small file.
- **Cache:** results go to `.cache/item-images/` (git-ignored), named by a hash of the original image, so an unchanged image is never processed again. A new data release only resizes the pictures that changed. Icons that are no longer used are deleted.
- **In CI** an `actions/cache` step keeps that folder between workflow runs, so the Pages build doesn't redo them either.
- `npm run dev` and the tests still use the original files, so they never need sharp.
- Build log line: `190 icons at 96px: 0 resized, 190 from cache (55 ms)`. A cold build resized all 190 in 0.8 s.

**Build size** (`npm run build:pages`):

| | Before Step 3 | Step 3 (300 KB cap) | Now (96 px WebP) |
|---|---|---|---|
| `dist/` total | 992 KB (4 files) | 9.8 MB (175 files) | **2.0 MB** (194 files) |
| Images | none | 171 files, 8.8 MB | **190 files, 0.65 MB** (avg 3.4 KB) |
| JS bundle | 981.8 kB (140.3 kB gzip) | 1,009 kB (149.7 kB gzip) | 1,017 kB (153.3 kB gzip) |
| Items without an icon | — | 20 | **0** |

The 1 MB of JS is the bundled game data (REVIEW finding 16, left for v2), not images.

**Also fixed:** every build printed a Vite warning about extensionless imports in `vite.config.ts`'s import chain. They now use `.ts` extensions.


## Follow-up: helpers, boosts, unknown jobs

**Status:** all five fixes are done, with tests. `npm test` passes (**245 tests in 16 files**) and `npm run build` succeeds. SPEC §3.2, §10.1 and §10.3 are updated; the reasoning is in DECISIONS.md under "follow-up: helpers, boosts, unknown jobs".

**What changed:**
1. **Running upgrades on unknown ids hold their slot.** Any export entry with a `timer` keeps its builder / lab / pet slot (or goblin slot) busy until the timer ends, even when the game data doesn't know the id yet. The timeline shows it as "Unknown item <dataId> (not in game data yet)". In your export that's building **1000106** (level 0, under construction), so all 6 builders are busy and nothing is offered on B6.
2. **Helpers:** a shared **23-hour** cycle (it was 24 h), starting from the export's `helper_cooldown`. Level L saves L hours. A Builder Potion or Bite running in the same hour adds its own progress but never multiplies the Apprentice's.
3. **Boosts:**
   - Builder Potion ×10, plus Builder Bite at +1× (both together = ×11).
   - `clocktower_cooldown` is never applied.
   - The Research Potion speeds up the **Laboratory only**. The Pet House has its own Pet Potion (×24); I assumed its export key is `pet_boost`.
4. **Wording:** your Lab Assistant is on **Druid (4000123)**, not Archer. Fixed above and in DECISIONS.md.
5. **Dates:** finish times more than 6 days away now show the date, e.g. "Tue Nov 24, 9:24 AM".

**Your new export** (`npm run plan -- samples/myexport.json --at-export`, Mon 16 Nov 5:16 PM). The summary now reads `Helpers: Builder's Apprentice L8 (−8h/day), Lab Assistant L7 (−7h/day); next work hour Tue 10:19 AM · Boosts: Builder Potion 59m left`.

```diff
 == Now ==
-  B6: start Barbarian King → 83 (195K DE, 4d 15h) — Hero #4 in order; not book-ready (raw next level 5d < 8d threshold)
+  No builder/lab/pet slot is free right now.
```

```diff
   B6 (Builder 6):
-    free 5:16 PM → Barbarian King 83 (195K DE, 4d 15h, done Sat 8:19 AM)
+    busy: Unknown item 1000106 (not in game data yet) → 1, done Tue 3:00 PM (in 21h 44m)
+    free Tue 3:00 PM → Scattershot 4 (11.5M gold, 8d, done Wed Nov 25, 3:00 PM)
   PET (Pet House):
-    free Tue 9:24 AM → Frosty 11 (200K DE, 7d, done Tue 9:24 AM)
+    free Tue 9:24 AM → Frosty 11 (200K DE, 7d, done Tue Nov 24, 9:24 AM)
```

- 1000106's 30.7 h timer ends after 21 h 44 m, because the running Builder Potion speeds it up like any builder job.
- Barbarian King now starts on B4 at 11:51 PM. The heroes and defenses on B1, B2 and B5 shift by one slot accordingly.
- Grand Warden (Apprentice, −8 h) and Druid (Lab Assistant, −7 h) get their work hour at Tue 10:19 AM. The next one, 23 h later, falls outside the 24 h window.
- New warnings: 1000106 "still occupies a slot", and two unknown equipment ids (90000062, 90000063), ignored. Data 0.19.1 doesn't have them yet; the next `npm run sync` should bring them in.

**Still to check in-game:** the Pet Potion's export key (assumed `pet_boost`; an unknown key would show a warning), Study Soup ×4, and whether a helper whose repeat target isn't upgrading helps another job or sits idle.
