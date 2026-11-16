# Code review: CoC Upgrade Planner

Reviewed at commit `2c21605` (16 Nov 2026) against SPEC.md, with REPORT.md and DECISIONS.md as context. This is a review only: no source, config, test or spec file was changed.

## Summary

**Overall health: good.** The engine is a pure function of state, and `builderCandidates` is regenerated at every event, so there is very little hidden mutable state. Decisions are logged carefully. The data layer joins on `dataId` everywhere, splits supercharge levels out, and derives the book threshold and hero caps from per-level data as SPEC requires. The token handling is clean. Tests pass, the build passes, and the plan for the committed fixture matches SPEC §6 by hand, apart from one in-game rule (finding 2).

Most of the risk is in what happens when the data changes or the clock moves, not in today's data.

**Top 3 risks**
1. **The rush TH can be blocked forever after a data update** (finding 1). The required merge-source level is the source's all-time max in the data. If a new TH adds a level to Cannon, Archer Tower or Wizard Tower, any rushed player with an unperformed merge never gets a Town Hall upgrade again. I reproduced this: a simulated TH19 release gave 0 Town Hall jobs in a 1-year simulation.
2. **The plan says "start" for things the game won't allow, and some lists are stale.** The Laboratory or Pet House is upgraded while it is researching (finding 2). This shows up in the committed fixture's "Now" section. Separately, the ranked lists and "Next in lab" are computed from the export-time state, not from "now" (finding 6).
3. **A new data release can break things without a clear error.** A merge that `merges.yaml` doesn't know yet makes the planner suggest buildings the player can't build (finding 4). Supercharges stop being offered once their base building gets a new level (finding 5). `npm run sync` installs `@latest` before validating, with no rollback (finding 7).

## Results

| Step | Result |
|---|---|
| `npm ci` (working copy) | **Failed (EPERM).** The user's `npm run dev` (Vite, PID 30568) held `node_modules/@rolldown/binding-win32-x64-msvc/rolldown-binding.win32-x64-msvc.node` open. npm had already deleted most of `node_modules`, so I restored it with `npm install` against the lockfile. `package.json` and `package-lock.json` are unchanged (`git status` clean). |
| `npm ci` (fresh clone in a temp dir) | OK, 52 packages. Install scripts for `esbuild@0.28.2` were blocked by `allowScripts`. That's harmless: the build still worked. |
| `npm test` (fresh clone) | **115 passed, 7 files**, 2.2 s. The "real export" test is skipped there because `samples/` is absent, as intended. |
| `npm run build` (fresh clone) | OK. `dist/assets/index-*.js` is **978.7 kB** (139 kB gzip). The size warning is turned off (finding 16). |
| `npm run plan -- tests/fixtures/export-th16.json` | Runs. Checked by hand below. |
| Live API / `npm run meta` / `npm run dev` | Not run, as instructed. |

### Plan sanity check: `tests/fixtures/export-th16.json`, checked against SPEC §6

| Check | Expected (SPEC) | Output | OK? |
|---|---|---|---|
| Mode | TH16 < max TH18 → rush | `mode: RUSH` | ✓ |
| Tier 0 | No unbuilt buildings (the fixture is complete); Queen at her Hero Hall 9 cap → skipped | no T0 rows | ✓ |
| TH gate | TH16 merges (Ricochet ×2, Multi-Archer ×2) done → gate clear → TH first | `B4: start Town Hall → 17` at T1 | ✓ |
| Tier 2 order | Lab, (Army Camp maxed), Barracks, Dark Barracks, Spell Factory, … | B5 Lab, B6 Barracks, then Dark Barracks at +3h, Spell Factory at +20h | ✓ |
| Heroes | BK and GW upgrading, the rest at the Hero Hall cap → none | none | ✓ |
| Goblin | Gold Mine job runs out at +5h, no new work | `GB … done 8:39 PM`, nothing after | ✓ |
| 24h totals | gold 16M (TH); elixir 13+15+23+24 = 75M; DE 30K (L.A.S.S.I) | 16M / 75M / 30K | ✓ |
| Gold Pass max | New jobs −20%, running timers unchanged | TH 10d → 8d; Lab 9d → 7d 4h; X-Bow still "1d 6h" | ✓ |
| Wall line | Lowest wall level with a next level at TH16 | `Lv 16→17 … 325 walls` | ✓ |
| Lab pick | Rage 16.3% ÷ top spell 19.6% = 0.83 × 0.7 = 0.58 > Archer 0.05 | `lab pick 0.58` | ✓ |
| **In-game rule** | The Laboratory can't be upgraded while it researches | `B5: start Laboratory → 14` while `LAB busy: Balloon → 4` for 2d | **✗ (finding 2)** |
| Baseline | The export timestamp is 15 Jan 2027, in the future | `Export taken 1/15/2027 (0s ago) · now 11/16/2026` | ✗ (finding 10) |

