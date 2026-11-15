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
