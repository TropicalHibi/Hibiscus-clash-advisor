# Code review 2: CoC Upgrade Planner

Reviewed at commit `5a10704` (17 Nov 2026) against SPEC.md, with DECISIONS.md, REPORT.md and the first review (REVIEW.md) as context. This is a review only: no source, config, test, workflow or spec file was changed. The live Clash of Clans API, the developer site, ClashKing's GitHub, `npm run meta`, `npm run sync`, `npm run dev` and the workflows were not used. Everything below comes from the committed code, fixtures and pinned data.

## Summary

**Overall health: good.** 17 of the 19 REVIEW.md findings are fixed, and the other 2 were skipped on purpose (table below). The ClashKing normalizer is careful: it joins on dataId, applies the level offset only to upgrade-style items, reads TH requirements generically, and checks merges with a consumption test. The TH gate can no longer deadlock on merge-source levels, and helpers, boosts and unknown running jobs follow SPEC §10.1. The secrets handling in the meta Action is sound: the token is masked, error text is redacted, nothing secret reaches the artifacts or the `meta-data` branch, and `dist/` is clean. I checked the plan for the committed fixture by hand against SPEC §6 and §10 and it is correct.

The new risks are mostly at the boundary between the automation and changing data. They are not in the engine's handling of today's data.

**Top 3 risks**
1. **The daily data update will refuse ClashKing's first new building level** (finding 1). One test requires clash-of-clans-data to have an image for ClashKing's top level, and another hard-codes `maxTH === 19`. The Action runs `npm test` before it commits. So when ClashKing ships a level before clash-of-clans-data does (SPEC §9 expects that to happen), the live site keeps the old data and an issue reopens every day. A local sync plus push would also fail the Pages workflow. I reproduced both.
2. **When TH20 ships, the rush Town Hall can deadlock again** (finding 2), this time from a building the data counts but gives no levels (Guardian Shrine). The same kind of item, while under construction, also frees its builder in the plan (finding 3). I reproduced both: 0 Town Hall jobs in a 365-day simulation, and 6 of 6 builders handed new work while one is busy.
3. **Local copies and CI drift apart.** The predev refresh writes files that are committed (`public/meta.json` from a local meta run, `data/clashking/` from a local sync). After that, `git pull --ff-only` refuses the Action's next commit to the same files on every start (finding 4). Separately, a re-pointed ClashKing release tag makes the Action fail every day with "no diff was produced" (finding 5).

### Status of REVIEW.md findings