---

## Findings (most severe first)

Every finding below was checked against the code. Findings marked **[repro]** were also reproduced with a throwaway script run against the real modules, outside the repo.

### 1. HIGH: the TH gate can deadlock the rush Town Hall when a merge source gains a level in a newer TH [repro]
- **Where:** [src/data/normalize.ts:320](src/data/normalize.ts#L320), [src/engine/tiers.ts:253](src/engine/tiers.ts#L253), [src/engine/tiers.ts:265](src/engine/tiers.ts#L265), [src/engine/tiers.ts:295](src/engine/tiers.ts#L295)
- **What's wrong:** `requiredSourceLevel` is the source's last level in the whole data set. A merge job counts against the gate whenever enough source instances *exist* (`complete`), even if the sources can never reach the required level at the player's TH. The source-upgrade loop then skips the upgrade (`next.thRequired > lv.th → continue`), so nothing can ever clear the gate. The TH candidate is only pushed when `gateOpen` is empty, so it never appears.
- **Scenario:** Data adds Wizard Tower 18 at TH19 (maxTH 19). A TH18 player, now in rush mode, has 6 Wizard Towers at 17 and no Super Wizard Tower yet. Result: `requiredSourceLevel = 18`, no Town Hall candidate, no Super Wizard Tower candidates, and **0 Town Hall jobs in a 365-day simulation**. The same happens for Cannon or Archer Tower (Ricochet, Multi-Archer, Multi-Gear) if a TH19 level is added. The DECISIONS "gate guard" only covers *missing* sources, not unreachable levels.
- **Fix:** Derive the required level per merge as the source's max level at the merge's unlock TH (`maxLevelAt(src, { th: unlockTH })`), or keep it per TH. Also, only add a merge to `gateOpen` when every allocated source can reach that level at the current TH. Add the scenario above as a test using a modified copy of the data.

### 2. HIGH: the Laboratory or Pet House is upgraded while it is researching (an impossible "Now" instruction)
- **Where:** [src/engine/scheduler.ts:196-201](src/engine/scheduler.ts#L196-L201) (only blocks research while the building upgrades), [src/engine/tiers.ts:307-312](src/engine/tiers.ts#L307-L312) (Lab and Pet House are plain offense candidates)
- **What's wrong:** In-game, the Laboratory and Pet House can't be upgraded while research runs. The scheduler enforces only the reverse rule. This is logged in DECISIONS ("would starve lab upgrades in a greedy sim"), but the result is wrong for every rushed account whose lab is busy.
- **Scenario:** Committed fixture: `B5: start Laboratory → 14 (13M elixir, 9d)` at t=0 while `LAB busy: Balloon → 4` until +2d. The 24h forecast counts that 13M elixir and the timeline shows a builder busy on an upgrade the game rejects. REPORT's "doesn't affect you" applies only to the maxed real account.
- **Fix:** Make the Lab and Pet House builder candidates ineligible while their research slot is busy (pass a busy-queue flag into `builderCandidates`). Then, when the research ends, let the scheduler decide between starting the next research and upgrading the building. A simple rule: when the Lab upgrade is the top builder pick and research is about to finish, hold the research. Even without the hold, not suggesting the impossible move is strictly better than now.

### 3. MEDIUM: lab kind weight 0 does not mean "never auto-pick that kind" [repro]
- **Where:** [src/engine/queues.ts:195-204](src/engine/queues.ts#L195-L204), [src/engine/scheduler.ts:201](src/engine/scheduler.ts#L201)
- **What's wrong:** A weight of 0 only sets `pickValue = 0`. The next tie-break puts *used* items ahead of unused ones, then sorts by `normScore`. So a weight-0 kind still beats every unused item, and among weight-0 kinds the higher `normScore` wins. The scheduler takes `[0]` unconditionally.
- **Scenario:** Weights `{troop: 0, spell: 0, siege: 0}` → the scheduler still starts **Rage Spell 4**. Weights `{troop: 1, spell: 0, siege: 0}` still pick spells whenever no used troop is left. The Settings tab text says "0 = never auto-pick that kind" ([src/main.ts:144](src/main.ts#L144)).
- **Fix:** Exclude weight-0 kinds from the auto-pick (filter them out before taking `[0]` in the scheduler and forecast, but keep them in the Lab tab sections). Or rank them after unused items. Add a test.

### 4. MEDIUM: a merge missing from `merges.yaml` produces "build new" suggestions the player can't follow [repro]
- **Where:** [src/engine/tiers.ts:182-194](src/engine/tiers.ts#L182-L194), [src/data/normalize.ts:245](src/data/normalize.ts#L245)
- **What's wrong:** Missing buildings = `count − consumedBy − owned`, where `consumedBy` comes only from known recipes. When a data release adds a merge before `merges.yaml` is updated, the merged defense is categorised as a plain `defense` and its sources' consumption is unknown. The consumption check fails in `npm test` and in `npm run sync`'s output, but the site uses the new data anyway. The predev refresh runs sync automatically, so the user may never see that output.
- **Scenario:** With the Super Wizard Tower recipe removed (standing in for "TH19 adds a merge"), a maxed TH18 account gets **4 Tier-0 "New building available: Wizard Tower"** suggestions, ahead of the Queen and everything else, forever. In rush mode they would also hold the TH gate.
- **Fix:** At load time, run `checkMergeConsumption` in the browser and show a warning on the Plan tab (the function is cheap and already pure). Also skip planned builds for any item that has `countAfterMerges` but no recipe, rather than suggesting builds from the raw `count`.

### 5. MEDIUM: supercharge eligibility uses the base building's data max, not its max at the player's TH [repro]
- **Where:** [src/engine/tiers.ts:357](src/engine/tiers.ts#L357)
- **What's wrong:** `inst.level < base.levels[base.levels.length - 1].level` compares against the top level across all THs.
- **Scenario:** Today a maxed TH18 account gets 4 X-Bow supercharge candidates. Add one X-Bow level at TH19 and that drops to **0**: every TH18 player loses all supercharge suggestions on the day TH19 data ships.
- **Fix:** Use `maxLevelAt(base, { th: lv.th })`. Note that the supercharge export field (`supercharge`) is still unverified (DECISIONS), so add a test with a synthetic supercharge entry at the same time.

### 6. MEDIUM: ranked lists and "Next in lab" use export-time state, not "now" [repro]
- **Where:** [src/engine/plan.ts:137-140](src/engine/plan.ts#L137-L140) (busy set from `account.instances`), used for `topCandidates` (line 172), `lab`/`labByKind` (157, 177) and `pets` (178); [src/ui/labView.ts:63-64](src/ui/labView.ts#L63-L64)
- **What's wrong:** The simulation applies jobs that finished since the export, but the ranked lists are built from the raw export: finished upgrades still count as busy, at their old level, and Lab, TH or Hero Hall upgrades that finished don't unlock anything.
- **Scenario:** Archer research finished 1h before "now". The Lab tab still leaves Archer out of the lists, and "Next in lab" reads *"starts when Archer 4 finishes (in 0s)"* while the simulation has already started a new research at t=0. The same happens for "Top builder priorities right now": a hero finished since the export is missing from the list (the real-export REPORT shows RC 38 in "Now" but not in the priority list).
- **Fix:** Have `simulate` return (or expose) the engine state at t=0 after completing due jobs, and build `topCandidates`, `lab` and `pets` from that state. Only show the "starts when" clause when `busy.end > 0`.

### 7. MEDIUM: `npm run sync` installs `@latest` before validating, with no rollback, so a bad release sticks
- **Where:** [scripts/sync.ts:216](scripts/sync.ts#L216), [scripts/sync.ts:224](scripts/sync.ts#L224), [scripts/lib/refresh.ts:69-72](scripts/lib/refresh.ts#L69-L72), [src/main.ts:232-236](src/main.ts#L232-L236)
- **What's wrong:** `npm install clash-of-clans-data@latest` rewrites `package.json`/lock, so it can jump a major version. Only then does `loadGameDataNode()` run, which throws on a renamed merge id (`merges.yaml: … not found`). The refresh logs "sync failed" and doesn't save the check time, but on the next start `latest === installed`, so it prints "game data up to date" and never warns again. Meanwhile the site shows only "Failed to load game data".
- **Scenario:** 0.20.0 renames `wizard-tower`. The first `npm run dev` prints one warning line. Every later start says "up to date" and the site is broken until someone runs `npm run sync` by hand and reads the error.
- **Fix:** Validate before committing to the new version: install into a temp dir or `npm pack`, normalize, and keep the old version on failure. Or record the "last good" version in `refresh-state.json` and restore it. At minimum, pin the install to the current major (`clash-of-clans-data@^0`) and have the refresh keep warning while the installed data fails to normalize.

### 8. LOW: a TH weapon upgrade triggers the "TH-upgrade lookahead" [repro]
- **Where:** [src/engine/tiers.ts:140](src/engine/tiers.ts#L140), [src/engine/tiers.ts:198](src/engine/tiers.ts#L198), [src/engine/scheduler.ts:164-167](src/engine/scheduler.ts#L164-L167)
- **What's wrong:** The weapon job locks `thInst.uid`, and `thBusy = busy.has(thInst.uid)`, so the merge scope jumps to TH+1 while only the weapon is upgrading. SPEC §6.3 limits the lookahead to "while the TH is upgrading".
- **Scenario:** TH17 with one X-Bow unbuilt (gate open). Builder 1 takes the X-Bow and builder 2 takes Inferno Artillery (TH17), which is the top T1 item when the TH is gated. From then on, 4 Wizard Tower upgrades labelled "TH-upgrade lookahead" sit in tier 1, ahead of all offense.
- **Fix:** Base `thBusy` on `thInst.upgradingTo !== undefined` (the TH itself), not on the shared lock.

### 9. LOW: partial meta failures are not retried "on the next run" under the predev cadence
- **Where:** [scripts/lib/refresh.ts:104](scripts/lib/refresh.ts#L104), [scripts/meta.ts:79](scripts/meta.ts#L79), [scripts/meta.ts:181](scripts/meta.ts#L181)
- **What's wrong:** Exit code 2 still writes `meta.json` with a fresh `generatedAt`, so the refresh waits 24h. By then `run-state.json` is older than `STATE_MAX_AGE_MS` (24h from `startedAt`) and gets discarded, so the failed players are only fetched again if a new gather happens to include them. The log line "the next run retries them" is untrue unless the user reruns by hand within 24h.
- **Fix:** Either age the run state from its last update rather than from `startedAt`, or change the message to say "rerun `npm run meta` within 24h to retry them".

### 10. LOW: a future export timestamp is clamped silently, and the committed fixture has one
- **Where:** [src/engine/scheduler.ts:66](src/engine/scheduler.ts#L66), [src/engine/planText.ts:238](src/engine/planText.ts#L238), [tests/helpers.ts:10](tests/helpers.ts#L10)
- **What's wrong:** `Math.max(0, now − timestamp)` hides clock skew. The fixture's `T0 = 1_800_000_000` (15 Jan 2027) prints "(0s ago)" while "now" is two months earlier.
- **Fix:** When the timestamp is more than a few minutes in the future, add a plan warning ("export timestamp is in the future; check the device clock"). Consider moving `T0` into the past so the fixture reads realistically.

### 11. LOW: probe redaction leaks a league-group tag and leaves fingerprintable player stats
- **Where:** [scripts/probe.ts:26-31](scripts/probe.ts#L26-L31), [tests/fixtures/api/player.json:34](tests/fixtures/api/player.json#L34)
- **What's wrong:** Redaction is keyed on field names (`tag`, `opponentPlayerTag`, …). `previousLeagueGroupTag: "#8UG890J"` survives, alongside exp level, trophies, war stars and every achievement value. Together these can re-identify the third-party player. The token itself is fine: there are no JWT-like strings anywhere in git history, and no `samples/`, `.env`, `battles.jsonl` or state files were ever committed.
- **Fix:** Redact any string value matching `^#[0-9A-Z]{3,}$` that isn't already a pseudonym, and drop achievement values and `*LeagueGroupTag`. Add a test that scans `tests/fixtures/api/*.json` for `#` tags outside `#PLAYERn`/`#CLANn`.

### 12. LOW: one location's ranking failure aborts the whole meta run, and `Retry-After` is ignored
- **Where:** [scripts/lib/collect.ts:217-220](scripts/lib/collect.ts#L217-L220), [scripts/lib/api.ts:76-82](scripts/lib/api.ts#L76-L82)
- **What's wrong:** Any non-404 error from a country's rankings (e.g. a 503 after 5 retries) is rethrown by `gatherPlayers`. Run state is only saved after the gather, so the run exits 1 and the next start re-gathers from scratch. A 429 waits 1–16 s regardless of the server's `Retry-After`.
- **Fix:** Skip a failing location (log it) unless it's 401/403. Use `Retry-After` when it's present.

### 13. LOW: `npm run plan -- <typo>` silently plans the private export instead
- **Where:** [scripts/plan.ts:20-21](scripts/plan.ts#L20-L21)
- **What's wrong:** If the given path doesn't exist, the candidate list falls through to `samples/my-export.json` / `samples/myexport.json`.
- **Fix:** Use the fallbacks only when no positional argument is given. Otherwise exit with "file not found".

### 14. LOW: dead code and duplicated derivations
- `bookThreshold()` ([src/engine/book.ts:5](src/engine/book.ts#L5)) and `metaScore()` ([src/meta/meta.ts:91](src/meta/meta.ts#L91)) are never called.
- `superchargeUpgrading` is written in [src/engine/scheduler.ts:159-162](src/engine/scheduler.ts#L159-L162) and never read.
- `MergeRecipe.unlockTH` ([src/data/normalize.ts:316](src/data/normalize.ts#L316)) is computed but the engine re-derives it from `countPerTH` ([src/engine/tiers.ts:222-229](src/engine/tiers.ts#L222-L229)). Only a test reads it.
- `'hero-banner'` in `OFFENSE_ORDER` ([src/engine/tiers.ts:77](src/engine/tiers.ts#L77)) can never match: the item is skipped at load (no `dataId`).
- The lab and pet house IDs are hard-coded in [src/engine/scheduler.ts:199](src/engine/scheduler.ts#L199) instead of using `IDS.laboratory` / `IDS.petHouse`.
- TH, Hero Hall, lab, pet house and blacksmith levels are derived twice: `parseExport` fields and `levelsOf()`.
- **Fix:** Delete the dead pieces, use `IDS`, and have the engine read `recipe.unlockTH`.

### 15. LOW: `builderCandidates` is one 270-line function
- **Where:** [src/engine/tiers.ts:124-391](src/engine/tiers.ts#L124-L391)
- **What's wrong:** Heroes, TH and weapon, planned builds, merge allocation, the gate, generic tiers, supercharges, and two re-tiering passes that overwrite `tier`/`order`/`reason` after the fact all live in one function. Findings 1, 5 and 8 all live here, and the post-hoc re-tiering makes it hard to see which tier a candidate really ends in.
- **Fix:** Split it into `heroCandidates`, `thCandidates`, `mergePlan` (returning candidates plus `gateOpen`), `genericCandidates` and `superchargeCandidates`, and assign the final tier once.

### 16. LOW: the 979 kB bundle is mostly raw game JSON, and the size warning is turned off
- **Where:** [src/data/loadBrowser.ts:5-8](src/data/loadBrowser.ts#L5-L8), [vite.config.ts:5](vite.config.ts#L5)
- **What's wrong:** Every field of about 1.8 MB of JSON (descriptions, image paths and so on) is bundled eagerly, and normalized in the browser on every load. That's fine on localhost, but slow on the phone use SPEC §11 mentions.
- **Fix:** Normalize at build time: a small Vite plugin, or emit `public/data.json` from `npm run sync`. Ship only the `Item` model and restore the default chunk warning.

### 17. LOW: small fragile assumptions
- `mapResource` maps any unknown resource string to `gold` silently ([src/data/normalize.ts:42-43](src/data/normalize.ts#L42-L43)). A new cost type would be mis-summed in the forecast. Warn instead.
- [config/super-troops.yaml:6](config/super-troops.yaml#L6) cites `scripts/verify-super-troops.ts`, which doesn't exist. The check is the ID-order test in `tests/meta.test.ts`.

### Test-quality findings

#### 18. LOW: tests that pass even if the rule breaks
- **"threshold = longest hero level in the data (not hard-coded)"** ([tests/engine.test.ts:80-84](tests/engine.test.ts#L80-L84)) compares against today's data, whose max is 8d. `bookThresholdSec = 8 * 86400` would pass. Fix: normalize a modified copy of the data with a 9d hero level and expect 9d.
- **"each building instance gets one upgrade at a time"** ([tests/scheduler.test.ts:59-65](tests/scheduler.test.ts#L59-L65)) only checks the Town Hall. Fix: assert no overlapping jobs per lock uid across the whole timeline, including crafted-defense modules sharing a `parentUid`.
- **"Gold Pass max shortens new builder and research jobs"** ([tests/scheduler.test.ts:67-77](tests/scheduler.test.ts#L67-L77)) asserts only the TH and one running timer. Research and supercharges (named in SPEC §10.2) aren't checked.

#### 19. LOW: the UI tests depend on the wall clock
- **Where:** [tests/ui.test.ts:78](tests/ui.test.ts#L78), [tests/ui.test.ts:106](tests/ui.test.ts#L106), [tests/ui-nometa.test.ts:16](tests/ui-nometa.test.ts#L16)
- **What's wrong:** `main.ts` uses `Date.now()` with a fixture timestamped 2027-01-15. The assertions "Archer first (Balloon is busy)" and "starts when Balloon 4 finishes" currently hold only because of the elapsed clamp (finding 10) and the export-time lists (finding 6). Fix finding 6 and after 2027-01-17, when Balloon's 2-day timer ends, these become date-dependent.
- **Fix:** Use `vi.useFakeTimers({ now: T0 * 1000 })` (or `vi.setSystemTime`) in both UI suites.

---

## How a TH19 data release would play out

| Change in the data | Current behaviour | OK? |
|---|---|---|
| New TH level | `maxTH` → 19; TH18 flips to rush; book threshold and hero caps recomputed on load | ✓ |
| New levels on merge sources (Cannon, Archer Tower, Wizard Tower) | `requiredSourceLevel` jumps; unperformed merges block the rush TH forever | ✗ finding 1 |
| New levels on supercharge bases | TH18 supercharges disappear | ✗ finding 5 |
| New merge | Validation fails in `npm test`/sync output only; site suggests unbuildable source copies | ✗ finding 4 |
| New merge counts at TH19 for existing merges | Handled: jobs are generated per extra count via `countPerTH` | ✓ |
| `countAfterMerges` only at some THs | `countAt` uses the nearest TH ≤ the player's; consumption check passes today | ✓ |
| New TH weapon | Keyed `1000001:w19`, and the weapon resets to 1 on TH completion | ✓ |
| Guardians moving off the Town Hall | Guardians are categorised by **folder** (`guardians/`), excluded from planned builds, and placed in tier 6. If the package moves them into another folder (e.g. `defenses/`) they become `defense`: tier 5, plus Tier-0 "build new" suggestions, plus TH-gate blockers. A changed `townHallRequired` is followed automatically. I couldn't confirm the new layout because it isn't published yet. | ⚠ check on sync |
| Breaking schema / renamed ids | `normalize` throws; sync leaves the bad version installed | ✗ finding 7 |

---

## Spec ambiguities

1. **§6.3 "Town Hall upgrade itself (as soon as it's available)" contradicts the TH gate** ("everything that must be done before the next TH upgrade"). DECISIONS reads it as "as soon as the gate allows". The SPEC should say so.
2. **§7 "Required source level = max level of the source defense in the data"** is only correct while no newer TH adds source levels (finding 1). It should probably be "max level at the merge's unlock TH" or "the in-game merge requirement".
3. **§6.7 "0 = never auto-pick that kind" vs "Unused items (value 0) come last"**: a used item of a weight-0 kind also has value 0. Is it excluded, or ranked with the unused items? (Finding 3.)
4. **The Lab/Pet House research-vs-upgrade rule isn't in SPEC.** §6.6 says "each building instance can only have one upgrade at a time" but doesn't mention the lab's research slot. (Finding 2.)
5. **§11 "Now" / "Top builder priorities right now"** doesn't say whether the ranked lists reflect "now" (export + elapsed, §10.1) or the export state. (Finding 6.)
6. **§6.3 lookahead** doesn't say where next-TH merge-source upgrades rank relative to the current gate and the TH weapon, or whether a TH *weapon* upgrade counts as "the TH upgrading". (Finding 8.)
7. **Supercharge eligibility** isn't defined (at max for the current TH? at max TH only?). §5's "max level at a given TH" rule isn't applied to it. (Finding 5.)
8. **§3.2 "Builder count = number of Builder's Huts"** vs DECISIONS adding B.O.B's Hut. Probably right, but SPEC should list B.O.B.
9. **§6.2 "order by the tier the building would normally belong to"**: in max-TH mode merges have no "normal" tier (the gate is tier 3, merged-defense upgrades are tier 5). DECISIONS chose defenses. SPEC is silent.
10. **§6.4 max-TH tiers** don't mention the TH weapon. DECISIONS puts it in tier 5. Harmless at TH18 (no weapon), but it matters if max TH ever has one.
11. **§9a staleness** is keyed on `meta.json.generatedAt`, which `--aggregate-only` also refreshes, and §9a's "a failed check is retried on the next start" doesn't cover partial meta failures (finding 9). SPEC should say whether staleness means "last collection" or "last aggregation".
12. **§6.5 book-ready list "with cost/time"**: raw or Gold-Pass time isn't specified. The code shows raw while the plan shows boosted times.
13. **§10.3 ore for "the top-N blacksmith picks"**: only the next level of each piece is counted. SPEC doesn't say whether consecutive levels of the top piece should count instead (as the lab queue allows).

---

## Missing tests

**Priority engine**
- A merge source whose required level needs a higher TH than the player's (finding 1). Expect the TH not to deadlock.
- The Lab or Pet House not suggested while its research runs, and research blocked while the building upgrades (the second half exists in code but isn't asserted).
- Supercharge candidates: eligibility at max for the TH, temporary tier, LPT, Gold Pass boost, `supercharge` export field.
- TH weapon: rush tier-1 position after the TH, shared TH lock, max-TH tier 5, no lookahead while only the weapon upgrades.
- Tier 0 in **max-TH** mode (new building before the Queen before offense), and the Queen ahead of a gated TH in rush mode.
- A custom `heroOrder` actually reorders hero candidates.
- A merge with a busy source isn't offered; max-TH gate items ordered by unlock TH, then `merges.yaml` order.
- Lookahead covers TH+1 only (Multi-Gear isn't worked from TH15 — partly covered) and never counts against the gate.
- Crafted-defense modules: one module upgrade at a time per crafted defense (`parentUid` lock).

**Scheduler / forecast**
- Ranked lists and "Next in lab" after jobs finished since the export (finding 6).
- A future export timestamp, and a missing timestamp using the import time (UI path).
- Forecast window boundary: a job starting exactly at 24h is excluded; `startNow` only at t=0.
- Gold Pass on research and supercharge jobs; book-ready list stays raw.
- Wall dump with several wall levels, where the lowest is maxed for the TH.

**Lab / pets / blacksmith**
- Kind weight 0 never auto-picks (finding 3).
- Unused equipment ordered by starry, then glowy, then shiny ore; pins across all three lists after a meta refresh.

**Meta pipeline**
- `scripts/meta.ts` end-to-end with a fake client: resume from `run-state.json`, `--fresh`, maxPlayers mismatch, pruning of rows older than 60 days, the dedupe-on-load pass, exit code 2, and 401/403 abort.
- API client: 401/403 not retried; network-error retries exhausted; `Retry-After`.
- Aggregation edges: a row exactly 14 days old, empty armies, future timestamps, a siege in both `u` and `i`.
- Army code: a URL-encoded payload, repeated sections.
- Probe redaction: no unredacted `#` tags in `tests/fixtures/api` (finding 11).

**Refresh / data**
- `scripts/refresh.ts` wiring (real `execSync`/`spawnSync` deps): `npm view` timeout → one warning, exit code 0.
- `checkMergeConsumption` and `checkLevels` negative cases: a removed recipe or a level gap must produce an error (today they're only asserted to be clean).
- The book threshold following the data (finding 18).

**UI / storage**
- `localStorage` throwing on get/set; old saved settings without `lab.kindWeights` falling back to the YAML weights.
- UI suites on fake timers (finding 19).