| # | Finding | Status | Evidence |
|---|---|---|---|
| 1 | TH gate deadlock on merge-source levels | **Fixed** | The required level is `merge_requirement`'s exact level, or the source's max at the merge's unlock TH ([normalize.ts:115-120](src/data/normalize.ts#L115-L120)). A merge holds the gate only if every source can reach it at the current TH ([tiers.ts:403-404](src/engine/tiers.ts#L403-L404)). Covered by the "no TH gate deadlock" tests in `tests/engine-rules.test.ts`. |
| 2 | Lab / Pet House upgraded while researching | **Intentionally skipped** | Overruled by the owner: in-game the research and the building upgrade run in parallel. SPEC §6.6 and §10.1 now say so, and the scheduler blocks neither ([scheduler.ts:366](src/engine/scheduler.ts#L366)). |
| 3 | Lab kind weight 0 still auto-picked | **Fixed** | `autoPick = weight > 0` and `nextResearch()` skips those items ([queues.ts:42-44](src/engine/queues.ts#L42-L44), [queues.ts:158](src/engine/queues.ts#L158)). |
| 4 | A merge missing from `merges.yaml` suggests unbuildable copies | **Fixed** | `dataIssues()` runs the consumption check in the browser ([plan.ts:33-40](src/engine/plan.ts#L33-L40)). No copies are planned for an item that has `countAfterMerges` but no recipe ([tiers.ts:332](src/engine/tiers.ts#L332)). |
| 5 | Supercharge eligibility used the data-wide max | **Fixed** | Uses `maxLevelAt(base, { th })` ([tiers.ts:547](src/engine/tiers.ts#L547)). See spec ambiguity 2 for a data quirk. |
| 6 | Ranked lists built from the export-time state | **Fixed** | `simulate()` returns `nowState`, and `buildPlan` ranks from it ([plan.ts:108-112](src/engine/plan.ts#L108-L112)). "Starts when" appears only for a job with `end > 0` ([labView.ts:67](src/ui/labView.ts#L67)). The wall line still uses the export-time state (finding 12). SPEC doesn't list it. |
| 7 | `npm run sync` installed `@latest` with no rollback | **Fixed** | Updates stay within the current major, a known-good version is restored on failure, and `dataFailure` warns on every start ([sync.ts:66-147](scripts/lib/sync.ts#L66-L147)). ClashKing gets its own validate-before-replace step ([scripts/lib/clashking.ts:85-184](scripts/lib/clashking.ts#L85-L184)). |
| 8 | A TH weapon job triggered the TH lookahead | **Fixed** | `thUpgrading` is keyed on `thInst.upgradingTo` ([tiers.ts:301](src/engine/tiers.ts#L301)). |
| 9 | Partial meta failures weren't retried | **Fixed** | Players a run failed are carried over to the next run for 7 days ([metaRun.ts:110-120](scripts/lib/metaRun.ts#L110-L120)). |
| 10 | Future export timestamps clamped silently | **Fixed** | A plan warning appears past 5 minutes ([scheduler.ts:129-131](src/engine/scheduler.ts#L129-L131)). The fixture's `T0` is now in the past. |
| 11 | Probe redaction leaked tags and stats | **Fixed** | Handled in [redact.ts](scripts/lib/redact.ts). Every `#` tag in `tests/fixtures` is now `#PLAYERn`, `#CLANn` or `#TEST`. `#8UG890J` is still in git history, which is accepted. |
| 12 | One location failure aborted the run; `Retry-After` ignored | **Fixed** | A failing location is skipped and reported through `onSkip` ([collect.ts:79](scripts/lib/collect.ts#L79)). `Retry-After` is honoured with a 60 s cap ([api.ts:78](scripts/lib/api.ts#L78), [api.ts:109](scripts/lib/api.ts#L109)). |
| 13 | `npm run plan -- <typo>` planned the private export | **Fixed** | An explicit path that doesn't exist is now an error ([plan.ts:21-25](scripts/plan.ts#L21-L25)). |
| 14 | Dead code and duplicated derivations | **Fixed** (new strays in finding 12) | `bookThreshold`, `metaScore`, `superchargeUpgrading` and `hero-banner` are gone. Levels come from one `levelsOf()`, and the engine reads `recipe.unlockTH`. |
| 15 | `builderCandidates` was one 270-line function | **Fixed** | It is now split into generators plus a single `place()`. `tiers.ts` is still 594 lines. |
| 16 | Bundle size | **Intentionally skipped** (v2), partly improved | The main chunk went from 979 kB to 776 kB (117.5 kB gzip) because the clash-of-clans-data backup moved to a lazy chunk. The data is still normalized in the browser. |
| 17 | `mapResource` silent fallback; stale script reference | **Fixed** | An unknown resource now produces a warning, and `config/super-troops.yaml` no longer cites a missing script. |
| 18 | Tests that pass even if the rule breaks | **Fixed** | The book-threshold test uses modified data with a 9-day level. The lock test checks every `lockUid`. Gold Pass is tested on research and supercharges. |
| 19 | UI tests depend on the wall clock | **Fixed** | All four UI suites use `vi.useFakeTimers({ now: T0 * 1000 })`. |

## Results

| Step | Result |
|---|---|
| Fresh clone (temp dir, `core.autocrlf=true` as on this PC) + `npm ci` | OK: 58 packages, 13 s, 0 vulnerabilities. The `esbuild` install script was blocked by `allowScripts`, which is harmless. |
| `npm test` | **1 failed, 344 passed (345, 21 files), 5.8 s.** The one failure is `tests/data-update.test.ts > …reports any failure as one issue per version`: the Windows checkout has CRLF line endings and the test's regex expects `\n` (finding 6). After converting that workflow file to LF, the suite passes 15/15. This was the only failure in the clean clone. |
| `npm run build` | OK. `index-*.js` **776.2 kB** (117.5 kB gzip), lazy `cocBackupBrowser-*.js` **823.2 kB** (90.9 kB gzip), CSS 7.9 kB, 187 icons resized to 96 px (cold cache 793 ms). `dist/` is 2.7 MB. |
| `npm run build:pages` | OK. `index-*.js` **780.6 kB** (117.9 kB gzip). All 187 icons came from the cache. `index.html` references `/Hibiscus-clash-advisor/assets/…`. `dist/` contains only `index.html`, `meta.json`, `data-changes.json` and `assets/` (187 WebP + 2 JS + 1 CSS). No token, email, `.env` or `samples/` string appears in `dist/`. |
| `npm run plan -- tests/fixtures/export-th16.json` | Runs. Checked by hand below. |
| Data-change experiments (throwaway, in the temp clone, reverted) | A 10 % cost and time cut on 464 building levels: the suite still passes. One new Cannon level: **1 test fails** (finding 1). TH20 plus two new building levels: **5 tests fail**. |

### Plan sanity check: committed fixture vs SPEC §6 and §10

The fixture is TH16, exported 21 Sep 2026 (57 days before "now"), with 6 builders, no helpers and no boosts.

| Check | Expected (SPEC) | Output | OK? |
|---|---|---|---|
| Mode | TH16 < max TH19 → rush | `mode: RUSH`, max TH19 | ✓ |
| Jobs finished since the export | Applied before planning (§10.1). Goblin job never rescheduled. | X-Bow, BK, GW, Balloon, Gold Mine (GB) shown as "finished since the export". Nothing new on GB. | ✓ |
| Tier 0 | Laboratory → new buildings → Queen (Queen at the HH9 cap, so skipped) | B1 Laboratory 14, B2 Squad Barracks (new) | ✓ |
| TH gate | TH17 requires Eagle Artillery 7 (EA at 6), plus the new Squad Barracks → no Town Hall candidate | B3 `TH gate: TH17 requires Eagle Artillery 7`. No Town Hall in "Now" or the top 15. | ✓ |
| Tier 2 | Offense order: Barracks, Dark Barracks, Spell Factory, … | B4–B6 in that order, then Clan Castle, Workshop, Blacksmith, Pet House | ✓ |
| Lab pick | Rage 0.82 × 0.7 = 0.57 > Balloon 0.51 × 1 | `LAB: start Rage Spell → 4 … lab pick 0.57` | ✓ |
| 24 h totals | Elixir 13 + 1.7 + 15 + 15.5 + 16 + 1 = 62.2M. Gold 14M (EA). DE 30K (L.A.S.S.I). No ore. | 62.2M / 14M / 30K, no ore rows | ✓ |
| Dates | Clock today, weekday within 6 days, date beyond | "Thu 11:02 AM" (2 d), "Thu Nov 26, 11:02 AM" (9 d) | ✓ |
| Walls | Lowest wall level with a next level at TH16 | `Lv 16→17 … 325 walls` | ✓ |
| Warnings | The planted unknown helper 93000099 warns | Listed | ✓ |

---

## New findings (most severe first)

Every finding was checked against the code. **[repro]** means I also reproduced it with a throwaway script, run outside the repo against the real modules and a temp clone.

### 1. HIGH: `npm test` is tied to today's data and to clash-of-clans-data, so the daily data update blocks the first ClashKing release that adds a level [repro]
- **Where:** [tests/step3.test.ts:528-529](tests/step3.test.ts#L528-L529), [tests/engine.test.ts:22](tests/engine.test.ts#L22), gate in [.github/workflows/data-update.yml:50-55](.github/workflows/data-update.yml#L50-L55) and [.github/workflows/pages.yml:38](.github/workflows/pages.yml#L38)
- **What's wrong:** The image test expects Cannon's image to be `level-<ClashKing's top Cannon level>.png`. Images come from clash-of-clans-data, which lags ClashKing; SPEC §9 calls this "which source updated first". The production code copes: `pickItemImages` falls back to the next existing image. Only the test fails. `expect(data.maxTH).toBe(19)` hard-codes today's max TH. The Action commits only if `npm test` passes on the new data. The Pages workflow also runs `npm test` before deploying.
- **Scenario:** ClashKing v0.1.21 adds Cannon 22 at TH19, and clash-of-clans-data has no `level-22.png` yet. In my temp-clone run, `npm test` gave 1 failed, 344 passed. The Action commits nothing, keeps the old data on the live site, and opens an issue, then reopens it every day until clash-of-clans-data publishes the image. If the owner runs `npm run sync` locally and pushes, Pages fails at `npm test` and deploys nothing (including later meta commits) until a test is edited. With TH20 plus two new building levels, 5 tests fail (`maxTH toBe(19)`, the image test, and three max-TH tier tests that index `[0]` of an empty filter and throw `Cannot read properties of undefined`).
- **Fix:** Make data-dependent assertions relative. Assert that the chosen image exists and is the highest level that clash-of-clans-data has, and replace `toBe(19)` with `data.maxTH === max(TH levels in the raw file)`. Separate "rule" tests (on fixed fixtures or `modifiedData`) from "current data" tests, and have the data-update Action run the rule tests plus the validation tests rather than snapshot-style facts. As a guard, add a CI test that runs the suite on a mutated copy of the pinned data (a new top level for a few items), the same way I did here.

### 2. HIGH: TH-gate deadlock from a building the data counts but has no levels (Guardian Shrine) [repro]
- **Where:** [tiers.ts:73](src/engine/tiers.ts#L73), [tiers.ts:328-336](src/engine/tiers.ts#L328-L336), [tiers.ts:586](src/engine/tiers.ts#L586), [tiers.ts:491](src/engine/tiers.ts#L491), [src/data/clashking.ts:181-183](src/data/clashking.ts#L181-L183), [src/data/clashking.ts:199](src/data/clashking.ts#L199)
- **What's wrong:** Guardian Shrine is ClashKing type `Army`, so it gets category `army`, which is in `BUILDABLE`. It has `countPerTH {19: 1}` from the Town Hall unlocks but **no levels**, so its queue is `none`. `plannedBuildings` creates a planned copy for any player who doesn't own one. The gate then pushes every planned item with `levels[0]?.thRequired ?? 0 <= th`, and `undefined ?? 0` passes. `genericDrafts` skips queue `none`, so no candidate ever builds it. The gate never clears, and nothing on the Plan tab explains why.
- **Scenario:** Data adds TH20, so TH19 becomes rush. A TH19 player whose export has no Guardian Shrine entry (not built yet) gets no Town Hall candidate and no Guardian Shrine candidate: **0 Town Hall jobs in a 365-day simulation**. The same player with the shrine in the export gets the TH20 candidate. `makeExport` always adds every counted building, so no current test can catch this. Any future building that ClashKing lists in `unlocks` before it has levels would do the same.
- **Fix:** In `plannedBuildings`, skip items with `queue !== 'builder'` or no `levels[0]`, and only push gate entries for planned items that have a buildable first level. If the shrine must still count as "build it", give it a Tier 0 "build (not in data yet)" informational row without holding the gate. Add the scenario above as a test using `modifiedData(addTownHallLevel)`.

### 3. MEDIUM: known items with no levels free their builder while under construction or upgrading [repro]
- **Where:** [scheduler.ts:158-163](src/engine/scheduler.ts#L158-L163), [parseExport.ts:246-280](src/state/parseExport.ts#L246-L280)
- **What's wrong:** A running upgrade on an *unknown* id holds its slot (SPEC §3.2). A running upgrade on a *known* item whose queue is `none` is dropped (`if (!q) continue`). ClashKing lists Guardian Shrine, Helper Hut, Crafting Station, Sour Elixir Cauldron and B.O.B's Hut with no levels, so all of them have queue `none`. The parser keeps their `timer` as `upgradingTo`, and the scheduler then ignores it.
- **Scenario:** A TH18 export (6 builders) with the Guardian Shrine at level 0 and a 3-day timer: the plan starts **6 new builder jobs at t=0** and the shrine isn't in the timeline. In-game only 5 builders are free. This is the bug the "unknown running jobs" rule fixed for building 1000106, back again because ClashKing now *knows* the id. It applies to any building ClashKing adds before it adds levels.
- **Fix:** When an instance has `upgradingTo` and its item's queue is `none`, map it by category: buildings, traps and guardians to a builder, units to the lab, pets to the pet house. Add it as a running job that holds the slot (name it `"<name> (no level data)"`). Or route it through the existing `UnknownJob` path. Add a test with a levelless building under construction.

### 4. MEDIUM: local refresh writes committed files, which then block `git pull --ff-only` on every start [repro]
- **Where:** [scripts/lib/refresh.ts:94-115](scripts/lib/refresh.ts#L94-L115) (step 0), [refresh.ts:139-146](scripts/lib/refresh.ts#L139-L146) and [refresh.ts:170-173](scripts/lib/refresh.ts#L170-L173) (local ClashKing / npm sync), [refresh.ts:187-204](scripts/lib/refresh.ts#L187-L204) (local `npm run meta`), [nodeDeps.ts:120-137](scripts/lib/nodeDeps.ts#L120-L137)
- **What's wrong:** Step 1 can run a full `npm run sync`, which rewrites `data/clashking/*`, `public/data-changes.json` and possibly `package*.json`. Step 2 can run `npm run meta`, which rewrites `public/meta.json`. All of these are committed files, and the refresh never commits them (it "never pushes", §9a). The next time the Action commits the same files, step 0's `git pull --ff-only` aborts. I checked this in a throwaway repo: git refuses even when the local content is identical to the incoming commit ("Please commit your changes or stash them before you merge. Aborting").
- **Scenario:** The meta Action misses a day. `npm run dev` runs a local meta run (the SPEC'd fallback), and the owner skips `npm run push-meta`, as the reminder allows ("only if you want this copy on the live site now"). The next day the Action commits `public/meta.json`. From then on every `npm run dev` prints "git pull --ff-only failed …; continuing with the local copy", and **no** later Action commit (data or meta) reaches the local copy until the owner cleans up by hand. The same happens after a local ClashKing sync between two Action runs.
- **Fix:** Before pulling, discard local changes to files the refresh itself generated, but only when the incoming commits touch them (`git diff --name-only HEAD..origin/main` intersected with the generated set). Alternatively, stop the local refresh from writing committed files: leave data to the Action, keep offline validation, and write the local meta to an ignored path that the dev server serves. At minimum, make the warning name the file and the command that fixes it.

### 5. MEDIUM: a re-pointed ClashKing release tag fails the Action every day; local sync installs different data under the same version [repro]
- **Where:** [scripts/lib/clashking.ts:119-123](scripts/lib/clashking.ts#L119-L123), [src/data/source.ts:23](src/data/source.ts#L23), [scripts/lib/snapshots.ts:45-49](scripts/lib/snapshots.ts#L45-L49), [scripts/lib/dataUpdate.ts:123-124](scripts/lib/dataUpdate.ts#L123-L124)
- **What's wrong:** "Is it new?" is decided by **commit**, but the version (snapshot name, diff, banner, dismissal) is the **tag**. If ClashKing moves `v0.1.20` to a new commit, or re-uploads the file at the same tag, the new data has the same version. `recordSnapshot` then says "already recorded", returns no `changes`, and `runDataUpdate` fails with "no diff was produced".
- **Scenario (reproduced with in-memory snapshots):** pinned `v0.1.20@04babd0`, latest `v0.1.20@fffffff` with one changed cost. The result is `status failed, failedStep "snapshot + diff"`. That repeats daily, with an issue and a "Failed again" comment each day. Locally, the refresh sees a different commit and runs sync. Sync pins the new data with no diff and no banner, so the local site runs data that differs from the live site under the same label (and finding 4 then blocks pulls).
- **Fix:** Include the commit in the snapshot identity (for example `clashking-v0.1.20+fffffff`, or compare `pin.commit`/`sha256` rather than the version). Or treat "same version, different sha256" as a new version for the diff. Show only the tag in the footer.

### 6. MEDIUM: `npm test` fails in a fresh clone on Windows (CRLF)
- **Where:** [tests/data-update.test.ts:225-226](tests/data-update.test.ts#L225-L226), [:242](tests/data-update.test.ts#L242); there is no `.gitattributes`
- **What's wrong:** The test reads `.github/workflows/data-update.yml` and matches `/id: test\n[\s\S]*?if: …/`. With `core.autocrlf=true` (Git for Windows' default, and this PC's setting), the checkout has `\r\n` and the regex fails. CI (Linux) and the owner's existing working copy (LF) pass, which is why nobody noticed.
- **Scenario:** `git clone` + `npm ci` + `npm test` on the owner's PC: 1 failed, 344 passed (see Results).
- **Fix:** Normalize in the test (`wf.replace(/\r\n/g, '\n')`) and add `.gitattributes` with `* text=auto eol=lf` (at least for `*.yml`, `*.json`, `*.ts`).

### 7. LOW: validation accepts a new top level with cost 0 and time 0, the failure mode of the "one level early" offset [repro]
- **Where:** [validate.ts:61-72](src/data/validate.ts#L61-L72), [scripts/lib/clashking.ts:65-76](scripts/lib/clashking.ts#L65-L76), [src/data/clashking.ts:85-88](src/data/clashking.ts#L85-L88)
- **What's wrong:** For troops, spells, heroes, pets, guardians and equipment, level N's cost is row N−1's `upgrade_cost`. Today every top row has `upgrade_cost: 0`, which I checked across all six sections, and there are no level gaps. When ClashKing adds level N+1 it must also fill in row N. If it adds the row but leaves row N at 0, level N+1 becomes free and instant. `checkLevels` only checks contiguity and non-negative values, so the file is pinned.
- **Scenario:** Barbarian King 116 added with row 115 left at 0 gives level 116 at 0 cost and 0 s, and `validateClashKing` passes. The plan would offer "Barbarian King → 116 (0, 0s)" and never book-ready it. I checked the current data: no scheduled item (queue ≠ `none`) has a free level above 1, so a check would have no false positives (seasonal troops are free, but their queue is `none`).
- **Fix:** In `validateClashKing`, report an error for any level > 1 of a scheduled item with cost 0 **and** time 0 (equipment: all three ores 0). The known-good copy then stays and the issue names the item.

### 8. LOW: the issue title names the clash-of-clans-data version when a ClashKing update fails at `npm test`, commit or deploy [repro]
- **Where:** [scripts/lib/dataUpdate.ts:143-144](scripts/lib/dataUpdate.ts#L143-L144)
- **What's wrong:** `issueTitle` uses the ClashKing version only when `failedStep` starts with "ClashKing". A run that passed `check` has no `failedStep`, so a later failure falls back to `r.to`, which is the npm package version even when only ClashKing changed.
- **Scenario:** ClashKing v0.1.20 → v0.1.21 fails at `npm test` (finding 1). The title is **"Data update failed: 0.19.1"**. The next ClashKing version that also fails is filed under the same title, so different versions merge into one issue. SPEC §9b says the title should name `clashking-v…`.
- **Fix:** Use `clashKingTo` whenever `clashKingFrom !== clashKingTo`. If both sources changed, name both.

### 9. LOW: ClashKing's release tag is used unsanitised in file names and in the issue step's jq filter
- **Where:** [src/data/source.ts:23](src/data/source.ts#L23), [src/data/snapshot.ts:44](src/data/snapshot.ts#L44), [.github/workflows/data-update.yml:102-105](.github/workflows/data-update.yml#L102-L105)
- **What's wrong:** The tag comes from a third-party repo. Git allows `/`, `"`, `)` and `|` in tag names (checked with `git check-ref-format`). A `/` makes the snapshot path `data/snapshots/<date>_clashking-v0.2/beta.json`, so the write fails and the Action fails with "no diff". A `"` in the title is spliced into the `--jq "map(select(.title == \"$title\")) …"` program, which can make it select a *different* open issue, whose body `gh issue edit` then overwrites.
- **Fix:** Validate the tag (`^[A-Za-z0-9._-]+$`, otherwise fall back to `main-<sha7>` with a warning) and slug the version for file names. Pass the title to jq with `--arg t "$title"` and `select(.title == $t)` in both workflows.

### 10. LOW: the Everything tab's "Total cost" includes the next Town Hall and book-ready hero levels
- **Where:** [everything.ts:189-194](src/engine/everything.ts#L189-L194), [everything.ts:224](src/engine/everything.ts#L224), [everythingView.ts:50](src/ui/everythingView.ts#L50)
- **What's wrong:** `totalCosts` adds the "Not scheduled" group, which includes the next TH upgrade (rush) and every book-ready hero level. SPEC §11 describes the tab as "every upgrade left at the **current** Town Hall".
- **Scenario:** A rush account's "Total cost (N upgrades)" includes the TH(n+1) upgrade's gold and the Queen's book-ready DE, so it overstates what is left at this TH.
- **Fix:** Total the scheduled groups plus walls, and show "Not scheduled" as a separate subtotal (or decide otherwise in SPEC; see spec ambiguity 6).

### 11. LOW: a hero-order drop accepts numeric text dragged in from outside the list
- **Where:** [main.ts:284-294](src/main.ts#L284-L294)
- **What's wrong:** `dragover` accepts every drag. On `drop`, when no drag started in the list (`dragFrom === -1`), the source index is read from `text/plain`. Dragging selected text such as "3" from anywhere onto a row moves hero #4. The Queen can't move (`moveHero` guards her), so the lock holds, but the order changes unexpectedly.
- **Fix:** Ignore drops when `dragFrom < 0` (the `dataTransfer` fallback isn't needed within one document), or tag the payload with a custom MIME type.

### 12. LOW: small correctness and quality items
- **Wall line from the export state:** `wallDump(data, account)` uses the export-time TH ([plan.ts:166](src/engine/plan.ts#L166), [forecast.ts:56](src/engine/forecast.ts#L56)). If the TH finished since the export, it can say "no wall line" when the new TH allows more. Pass `nowState`'s TH.
- **Helper line says "h/day"** ([plan.ts:87](src/engine/plan.ts#L87)), but the cycle is 23 h (§10.1).
- **The helper cycle advances when no job is running** at a work hour ([scheduler.ts:441](src/engine/scheduler.ts#L441)). SPEC says the cycle starts when a helper is *assigned*. This rarely matters (all builders idle), but it is unlike the game.
- **Misleading fallback reason:** a YAML error or an unknown id in an override file makes `normalizeClashKing` throw. The browser then reports "the pinned ClashKing data can't be loaded" and switches to the frozen backup, or fails outright because the backup re-parses the same YAML ([loadBrowser.ts:23-35](src/data/loadBrowser.ts#L23-L35)). Parse the overrides first and report them as an override error.
- **Fragile category default:** any ClashKing `Resource` building that isn't a storage or collector becomes `army`, which is the offense tier ([src/data/clashking.ts:185](src/data/clashking.ts#L185)). Sour Elixir Cauldron would become an offense upgrade the day it gets levels. Map unknown types to `other` and warn.
- **Unused exports:** `CK_DATA_FILE`, `CK_PIN_FILE`, `cocDataVersion`, `readIdOverrides` ([loadNode.ts:18-19](src/data/loadNode.ts#L18-L19), [loadNode.ts:45](src/data/loadNode.ts#L45), [loadNode.ts:60](src/data/loadNode.ts#L60)). `req` is an alias of `num` ([src/data/clashking.ts:69](src/data/clashking.ts#L69)).
- **Duplication:** `STORAGES`/`COLLECTORS` are defined in both normalizers ([src/data/clashking.ts:65-66](src/data/clashking.ts#L65-L66), [normalize.ts:32-33](src/data/normalize.ts#L32-L33)). `fence`/`tail` appear in [dataUpdate.ts:146-147](scripts/lib/dataUpdate.ts#L146-L147) and [metaCi.ts:107](scripts/lib/metaCi.ts#L107). `setOutputs` is in both CLI entry points. The issue create-or-update shell block is copied in both workflows.
- **Large files:** [tiers.ts](src/engine/tiers.ts) (594 lines), [clashking.ts](src/data/clashking.ts) (480), [scheduler.ts](src/engine/scheduler.ts) (467). `simulate()` alone is about 320 lines, with running-job setup, helpers, the start functions and the event loop in one closure.

### 13. LOW: CI hardening
- `actions/checkout` keeps the write-scoped `GITHUB_TOKEN` in `.git/config` ([data-update.yml:30-32](.github/workflows/data-update.yml#L30-L32), [meta.yml:29-31](.github/workflows/meta.yml#L29-L31)) while `npm ci` runs dependency install scripts and later steps run `npx tsx` with npm code. The meta step also has the developer-site credentials in its environment. This is a normal supply-chain exposure, but cheap to reduce: `persist-credentials: false` on checkout, set the remote token only in the push steps, and run `npm ci --ignore-scripts` where binaries aren't needed (data-update, meta).
- [pages.yml:11-14](.github/workflows/pages.yml#L11-L14) grants `pages: write` and `id-token: write` at workflow level, so the build job (`npm ci` with scripts) has them too. Move them to the `deploy` job.
- Actions are pinned to major tags, not SHAs. They are all `actions/*`, so this is low risk.

### 14. LOW: a valid-format player tag in a test string
- **Where:** [tests/meta-ci.test.ts:67](tests/meta-ci.test.ts#L67): `#2PP0JQ8` uses only valid tag characters (`0289PYLQGRJCUV`) and is in 13 commits of history.
- **What's wrong:** It may be a real player's tag in a public repo. I couldn't check without the API, which I was told not to call. It's only test input for `redact()`.
- **Fix:** Use an obviously fake value with invalid tag characters, such as `#ABC123X`, which still matches `#[0-9A-Z]{3,}`. The history copy can stay, as with `#8UG890J`.

### Checked and found sound (no finding)
- **Level offset:** costs and times for buildings, traps and modules are not shifted. Troops, spells, heroes, pets, guardians and equipment are shifted, `required_*` is never shifted, level 1 is free, and the top row's `upgrade_cost` is 0 for every item (no lost cost). There are no level gaps.
- **Building counts and merges:** counts are running sums of `unlocks`. TH17's `merge_requirement` absorbs the Eagle Artillery. All five recipes come from level-1 `merge_requirement`, including Firecracker Tower (whose level 1 has `required_townhall: null`, so the unlock TH comes from its count). Counts after merges are AT 4/2/2/0, Cannon 3/0/0/0 and WT 2/2 at TH16–19. The consumption check is clean.
- **TH requirements:** read generically from all TH-level arrays. TH19's `variants` (troop requirements) are correctly ignored. The gate, the "met" reason, lookahead (TH+2 while the TH upgrades) and the no-deadlock rule all behave as specified. A TH18 → TH19 transition plans Spiky Towers, Firecracker merges and new copies in Tier 0, in a sensible order.
- **Helpers and boosts:** the potion + bite stack is additive, the Apprentice's gain is in work units (not multiplied by the potion), the Research Potion speeds up the lab only, the Pet Potion the Pet House only, the Clock Tower is ignored, and unknown boost keys warn. The repeat setting wins while its job runs and isn't inherited by planner jobs. The fallback picks the TH first, and the suggestion is computed once per helper.
- **Meta Action:** the token is masked right after login. Login and API errors are redacted. Secrets are only in the meta and issue steps. No artifact is uploaded. The `meta-data` branch holds only `README.md` + `battles.jsonl.gz` (one parentless commit, pseudonymous `h…` tags, 0 raw `#` tags). The thresholds match SPEC §8.4, and the issue is opened and closed as specified.
- **Security sweep (all 53 commits, all refs):** no `.env`, `samples/`, local `battles.jsonl` or state files were ever committed. The only JWT-like string is the test fake (`{"iss":"supercell"}` / "signature"). The only emails are the test values (`a.b@c.de`, `owner@example.com`), and the only IPs are test values. `#161513` is a CSS colour.

---

## Spec ambiguities

1. **Buildings the data counts but can't build** (§3.1, §6.3 "every new building that can be built is built"). SPEC doesn't say what to do with a counted item that has no levels (Guardian Shrine today). Is it a Tier 0 build, an informational row, or ignored for the gate? This causes finding 2.
2. **Which level a supercharge is priced from** (§3.1 "the `supercharge` block on a building's top level" vs §6.3 tier 6 "base at its max level for the current TH"). Monolith's block sits on level 5 (TH18) with `required_townhall: 17`, so a TH17 player with Monolith 4 is offered the Monolith supercharge at level 5's supercharge costs. Is that the in-game rule, or should the base be at the level that carries the block?
3. **Version identity** (§3.1, §9 steps 2–3): the version is the tag, while "is it new?" is the commit. SPEC doesn't cover a re-pointed tag or a re-uploaded file. This causes finding 5.
4. **§9b issue title `<new version>`** when ClashKing changed but the failure happens after `check` (npm test, commit, deploy), or when both sources changed. This causes finding 8.
5. **§9a steps 1–2 vs step 0 and §15:** the local refresh may write committed files (`meta.json`, `data/clashking/`) and never pushes them, while step 0 expects `git pull --ff-only` to keep working. SPEC doesn't say what happens to those local copies once the Action commits. This causes finding 4.
6. **§11 Everything "every upgrade left at the current Town Hall"** vs "Totals on top: … total cost per resource": should the "Not scheduled" rows (next TH, book-ready levels) count in the total? This causes finding 10.
7. **§10.1 "a 23-hour cycle that starts when a helper is assigned":** what happens at a work hour with no eligible job? Does the cycle wait for the next job, or advance? The code advances it.
8. **Guardians** (§3.1 "count 1 from their first level's TH"): no rule says whether a missing guardian is a Tier 0 new building. Guardians are excluded from planned builds. ClashKing lists a third guardian (Logger, TH18) that clash-of-clans-data lacks.
9. **§10.4 wall line:** from the export state or from "now"? §10.1's "ranked lists reflect now" names the other lists but not the wall line.
10. **§3.1 "main when no release has the file":** if a future release moves or renames the file, the pin silently follows ClashKing's unreleased `main` from then on (a moving target, re-pinned daily). Is that intended, or should it keep the last release and open an issue?
11. **§9 step 1 "levels pass §9 step 4's level checks"** doesn't define plausibility for shifted rows (a free, instant level above 1). See finding 7.

## Missing tests

**Data layer and validation**
- A levelless known building under construction holds its builder (finding 3).
- The gate with a counted-but-levelless building after a TH20 release: the Town Hall must still be offered (finding 2).
- A new top level with row N left at 0 is rejected by `validateClashKing` (finding 7).
- A Resource-type building that isn't a storage or collector doesn't land in the offense tier.
- An override file with a YAML error or an unknown id: the message names the override file, not ClashKing.
- A supercharge whose block TH is below the base's top-level TH (Monolith at TH17).

**Sync, Action and refresh**
- Same tag, new commit → a diff is produced (or a defined outcome), not "no diff was produced" (finding 5).
- `issueTitle` for a ClashKing update that fails at `npm test`, commit or deploy (finding 8).
- A tag containing `/` or `"`: the snapshot name stays inside `data/snapshots/`, and the jq filter isn't affected (finding 9).
- Refresh step 0 when the working tree has a locally written `public/meta.json` and the incoming commit touches it (finding 4).
- The suite on a mutated copy of the pinned data (one new top level for a few items, plus a TH20 level): only intended tests may fail (finding 1).
- Workflow-file tests under CRLF (finding 6).

**Engine and scheduler**
- Helpers: no eligible job at a work hour; a `helper_recurrent` flag on a Goblin job; two flagged builder jobs.
- The Everything tab's totals with and without the "Not scheduled" group (finding 10).
- The wall line after the TH finished since the export.
- TH19 in max-TH mode, from a real-looking export: Firecracker merges with Archer Towers and Scattershots at the required levels, and no "build Archer Tower" suggestions. Today only my throwaway check covers this.

**UI**
- Dropping external text on the hero list doesn't reorder (finding 11).
- Mobile layout: I didn't check it visually. CSS has breakpoints at 480 px and 560 px, but no test or screenshot covers the Plan and Everything tabs at phone width.
