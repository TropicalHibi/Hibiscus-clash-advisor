# Decisions (Step 1)

One line each: decision, then why.

## What the real export looks like (`samples/myexport.json`)
- The file is `samples/myexport.json`, not `my-export.json`. `npm run plan` checks both names. *Why:* that's the file that was provided.
- **Top-level `timestamp` exists** (unix seconds, e.g. `1794747348`) and is the timer baseline. Paste time is used only when it's missing. *Why:* SPEC §3.2/§14 asked to verify this, and it's present.
- Sections found: `buildings`, `traps`, `units` (troops; **not** `troops`), `siege_machines` (separate from units), `heroes`, `spells`, `pets`, `equipment`, `guardians`, `helpers`, plus `decos`, `obstacles`, `house_parts`, `skins`, `sceneries` and the `*2` Builder Base sections (all ignored). The parser also accepts `troops`. *Why:* match the real file, but stay compatible with the coc.py shape.
- Item fields seen: `data`, `lvl`, `cnt`, `timer`, `extra`, `helper_recurrent`, `helper_cooldown`, `gear_up`. *Why:* recorded for later steps.
- `boosts` is `{}` in the real export, so its shape is still unknown. It is parsed and stored, but unused until Step 3. *Why:* nothing to model yet.
- `timer` = seconds left on an upgrade from `lvl` to `lvl+1`, measured at `timestamp`. *Why:* consistent with every entry (e.g. heroes below cap with timers).
- `extra: true` = Goblin Builder / Goblin Researcher job. Goblin slots finish their current job and never take new work. *Why:* goblins are temporary, and the export can't show whether they'll still be around.
- Builders = Σ Builder's Hut `cnt` + B.O.B's Hut (6 for this account). The goblin is not counted. *Why:* 6 regular jobs were running in the real export (4 heroes + 2 Scattershots) plus one goblin job.
- Crafting Station (`1000097`) holds `types[] → modules[]`. Each module becomes an instance, with one upgrade at a time per crafted defense. Sparky stones are ignored. *Why:* that's the real shape. "One upgrade per building" follows SPEC §6.6.
- Alchemist helper `93000003` has no `dataId` in clash-of-clans-data 0.19.1. It is reported as an unknown-id warning, not a crash. *Why:* SPEC says warn, don't crash. Helpers are Step 3 anyway.
- Mortar `gear_up: 1` is ignored. Gear-ups are not scheduled. *Why:* not in the spec, and they need Builder Base buildings.

## Data layer
- Supercharge levels sit inside each defense/collector `levels` array, flagged `supercharge: true`, with numbering restarting at 1. They are split into a separate item with key `<dataId>:sc` (category `supercharge`). *Why:* otherwise "max level" and level lookups are wrong.
- Assumed export field for supercharge progress: `supercharge` (number). **Unverified**: this account has no supercharges. *Why:* best guess; it's a single line in `parseExport.ts` to fix.
- TH weapons come from `town-hall.levels[].weapon.levels`, keyed `1000001:w<TH>`. Assumed export field: `weapon` on the TH entry, default level 1 if absent. *Why:* TH18 has no weapon, so the real export can't confirm it.
- `Item` gained `key` (string), `id` (file id) and a few optional fields. Category gained `other`, Queue gained `none`. `LevelInfo` gained `petHouseRequired`, `blacksmithRequired` and `ore`. *Why:* the data needed them (synthetic keys, multi-ore costs).
- Equipment `cost`/`resource` = shiny ore. All three ores are kept in `ore`. *Why:* `LevelInfo` has a single cost; the forecast needs all three. *(The ore forecast was later removed (see "ore is never forecast"); `ore` now feeds the equipment rows' "ore cost", the equipment fallback order and the Everything tab.)*
- The browser loads only the needed `data/home/*` folders via `import.meta.glob`; Node reads them with `fs`. One shared `normalize()`, plus a parity test. *Why:* the package's dist bundle is 2.2 MB and includes Builder Base and Clan Capital; the glob keeps the data identical in both.
- The package version is read via glob/fs, not an import. *Why:* the package `exports` field doesn't expose `package.json`.
- Hero Banner is skipped. *Why:* no `dataId` and no levels in the data.
- Hero caps come from per-level `heroHallLevelRequired`. The stale cap table is only used to log mismatches (BK/AQ 105 vs 110, GW 80 vs 85 at HH12). *Why:* SPEC §3.1.
- `countAt()` uses the nearest defined TH ≤ player TH. *Why:* `countAfterMerges` only exists at merge THs.

## Engine
- The scheduler regenerates the full candidate list every time a slot frees (pure function of state). *Why:* TH/HH/lab upgrades, merges and new buildings all change eligibility; recomputing is simple and fast enough.
- Missing buildings (allowed at TH − consumed by existing merges − owned) become "build new" candidates in their category's tier. Excluded: Builder's Huts (gems), guardians, Crafting Station, B.O.B/Helper huts. *Why:* a rushed account needs new buildings placed. The merge-aware count keeps sources from being re-built.
- Merge source allocation: highest-level source instances go to merges first. Jobs are ordered by needed TH, then `merges.yaml` order. Each chain runs sources → build → merged-defense upgrades. *Why:* fewest upgrades to complete each merge; matches SPEC §6.3 ordering.
- Required source level = max level in the data (SPEC §7). Source upgrades still respect the player's TH. *Why:* spec, while staying eligible-only.
- Rush lookahead covers TH+1 only, and only source upgrades. The merged building itself waits until the TH completes. *Why:* SPEC §6.3; level-1 merged builds need the new TH.
- ~~Rush tier 1 holds every merge; in max-TH only merges new to max TH are tier 3, older ones tier 5.~~ **Superseded by the SPEC §6.2–6.4 revision** (below).
- TH weapon: in rush mode it's in tier 1 right after the TH, but it shares the TH's lock, so it only gets picked when the TH can't be upgraded (or is gated). In max-TH mode it's tier 5. *Why:* you can't upgrade the weapon while the TH upgrades; max-TH tiers don't mention it.

## Engine — SPEC §6.2–6.4 / §10.1 revision (TH gate)
- **Tier 0 = every `build` or `merge` candidate**, then the Queen. That covers missing copies (allowed at TH − merge-consumed − owned), missing merge sources, and merges whose sources are at the required level. *Why:* §6.2 "new unbuilt buildings come first … a merge whose sources are already at the required level counts as a new building".
- Order inside tier 0: `[0, normal tier of the building, −raw time, cost]`, and the Queen is `[1]`. The normal tier is the mode's offense/resources/defenses tier, so offense → resources → defenses in both modes. Merges count as defenses. *Why:* §6.2 "order by the tier the building would normally belong to, then longest first".
- Merge-source upgrades are the **TH gate**: tier 1 in rush mode (after the TH itself), tier 3 in max-TH mode, for **all** merges, old and new. Order: unlock TH, then `merges.yaml` order. *Why:* §6.3/§6.4.
- Merged-defense upgrades past level 1 go in tier 5 (LPT, mixed in with the other defenses). *Why:* §6.3 "not part of the gate".
- **Rush mode: the TH upgrade only becomes a candidate when the gate is clear.** That means no unbuilt building available at the current TH, and no performable merge left at the current TH. A builder that is still building something already counts as owned. *Why:* §6.3 says the gate is "everything that must be done before the next TH upgrade", and that new buildings "are done before the gate is checked". I read "as soon as it's available" as "as soon as the gate allows it".
- Gate guard: a merge only holds the gate if enough source instances exist to perform it. A merge with missing sources can never block the TH forever, and missing sources show up as tier-0 builds anyway. *Why:* to avoid a stuck plan.
- Lookahead jobs (next TH's merges while the TH upgrades) never count against the gate. *Why:* they belong to the next TH.
- LPT in tiers 5–6 sorts by **raw** time, ties go to the cheaper one. *Why:* Gold Pass scales all times equally, so the order doesn't change.
- Walls are not scheduled (instant). They only feed the wall dump line. *Why:* SPEC §10.4.
- Lab / pet house can't research while their own building is upgrading (enforced). The reverse in-game rule (the lab can't be upgraded while researching) is **not** enforced. *Why:* enforcing it would starve lab upgrades in a greedy sim; logged as a known gap.
- Only owned troops/spells/sieges/pets/equipment are candidates. *Why:* unlocks come from building upgrades, and level 1 appears in the export once unlocked.
- Fallback ordering with the stub meta: lab/pets go shortest time first (tie → cheaper). Equipment goes cheapest first (starry, then glowy, then shiny ore), since it has no timer. *Why:* SPEC §6.7 says "shortest"; equipment needed a time-free equivalent.
- The book-ready list includes heroes whose next level after their running upgrade is book-ready (flagged "after current upgrade"). *Why:* it tells the player now that GW/DD will need a book next.
- Hero reasons compare raw times (e.g. "raw next level 5d < 8d"), even when the displayed duration is Gold-Pass boosted. *Why:* SPEC §6.5 says the raw comparison is correct.
- Simulation horizon = forecast window (24h). The timeline shows jobs starting inside it. *Why:* that's all the Plan tab needs in Step 1.
- `GOLD_PASS_MAX_BOOST = { builder: 0.2, research: 0.2 }` in `src/engine/constants.ts`. *Why:* SPEC §10.2; still needs an in-game check.

## UI / tooling
- Hero order uses ↑/↓ buttons (drag-to-reorder is Step 3). *Why:* the order setting is useful now, and buttons work on phones.
- The Plan tab re-renders every 60 s and when the page regains focus. *Why:* "now" keeps moving while the tab stays open.
- `config/settings.sample.yaml` is bundled via `?raw` as the defaults. localStorage overrides it, and "Reset settings" clears it. *Why:* SPEC §12.
- `npm run sync` also prints the validation checks (levels, merge consumption, hero caps) as non-blocking warnings. *Why:* cheap, and it's what will matter when Hero Hall 13 lands on Nov 16.
- `npm run plan -- <file> [--gold-pass max] [--hours N] [--at-export]`. *Why:* debug flags for checking without the browser.
- Added `happy-dom` (dev) for a UI smoke test that boots `main.ts` and imports an export. *Why:* verifies the browser path without a real browser.
- Tests use a synthetic TH16 fixture (`tests/fixtures/export-th16.json`, generated from data by `tests/makeFixture.ts`) plus programmatic exports. *Why:* `samples/` is never committed. One test also checks the real export when it exists locally.
- VS Code extension install was **skipped**: the `code --install-extension` command was blocked by this environment's permission rules. *Why:* the prompt said to skip silently if unavailable.
- Git: line-ending warnings (LF→CRLF) are left as Git's default on Windows. *Why:* harmless.

# Decisions (Step 2: Legend I meta + Lab / Pets / Equipment tab)

## What the probe showed (`npm run probe`, samples in `tests/fixtures/api/`)
- **`battleType` values are camelCase, not upper case:** `legend`, `ranked`, `homeVillage`. The filter is `attack === true && battleType.toLowerCase() === 'legend'`. *Why:* SPEC §3.3 said `LEGEND`, but the real data is lowercase. Lowercasing both sides also covers a future case change.
- **`legend` = Legend League I only.** A Legend League II player (tier 105000035) had 16 attacks, all `ranked`. Electro 33 was the same. Legend I players' attacks are `legend`. A US Legend I player promoted this week shows `ranked` attacks from before the promotion and `legend` after it. *Why:* this confirms that any `legend` entry is a Legend I attack, whatever tier the player is in now. Players are still gathered by `leagueTier.id === 105000036`, because they're the only ones with `legend` attacks.
- Battle log entry fields: `battleType, attack, armyShareCode, opponentPlayerTag, opponentName, opponentTownHallLevel, stars, destructionPercentage, lootedResources, extraLootedResources, availableLoot, battleTime` (seconds, a number), and `battleTimestamp` (`20261116T180741.000Z`). Stored timestamps are converted to ISO. *Why:* recorded for later steps.
- Ranked players have `leagueTier {id, name}` plus a legacy `league {id: 29000000, name: "Unranked"}`. `/leaguetiers` lists 105000000–105000036, with Legend League III/II/I as 34/35/36. Rankings in small countries include lower tiers, so the tier filter matters there.
- **Battle log depth: up to 50 entries** (the full run averaged 48.4). For an active Legend I player that is about 16 Legend attacks, i.e. ~2 days. Some logs are shorter (39 entries) without any visible cutoff. *Why:* this drives the run frequency (daily; see REPORT).
- **Rankings pagination:** each location returns at most 200 players. Without `limit`, one call returns all 200 with empty `cursors`. With `limit`, the API pages via `cursors.after` (base64 `{"pos":N}`), and paging past 200 returns 0 items. `/locations` returns all 268 locations in one page. The collector calls without `limit` and follows `after` if it ever appears. A failing later page keeps the players already fetched.
- No 403: the key in `.env` matches this machine's IP.

## Fixtures and redaction
- `scripts/probe.ts` replaces player and clan tags with stable pseudonyms (`#PLAYER1`, `#CLAN1` …), replaces player, clan and opponent names, and drops badge/icon URLs. Army codes, stars and timestamps are kept. *Why:* tests need realistic data, but the fixtures shouldn't carry other players' identities. The token is never written anywhere (checked with a grep before committing).

## Army code parser (`src/meta/armyCode.ts`)
- Faithful port of clashy.go `ParseArmyRecipe` (same section splitting, hero regex, base IDs, malformed-item rules), with one difference: **unknown IDs are kept** (as full dataIds) instead of being dropped at parse time. Resolution happens in `attackUsage()`, which counts unknown home troops, spells, pets and equipment and reports every unknown ID. *Why:* STEP2 says to keep counting unknown IDs and list them.
- Go test cases were ported as-is. Its "malformed" case was adapted: as in Go, the `d` inside `bad` starts a new section, so the case yields one CC spell and one hero (unknown IDs) and no troops.
- **Sieges count from either the CC (`i`) or the home army (`u`).** Real codes put them in `i` (Troop Launcher, Sky Wagon), but ClashKing's own example has them in `u`. Other CC troops and all CC spells (`d`) are ignored for usage.
- Heroes are parsed but not ranked. They're not in `meta.json`.

## Super troops (`config/super-troops.yaml`)
- clash-of-clans-data lists super troops inside the base troop file **without a dataId**, so codes like `4000083` couldn't be resolved. I added a hand-maintained map, super troop ID → base troop file id (17 entries, including Super Yeti 4000147). *Why:* without it, the most-used super troops would show up as "unknown".
- **The IDs are verified by a test:** `/players/{tag}` returns a player's troops sorted by dataId, so every known troop, siege and super troop ID must increase in that order (`tests/meta.test.ts`). Super Yeti was placed this way: 4000147 falls between Troop Launcher (135) and Furnace (150).
- **Super troop usage is credited to the base troop's lab upgrade**, because a super troop's level is its base troop's level. Meta score = own usage + super usage, capped at 100%. The 3★ rate is the usage-weighted blend. The UI and plan reasons say "incl. Super X". *Why:* upgrading Balloon is what makes Rocket Balloon stronger. Summing slightly overstates attacks that use both the base and the super troop, which is rare.
- `meta.json` units carry two extra optional fields beyond SPEC §8.3: `kind`, and `baseId` for super troops. *Why:* the browser needs the super → base link without the config file. The required fields and shape are unchanged, and `coerceMeta` doesn't require the extras.
- IDs **4000195–4000206** (and CC spell 26000153) are not in the data. They come after Sky Wagon in the API's ID order (event troops such as "Barch Squad"), and they're not lab-upgradable. They stay listed as unknown in the run summary, and as "Unknown troop …" in `meta.json`. *Why:* they're harmless (they never match an owned item) and I can't name them reliably.

## Collector (`npm run meta`)
- Sources: `global`, then every `isCountry` location in `/locations` order. Regions (Europe, etc.) are skipped. It stops once `meta.maxPlayers` is reached; 1000 players took about 25–30 locations. *Why:* SPEC §8.1 says global + countries.
- 4 workers share one throttle (`meta.requestsPerSecond`, default 10). 429/5xx/network errors are retried up to 5 times with backoff of 1s, 2s, 4s, 8s, 16s (+jitter), capped at 30s. 401/403 abort the run with the IP hint. A 404 player is skipped. *Why:* serial requests only reached ~5 req/s because of latency.
- **Resumable:** `data/meta/run-state.json` stores the player list, which players are done, and running totals. It's rewritten after every player, and rows are appended to `battles.jsonl` immediately. A rerun resumes if the state is under 24h old and `maxPlayers` matches. `--fresh` forces a new run. The state file is deleted after a run with no failed players. Tested by killing a 300-player run at 242: the rerun fetched only the 58 remaining players.
- Dedupe key `tag|ts` on append, plus a second dedupe pass on load (protects against a write torn by a kill). Legend attacks without an `armyShareCode` are skipped and counted (11 of 13,566).
- `battles.jsonl` rows older than 60 days are pruned when the file is loaded. *Why:* SPEC §8.3 allows pruning >60 days.
- **`data/meta/battles.jsonl` is git-ignored.** It's 3.1 MB after one run, and daily runs add ~8k rows (~1.8 MB) a day, so it would pass 5 MB within days. `run-state.json` is ignored too. `public/meta.json` (~18 KB) is committed.
- Extra flag `--aggregate-only` rebuilds `meta.json` from the existing file without API calls. `npm run probe` re-records the fixtures.

## Aggregation
- Weight = 0.5^(age / half-life), with age measured from the run time. Rows outside the 14-day window are dropped. Future timestamps weigh 1. `usage` = weighted share of attacks containing the unit. `threeStarRate` = weighted 3★ share of those attacks. `avgQty` = weighted mean quantity in those attacks (troops, super troops and spells only). Values are rounded to 4 decimals (avgQty to 2).
- `attacks` = number of rows in the window (unweighted). `players` = distinct tags in the window (889 of 1000; the rest had no Legend attacks in their log).

## UI / ranking
- New tab **Lab / Pets / Equipment** between Plan and Import. Each list shows meta score descending, then unused items at normal contrast, labelled "Not seen in Legend I · 0% used" (lab/pets shortest first, equipment cheapest first). Each row has a usage bar, usage %, 3★ rate, time/cost (ore for equipment) and a Pin/Unpin button.
- **Pins:** the newest pin goes to the top. Pins are stored in the existing settings object (`lab.pinned`, `petHouse.pinned`, `blacksmith.pinned`) in localStorage, keyed by the item's file id. The same ranking feeds the scheduler (lab/pet order), so lab and pet pins change the Plan tab too. *(It also fed the ore forecast's top-N picks until ore was removed from the forecast.)*
- With no meta (missing file, 404 or empty `units`), the tab shows a "run `npm run meta`" note and the Step 1 order, without errors. The fallback reason now says "No meta data yet" instead of "Not seen in Legend I meta" when the file has 0 attacks.
- Footer: meta `generatedAt`, attack count and player count.
- **Not changed:** the meta score stays plain `usage` (SPEC §8.3), even though it rewards cheap filler troops (Archer: 88% usage at ~2.6 per army). See REPORT "Check".

## Mid-step request
- Added a test for SPEC §10.1 (new wording): a Goblin Builder and a Goblin Researcher job in the export each finish inside the 24h window, then those slots get no new job. They also don't appear in "Now" or the forecast, and they don't count as builders. Mutation-checked: removing the goblin guard in the scheduler fails the test. The engine already behaved this way, so no code change was needed.

# Decisions (Step 2 follow-up: army-share score, predev refresh)

## SPEC updates
- §3.3/§8.1: `battleType` is lowercase (`homeVillage | ranked | legend`), `legend` = Legend League I only, a battle log holds ~50 entries (~2 days), so meta runs **daily**. §14's two open questions are marked resolved.
- New §9a (predev refresh, no OS schedulers). §8.3 has the new meta score. §6.9/§11 say equipment stays usage-ranked with ore shown. The Task Scheduler instructions were removed from REPORT.md.

## Army-share score (`src/meta/aggregate.ts`, `src/meta/meta.ts`)
- **Housing space comes from the game data.** The normalizer now keeps `housingSpace` on troops, spells and sieges, and `superHousingSpace` from a base troop's `superTroop` block. The catalog gives super troops their own housing (Super Wizard 10, not the Wizard's 4). *Why:* the user asked for data-driven housing; the super troop block is the only source for super troops.
- Ruin Witch's extra `ruinKnight` block (housingSpace 18) is a summoned unit, not a super troop, and is ignored.
- **Per attack:** troop share = `qty × housing ÷ Σ(qty × housing)` over the home troops (`u`) that are troops or super troops. Spell share uses the same formula over home spells (`s`). Sieges placed in `u`, CC troops and CC spells are not part of either total.
- **Unknown IDs and units without housing are left out of the totals.** *Why:* their size is unknown. Including them would mean guessing. Today this only affects the 7 unknown event-troop IDs, so per-army troop shares still sum to 0.9995.
- **Aggregation:** `armyShare` = Σ(weight × share) ÷ Σ weight over **all** attacks in the window (0 where absent), with the existing recency weights. It's stored for troops, super troops and spells. Sieges, pets and equipment get no `armyShare`, and their score stays `usage`.
- **Base troop score = own share + super shares (capped at 1).** If any part (own or a super) lacks `armyShare`, the whole item falls back to usage share. *Why:* adding a share to a usage would mix scales within one item.
- **Missing housing:** the run summary lists every known troop or spell with no housing space ("these rank by usage share instead"); today the list is empty. A test asserts that every troop, spell, siege and mapped super troop in the current data has a housing space, so a data update that drops one is caught by `npm test` as well as by the summary.
- A `meta.json` without `armyShare` (older file or hand-made) falls back to usage, so the site works with old files.
- **Ranking:** score descending, then usage (tie-break), then the unused fallback order as before. The lab queue holds troops (share of troop space), spells (share of spell space) and sieges (usage share) **in one list compared by number, as specified**. Sieges' usage values (up to 50%) are naturally larger than troop shares (max 15%). See REPORT "Check"; not changed, because the user specified this formula.
- **UI:** the bar shows the score. Troop and spell rows show "X% of troop space" (or "spell space") plus usage % and 3★. Siege, pet and equipment rows show usage % (their score) and 3★. Super troops read "Includes Super X a% of space, b% used". On phones the bar moves to its own line. Plan reasons read `Legend I: 15.0% of troop space; incl. Super Dragon 1.3% (in 33.9% of attacks)`; usage-scored items keep `Legend I usage 49.6%`.
- Equipment: unchanged (usage share, ore cost shown, ore not part of the order).

## Predev refresh (`scripts/refresh.ts`, logic in `scripts/lib/refresh.ts`)
- `predev` runs `tsx scripts/refresh.ts`. npm runs it automatically before `npm run dev`. `dev:fast` is plain `vite` (npm runs no `predev:fast` hook). `npm run refresh` runs the refresh alone.
- **Game data:** the last check time is in `data/refresh-state.json` (git-ignored). After 24h, `npm view clash-of-clans-data version` (no retries, 10s fetch timeout, 20s hard timeout). If the published version is newer than `node_modules/clash-of-clans-data/package.json`, the full `npm run sync` runs. The check time is saved **only on success**, so being offline or a failed sync retries on the next start rather than waiting 24h.
- **Meta:** staleness comes from `meta.json`'s `generatedAt`; a missing file or no timestamp counts as stale. The token check looks at `process.env` and then `.env` (same sources as `loadToken`). The value is never printed or returned.
  - Note: `npm run meta -- --aggregate-only` also refreshes `generatedAt`, so after a manual re-aggregation the next refresh won't pull for 24h.
- **Output:** `npm run meta`'s stdout (progress and summary) is shown live. Its stderr is captured so a failure becomes **one** warning line, built from the first non-npm stderr line, plus a 403 hint. Exit code 2 (meta.json written, some players failed) counts as updated, with a one-line warning.
- **Always exits 0.** Each step is in its own try/catch, plus an outer one. *Why:* a non-zero `predev` would stop `npm run dev`.
- Ctrl+C during a predev meta run stops `npm run dev` too. The meta run is resumable, so the next start continues it.
- The logic takes injected side effects, so `tests/refresh.test.ts` covers every branch without npm, network or the API. Live checks: the first run printed "game data up to date (0.19.1)", the second was silent, an unreachable registry printed one warning line with exit 0, and `npm run dev` ran the hook and then started Vite.

# Decisions (lab sections + normalized lab pick)

- **Normalization denominator = the top score of that kind in the Legend I meta.** It's taken across every lab unit in the game data, not only the player's current candidates. *Why:* if each kind were divided by the player's own best upgrade of that kind, every kind's #1 would always be exactly 1.0, so the pick would always be the top troop (1.0 × 1.0 beats 0.7 and 0.5) and spells or sieges would never be picked. Dividing by the Legend I top keeps "how close to the meta's best of its kind is this upgrade" meaningful.
  - Example: your best spell, Poison, is 0.26 of the top spell (Totem); Dragon is the top troop (1.00); Sky Wagon is the top siege (1.00).
  - Super troop credit is included when finding the top. The top is cached per meta file because the scheduler asks for it many times.
- `pickValue = normScore × lab.kindWeights[kind]`.
  - **Order:** pins (in pin order), then pickValue, then items used in Legend I before unused ones, then normScore, then shortest time, then cost, then name. Unused items have value 0 and keep the shortest-first order at the bottom.
  - **Repeats:** none are penalized, as asked.
- **The scheduler and forecast** still take `researchCandidates(...)[0]`, which is now the weighted pick, so the 24h forecast, the Plan tab's lab picks and the CLI follow it automatically. The Pet House and Blacksmith code paths are untouched.
- **Settings:** `lab.kindWeights {troop, spell, siege}` in `config/settings.sample.yaml`, coerced with a ≥ 0 rule (0 = never auto-pick that kind; negative or junk values fall back to the default).
  - The Settings tab has three number inputs. Invalid input is reverted.
  - The pin handler now keeps `kindWeights` when saving pins; before this change it replaced the whole `lab` object.
- **Lab tab:**
  - Three sections (Laboratory · Troops / Spells / Sieges), each ranked by its own score with the existing rank function (pins first, unused at the bottom). They come from `plan.labByKind`.
  - **"Next in lab"** names `plan.lab[0]`, its kind and pick value, and the best unpinned candidate of each other kind with its value. When the pick is pinned it says "pinned". When the Laboratory is busy it adds "starts when X finishes (in …)".
- Plan reasons for lab items append `· lab pick 0.50 (1.00 of top siege × 0.5)`.
- **SPEC Step 3:** item images were added to the plan only. Nothing is built yet.

# Decisions (review fixes, REVIEW.md)

One line each: decision, then why. Finding numbers refer to REVIEW.md.

## Rules from the user (not findings)
- **Laboratory upgrade is Tier 0, first** (Lab → new buildings → Queen), both modes. It never holds the TH gate; the Pet House stays in the offense tier. *Why:* the user's rule; lab levels gate every research.
- **Finding 2 is not a bug: research and Laboratory / Pet House upgrades run in parallel.** The old "no research while the building upgrades" block is removed; nothing blocks the other way either. *Why:* that's the in-game behaviour, per the user. The committed fixture now starts the Lab upgrade and keeps researching.

## Engine
- **#1 Required merge-source level = the source's max level at the merge's unlock TH** (`maxLevelAt(source, { th: unlockTH })`). A merge holds the TH gate only if enough sources exist **and** each can reach that level at the current TH. *Why:* the user's decision; levels a newer TH adds can no longer deadlock the rush TH. Today's values are unchanged (Cannon/AT 21, Wizard Tower 17).
- **A started merge counts as built for the gate** (unchanged rule, now in SPEC): in the TH19 test the TH starts alongside the two Super Wizard Tower merges. *Why:* consistent with "a building under construction counts as built".
- **#3 Weight 0:** lab candidates of that kind get `autoPick: false`, sort after every auto-pickable item, and are skipped by `nextResearch()` (scheduler, forecast, "Next in lab"). **Pins override weight 0.** *Why:* "never auto-picked, still listed" from the user; a pin is an explicit request, so it wins.
- **#4** The merge-consumption check runs in the browser (`dataIssues()`, cached per data object) and its errors are Plan-tab warnings. Planned copies are never generated for an item with `countAfterMerges` but no recipe. *Why:* the user's decision; raw counts would ask for buildings that were merged away.
- **#5 Supercharge eligibility:** base at `maxLevelAt(base, { th })` (and > 0), supercharge level `thRequired ≤ TH`.
- **#6 "Now" state:** `simulate()` returns `nowState` (jobs due at t = 0 applied, nothing new started). `buildPlan` builds the top priorities, lab / pets / equipment, book-ready list and the TH / Hero Hall levels from it. "Next in lab" only says "starts when …" for a job still running (`end > 0`).
- **#8** The lookahead keys on `thInst.upgradingTo` (the TH itself). The weapon still shares the TH lock for candidacy.
- **#10** An export timestamp > 5 min (`FUTURE_TOLERANCE_SEC`) in the future → plan warning. Timers still count from "now". The fixture's `T0` moved to 1 790 000 000 (21 Sep 2026); only its timestamp changed.
- **#14** Removed `bookThreshold()`, `metaScore()`, `superchargeUpgrading`, `'hero-banner'` and `'laboratory'` in `OFFENSE_ORDER`. The engine reads `recipe.unlockTH`. `IDS` + `levelsOf` moved to `src/state/levels.ts`, and `parseExport` uses `levelsOf`. *Why:* one derivation of TH / Hero Hall / lab / pet / blacksmith levels.
- **#15** `builderCandidates` = `heroDrafts`, `townHallDrafts`, `plannedBuildings`, `mergePlan`, `genericDrafts`, `superchargeDrafts`. Each emits a semantic `Group`; `place()` maps it to tier + order once (LPT for tiers 5–6 inside `place()`). No candidate's tier is overwritten later.
- **#17** Unknown cost-resource strings are still counted as gold, but now produce a `GameData.warnings` entry, shown on the Plan tab and by sync.
- Book-ready entries carry `timeSec` (Gold-Pass time when on) and `rawTimeSec`. *Why:* spec ambiguity 12, as decided by the user.
- `TimelineEntry` gained `lockUid`. *Why:* the "one upgrade per lock" test checks every lock, not just the TH (#18).

## Tooling
- **#7 Validation that blocks** a new data version: `normalize` throws, no TH levels/items, or `checkLevels` errors. Merge consumption and hero caps stay warnings. *Why:* SPEC §9 says validation warnings don't block the site; the site handles stale merges itself (#4). Blocking on merges would also hold back a TH19 release until `merges.yaml` is edited.
- **#7 Major pin:** sync and refresh ask `npm view "clash-of-clans-data@<N+1.0.0" version --json` (N = installed major) and install that exact version. *Why:* a caret range on 0.x would block minor releases (`^0.19.1` = `<0.20.0`); an explicit `<N+1` keeps every 0.x minor but never jumps to 1.0.
- **#7 State:** `lastGoodDataVersion` and `dataFailure {version, reason, at}` live in the existing git-ignored `data/refresh-state.json`. sync exits 1 when it restored or failed, so the refresh prints its one-line warning; the refresh then warns on every start while `dataFailure` is set, and doesn't reinstall that same version each start (a newer release, or `npm run sync` by hand, retries). *Why:* "keep warning on every start until fixed" without a slow reinstall on every `npm run dev`.
- Sync logic in `scripts/lib/sync.ts`; Node side effects for sync and refresh in `scripts/lib/nodeDeps.ts` with injectable `execSync`/`spawnSync`. *Why:* the wiring (timeouts, exit codes) is now tested.
- **#9** Instead of re-aging the run state: when a run state is too old to resume (> 24 h) but written within 7 days, its unfetched players go first in the next run's player list (capped at `maxPlayers`). *Why:* the predev cadence starts the next run ~24 h later, so re-aging alone would still drop them.
- Meta run logic moved to `scripts/lib/metaRun.ts` (paths, API client, clock injected). The non-TTY output now prints only the final progress line per phase. *Why:* resume, carry-over, pruning and exit codes are testable; output is unchanged on a terminal.
- **#12** A rankings location that fails after retries is skipped (`onSkip` logged); 401/403 still abort. `Retry-After` (seconds) is used when longer than our backoff, capped at 60 s.
- **#11** Redaction moved to `scripts/lib/redact.ts`: any string value matching `^#[0-9A-Z]{3,}$` that isn't a pseudonym becomes `#REDACTED`; `*LeagueGroupTag` keys are dropped; a full player profile (has `achievements`) gets its stats zeroed and its achievements reduced to name + village. Idempotent, so the committed fixtures were re-redacted in place with no API call. *Note:* the old tag is still in git history; rewriting history needs the user's go-ahead.
- **#13** `npm run plan -- <path>` with a missing path errors; the samples/fixture fallbacks only apply with no argument.
- Settings from localStorage are merged per nested object (`forecast`, `lab`, `lab.kindWeights`, pins) over the YAML defaults. *Why:* settings saved before a field existed fell back to hard-coded weights (a missing test from REVIEW).

## Skipped
- **#16 bundle size:** not done (v2), as instructed.

# Decisions (GitHub Pages hosting)

One line each: decision, then why. The user asked for no questions, so these are my calls.

## Pre-publish safety check (all 15 commits, every ref)
- **Result: clean, repo made public.** No `.env`, `samples/`, `battles.jsonl`, `run-state.json` or `refresh-state.json` was ever committed (every path in history is still tracked in HEAD). No JWT-like string (`eyJ…`), bearer token or `TOKEN=` value anywhere. The only real tag in history is the known league-group tag `#8UG890J` (accepted, history not rewritten). Every other tag is a pseudonym (`#PLAYER1`, `#CLAN1`, `#TEST`). The only IP is the test's `1.2.3.4`. Long strings are army share codes. *How:* `git grep` over `git rev-list --all` plus the list of every path ever committed.

## Build and base path
- **`npm run build:pages` = `tsc --noEmit && vite build --mode pages`**; `vite.config.ts` sets `base` to `/Hibiscus-clash-advisor/` only when `mode === 'pages'`. *Why:* a Vite mode needs no env var (works the same in PowerShell and CI), and `npm run dev`, `npm run build`, `npm run preview` and tests stay at `/`.
- **No fetch changes were needed:** the only runtime fetch (`meta.json` in `src/main.ts`) already used `import.meta.env.BASE_URL`. There is no `data-changes.json` and no image fetch; game data is bundled at build time by `import.meta.glob`. SPEC §2 now makes `BASE_URL` the rule for any future fetch.
- `tests/pages.test.ts` checks the base per mode and that the workflow's `run:` steps are exactly `npm ci`, `npm test`, `npm run build:pages`, with no refresh/meta/sync/token. *Why:* keeps "no token in CI" from drifting.

## Workflow
- **One `build` job (ci → test → build:pages → upload artifact) and a `deploy` job** using the official `actions/upload-pages-artifact` / `actions/deploy-pages` (now v5 / v5, with `actions/checkout@v7` and `actions/setup-node@v7`, all on the Node 24 runtime). Tests run before the build in the same job, so a failure means no artifact and no deploy.
- **Node 24** in CI. *Why:* matches the local major (v26 isn't an LTS on setup-node yet; 24 is the active LTS) and is new enough for Vite 8 / TypeScript 7.
- Plain `npm ci` (install scripts allowed). *Why:* `predev` only runs on `npm run dev`; blocking install scripts could break esbuild/rolldown binaries for no gain.
- `workflow_dispatch` added. *Why:* lets the site be redeployed from the Actions tab without a dummy commit.
- `concurrency: pages`, no cancel-in-progress. *Why:* GitHub's recommended setting; a deploy in progress is never cut off halfway.
- Pages enabled with `gh api -X POST repos/TropicalHibi/Hibiscus-clash-advisor/pages -f build_type=workflow`.

## `npm run push-meta`
- **Logic in `scripts/lib/pushMeta.ts`** (git injected, tested in `tests/push-meta.test.ts`); `scripts/push-meta.ts` wires real `git`. *Why:* same pattern as refresh/sync/meta.
- Commits with `git add -- public/meta.json` then `git commit --only -m "meta: <generatedAt>" -- public/meta.json`. *Why:* `--only` commits that one path and leaves anything else that was already staged alone, so it's "only that file" even with other work in progress.
- **Does nothing if unchanged; refuses (exit 1, no commit) when not on `main`.** *Why:* Pages deploys from `main`; a meta commit on a feature branch would never reach the site.
- Pushes `origin main`. A rejected push keeps the commit and prints a one-line fix hint (`git pull --rebase`, then `git push`), exit 1. *Why:* never rewrites or force-pushes anything.
- `generatedAt` is used as written in meta.json; an unreadable file is committed as `meta: unknown`.
- **Reminder** `[refresh] meta.json updated: run npm run push-meta to update the live site.` is printed after a meta run exits 0 or 2 (both wrote meta.json), not after a fresh/no-token/failed run. *Why:* exit 2 is a partial run that still updated the file (SPEC §9a). It is not prefixed `warning:` because nothing failed.

## Docs
- SPEC: intro, §1 scope, §2 (base rule + scripts table), §4 layout, §9a step 5, §15 split into 15.1 GitHub Pages (done) and 15.2 v2+. Scheduled CI (daily meta / version check) stays v2+ because the API key is IP-locked.

# Decisions (Step 3: polish)

One line each: decision, then why. The owner asked for no questions, so these are my calls.

## What the real export says (`samples/myexport.json`)
- **`boosts` is `{}`**: no potion, snack or clock tower was running, so its real shape is still unseen. I support the keys coc.py's `Boosts` parser reads (`builder_boost`, `lab_boost`, `builder_consumable`, `lab_consumable`, `clocktower_boost`, `clocktower_cooldown`, `helper_cooldown`, all seconds). *Why:* that's the only documented shape. Any other key, a non-number value or a non-object `boosts` gives a Plan-tab warning, never an error.
- **Helpers:** `helpers` = Builder's Apprentice L8, Lab Assistant L7, Prospector L2, Alchemist L1, each with `helper_cooldown: 8426` (≈2 h 20 m). *Reading:* one shared cooldown, like coc.py (it copies any helper's `helper_cooldown` into one shared field). With several values, I take the largest.
- **The recurrent flag is `helper_recurrent`** in the real export: on Grand Warden (the Builder's Apprentice) and on Druid (4000123, the Lab Assistant). coc.py documents `recurrent_helper`. Both are accepted. *(Corrected: this line first said Archer for the Lab Assistant; the owner confirmed Druid.)*
- **No `helper_timer`** in the real export. Supported as coc.py documents it: seconds left of a helper's work hour on that upgrade.
- Prospector L2 isn't in the data (which only has L1). Harmless: it doesn't affect timing.

## Boosts (`src/engine/boosts.ts`)
- **A work clock per queue** (builders, research) maps wall time ↔ work done. A boost window adds `(multiplier − 1)` work per second while it lasts, counted from the export time. *Why:* one exact, piecewise-linear model that handles running jobs, new jobs and boosts that ran out between the export and now. With no boosts it reduces to `end = start + time`, so nothing else changed.
- **Multipliers** *(superseded by "Follow-up: helpers, boosts, unknown jobs": the Research Potion is Laboratory only, the Pet House has its own Pet Potion, and the Bite is +1× additive)*: Builder Potion ×10, Research Potion ×24 (lab **and** pet house), Builder Bite ×2, Study Soup ×4, all in `BOOST_MULTIPLIER`. *Why:* the potion values are well known; the snack values and the potion's pet-house effect are my best guess (listed under "Check in-game").
- **Clock Tower:** parsed and ignored. *Why:* it only boosts the Builder Base, which v1 ignores.
- Export `timer` values are taken as remaining **work** time, and a boost active at the export speeds them up from then on. Goblin jobs are boosted too (potions boost every builder).
- Simultaneous boosts on one queue add their extras (potion + snack). Unverified.

## Helpers
- **Work model** *(cycle superseded by the follow-up: a shared 23-hour cycle)*: each helper works one hour a day (1 h + 23 h rest, `HELPER_PERIOD_SEC`). In that hour its job runs at `1 + workRate` speed, so it gains `workRate` hours, or less if the job finishes inside the hour. `workRate` comes from the helper's level in `other/helpers` (Apprentice L8 = 8 h, Assistant L7 = 7 h). *Why:* matches the data's `workRate` field and the in-game "×N for 1 hour" description.
- **Timing** *(superseded by the follow-up: every 23 h, not 24 h)*: first work hour = export time + `helper_cooldown` (or now, without a cooldown), then every 24 h. Work hours between the export and now are applied to the jobs running then, in time order, before the simulation starts. *Why:* the export can be a day old (the real one was 1 d 9 h old).
- **Assignment rule:** (1) the job on the instance the export marks recurrent, while it's running; (2) otherwise the Apprentice takes the **builder job with the most time left**, and the Lab Assistant takes **the running Laboratory research**; (3) never a Goblin job. The Assistant never helps the Pet House. *Why:* the spec's default rule, with the export's own assignment first. A Goblin job ends on its own and frees no slot, so helping it gains nothing.
- **A recurrent target that isn't upgrading** falls back to rule (2). *Why:* in-game the helper would otherwise idle; falling back is the useful plan. Listed under "Check in-game". (This doesn't affect the owner's plan today: both repeat targets, Grand Warden and Druid, are upgrading.)
- **The recurrent flag stays with the instance**, so it carries over to that hero or building's next upgrade in the simulation. *Why:* "recurrent" reads as "keep helping this one".
- A helper level the data doesn't know uses the highest known level at or below it, with a warning.
- **One "Simulate helpers and boosts" toggle** (default on) covers both. *Why:* off must equal the old behaviour exactly (raw timers), and a test checks that.
- The plan's summary line names the helpers, their hours per day, the next work-hour time and any running boost. Timeline rows show `helpers −8h` on the jobs that were helped.

## Alchemist and id overrides
- `config/id-overrides.yaml` (`ids: { 93000003: alchemist }`) is read by `normalize()` in both loaders. A file without a `dataId` gets the override; if the data later ships a dataId, the data wins, and a mismatch shows a warning. *Why:* one generic place for future missing ids, instead of a special case.
- Helpers are no longer turned into building instances: they go into `AccountState.helpers`. *Why:* they were never upgradable by builders.

## `npm run sync` snapshots and diff
- **Snapshots are git-ignored** (`data/snapshots/*`, with a `.gitkeep`), and the newest **two** are kept on disk: the current one and the one it was diffed against. *Why:* one snapshot is ~330 KB compact (~510 KB pretty), and every data release would add one. That isn't "small". The diff lives on in the committed `public/data-changes.json`.
- Snapshot = the normalized `Item` model sorted by key, without image paths. One per data version: re-running sync on the same version doesn't rewrite it and prints no diff.
- **The diff compares against the newest snapshot of another version.** Items match by key (dataId-based); a name change is a `RENAMED:` line. Levels: new, removed, cost (or resource), time and requirement changes (TH, Hero Hall, Lab, Pet House, Blacksmith). Equipment compares all three ores.
- `public/data-changes.json` is written only when a diff exists (a new version with a previous snapshot). Sync prints up to 200 lines and saves all of them.
- **Baseline:** I wrote the first snapshot (`2026-11-16_0.19.1.json`) with the new **`npm run sync -- --offline`** flag, which validates and snapshots the installed version without npm. *Why:* a real `npm run sync` could install a new data release (Hero Hall 13 lands today) in the middle of this step, and that release needs its own review. The next `npm run dev` (predev refresh) or `npm run sync` will diff against this baseline and show the banner.
- A snapshot/diff failure is logged as `[WARN]` and never fails the sync or triggers the known-good rollback. *Why:* the data itself loaded fine.
- **Banner:** shown on the Plan tab when `data-changes.json` matches the bundled data version, has changes, and that version hasn't been dismissed. Dismissal is saved per version in localStorage. *Why:* "the first time the site loads a new version" means it stays until you've seen it, without coming back for the same version. A stale file (from another version) never shows.
- The footer now shows "(synced <date>)" when `data-changes.json` matches the data version (SPEC §9 step 5).

## Everything tab
- **One full scheduler run from "now" with the Town Hall frozen** (`freezeTownHall`), to completion. Builder rows are grouped by each job's tier. *Why:* "time-to-max from the scheduler, not a plain sum" needs the real simulation, and freezing the TH keeps it to "everything left at this TH" instead of running into the next TH forever.
- **Time to max** = the last builder job's end, including running and Goblin jobs. It's shown for the current Gold Pass setting and the other one (a second run). Raw and Gold Pass totals per tier are sums of data times (raw × 0.8).
- **Not scheduled** (listed, not in time to max): book-ready hero levels up to the Hero Hall cap at the end of the run, lab kinds with weight 0, and in rush mode the next Town Hall.
- **Blacksmith** = every remaining level of owned equipment up to the max at the final Blacksmith level (ore only). **Walls** = each wall level up to the max at this TH × wall count. Both are instant: no time.
- Rows are summed per item ("Cannon · 14 upgrades · 19 → 21") inside closed `<details>` sections. *Why:* the real account has ~1,570 upgrades left. Per-level rows would be unreadable on a phone.
- Computed when the tab opens and not on the 60-second refresh. *Why:* it takes ~1.7 s on the real account (two full runs) and changes slowly.

## Hero order
- HTML5 drag-and-drop on the list rows (desktop), with the existing ↑/↓ buttons kept (touch). There's a "Reset hero order to default" button, disabled while the order is already the default. The Queen's row shows "· Tier 0", and the card says her Tier 0 rule belongs to her, not to slot 1.
- `moveHero()` (one function for both drag and buttons) and `heroOrder()` coercion. A saved order keeps its order, drops duplicates, keeps ids newer than the defaults and appends any missing default hero. *Why:* a new hero shouldn't vanish from a saved order, and a saved order missing a hero must still schedule it.

## Item images
- **One image per item**, chosen at build time by the `virtual:item-images` Vite plugin from `Item.images` (candidates: icon, then level images from the top level down). *Why:* the account's levels are only known in the browser, so per-level images would mean bundling every level (most of the 52 MB folder).
- **Size cap 300 KB per file** (`IMAGE_MAX_BYTES`): the first candidate under the cap wins; if none is under it, the item shows its name only. *Why:* the package's "PNG"s are WebP, some 4096 px and ~1 MB, shown at 28 px. Uncapped, the build was 21 MB (190 files). Capped, it's 8.8 MB (171 files). 20 items show name only (16 pieces of equipment / spells / buildings + 1 supercharge + 3 helpers that are never shown).
- ~~I tried to add `sharp` … blocked~~ → **done in the follow-up below** (the owner approved the install). The 300 KB cap is gone.
- `assetsInlineLimit` keeps package images as separate files (never base64 in the JS), so `loading="lazy"` works. `width`/`height` attributes fix the size. `alt=""` (the name is right next to it). `onerror="this.remove()"` means no broken-image icon.

## Follow-up: icons resized with sharp
- **`sharp` is a dev dependency** (0.35.5, prebuilt binaries for every platform incl. linux-x64 in the lockfile, no install script needed). Only the build imports it, lazily (`scripts/lib/itemImageCache.ts`). *Why:* the owner approved it; it decodes the package's WebP-in-`.png` files and makes real icons.
- **96×96 WebP, `fit: contain` on a transparent background, quality 80 (alpha 90).** *Why:* the size the owner asked for, described as 2× the display size. Icons display at 20–28 px today, so 96 px stays sharp even on 3× phone screens. `contain` keeps the whole picture: no cropping of wide buildings.
- **Resize only in `vite build`.** The dev server and Vitest (`serve`) keep using the original files. *Why:* tests and `npm run dev` never need sharp, and the first dev start isn't slowed.
- **Cache:** `.cache/item-images/<sha256(recipe + source bytes)[0:20]>.webp`, git-ignored. *Why:* a content hash survives `npm ci` (new mtimes) and changes when the package ships a new picture; the recipe in the hash regenerates everything when the settings change. Writes go to a `.tmp` file and are renamed, so an interrupted build never leaves a half icon. Icons no longer referenced are deleted at the end of a build, so the cache stays at the current set.
- **CI:** an `actions/cache@v6` step (Node 24) keeps `.cache/item-images` between runs, keyed on `package-lock.json` + the cache module, falling back to the newest earlier cache. *Why:* the "don't reprocess unchanged images" rule also holds in the workflow. It isn't a `run:` step, so the "no token / no refresh" test is unaffected; a new test checks that the cache step is there.
- **No size cap any more:** `pickItemImages` takes the first existing candidate (`maxBytes` defaults to Infinity). A resize failure is a build warning, and that one item shows its name only.
- The build logs one line: `190 icons at 96px: N resized, M from cache (… ms)`. A cold run resizes all 190 in under a second here.
- `vite.config.ts` now imports local files with `.ts` extensions (and `tsconfig` allows that, since it never emits). *Why:* the extensionless imports added in Step 3 triggered Vite's "unsupported by configLoader: 'native'" warning on every build.

## CI
- Pages workflow actions bumped to their current majors (`actions/checkout@v7`, `actions/setup-node@v7`, `actions/upload-pages-artifact@v5`, `actions/deploy-pages@v5`). All run on Node 24 (upload-pages-artifact is a composite over `upload-artifact@v7`). The first run after the bump passed (build + deploy), with no Node 20 deprecation annotation.


# Decisions (follow-up: helpers, boosts, unknown jobs)

Rules 2, 3 and 5 below come from the owner. Everything else is my call, logged here.

## Running upgrades on unknown ids
- **An export entry with a `timer` whose dataId isn't in the game data still occupies its slot** until the timer runs out (boosted by any active potion like any job). It shows in the timeline as `Unknown item <dataId> (not in game data yet)`. *Why:* the slot is really busy in-game. Before, the parser dropped the entry and the planner offered that builder a new upgrade (the owner's B6 with new building 1000106 at level 0).
- **Which slot comes from the export section:** buildings, traps, heroes, guardians and crafted-defense modules → a builder; units, troops, spells and siege machines → the lab; pets → the pet house; `extra: true` → a goblin slot (as for known items). Equipment and helpers have no timers.
- One job per `cnt`, like known items. `helper_recurrent` and `helper_timer` on an unknown entry are honoured, so a helper can be assigned to it. When it finishes, nothing is applied (there's no item to level up), and the slot takes the next upgrade.
- The warning for such an id says its upgrade still occupies a slot; unknown ids without a timer keep the old "ignored" warning. `AccountState.unknownJobs` holds them; `Unresolved.upgrading` marks them.
- **Builder count is unchanged** (huts + B.O.B). The owner's 6 builders were right; only the sixth job was missing.

## Helpers
- **Cycle = 23 hours** (`HELPER_PERIOD_SEC`), shared by all helpers and starting when a helper is assigned. The next work hour is the end of the export's shared `helper_cooldown`, then every 23 h. *Why:* the owner's rule.
- **Level L saves L hours per work hour** (unchanged formula). For a job that finishes inside the hour, the saving is proportional (it finishes after r / (1 + L) of the hour, as before). *Why:* "L× speed for 1 hour = L hours saved" fixes the full-hour saving at L hours; the short-job case keeps the existing continuous formula.
- **Potions don't speed up the helper's work:** the helper's L hours are added in *work* units on top of the queue's boosted progress, never multiplied by it. A test checks that potion + Apprentice L8 in the same hour saves 9 + 8 hours, not 80. This was already the model; it's now stated in SPEC and tested.

## Boosts
- **Builder Potion** = `builder_boost` seconds left, builders ×10. **Builder Bite** = +1×, stacking additively: potion + bite = ×11, bite alone ×2. (The old constant 2 already meant +1× extra; now it's documented and tested.)
- **`clocktower_cooldown` is a cooldown, never applied.** The Clock Tower boost is Builder Base only and never applied either. Neither appears in the summary's boost list.
- **Research Potion = ×24, Laboratory only.** The lab and the pet house now have separate work clocks.
- **Pet Potion = ×24, Pet House only.** *Assumption:* its export key is `pet_boost` (not in coc.py; follows the `builder_boost` / `lab_boost` pattern). Any other key still produces an "unknown boost" warning, so a different real name will show up.
- **Study Soup** stays ×4, Laboratory only (still unverified).

## Display
- **A finish time more than 6 days away shows the date:** "Tue Nov 24, 9:24 AM". Within 6 days it's the weekday ("Wed 11:40 PM"); today, the clock only. *Why:* the owner's rule; a weekday alone is ambiguous past a week. It applies everywhere `fmtClock` is used (Plan tab, CLI, forecast "needed by").

## Wording fix
- The Lab Assistant's repeat target in the owner's export is **Druid (4000123)**, not Archer. REPORT and DECISIONS are corrected. Both repeat targets (Grand Warden, Druid) are upgrading, so the "recurrent target not upgrading" fallback doesn't affect the current plan.

## Tests
- `tests/followup.test.ts` covers: an unknown level-0 building holding a builder (nothing "Now"), unknown research / pet / goblin jobs in their slots, unknown ids without a timer, the real export (B6 busy, when present), the 23-hour cycle, potion + Apprentice, potion + bite = ×11, the clock tower cooldown, Research Potion vs Pet Potion, and dates past 6 days.
- Updated: three helper tests now expect the second work hour that a 23-hour cycle puts inside the 24-hour window; the boost-keys test includes `petPotionSec`. The two real-export tests now check that every unresolved id is truly missing from the data and that each running one became a slot-holding job: the new export contains ids newer than data 0.19.1 (building 1000106, equipment 90000062 and 90000063).


# Decisions (ore is never forecast)

The owner's rule: ore is time-gated (daily attacks, wars, raids, events), so it doesn't belong in "Resources needed". Below are my calls on applying it.

- **Removed from the 24 h forecast everywhere:** `Forecast` no longer has `ore` / `oreItems`, and `forecast()` takes only the timeline and the window. The Plan tab loses the shiny / glowy / starry tiles and the "Ore picks" card; the CLI loses the "Ore (top 3 equipment)" lines. The REPORT's plan-output blocks lost their ore rows too (12 lines), and the prose that mentioned "ore picks" now notes the change.
- The Plan tab shows one line under the resources instead: "Ore isn't forecast… Equipment ore costs are on the Lab / Pets / Equipment tab." *Why:* someone used to the ore tiles should learn where they went. If nothing starts in the window, the Plan tab now says so instead of showing an empty grid (before, the three ore tiles always filled it).
- **Kept, informational:** the Blacksmith section of the Lab / Pets / Equipment tab still ranks by Legend I usage, and each row reads "ore cost: X shiny · Y glowy · Z starry" for the next level, with no time. The ranking, pins and the cheapest-first fallback for unused pieces are unchanged.
- **The CLI gets a "Blacksmith (top 3, by Legend I usage)" list** with the same "ore cost" label, next to its Lab and Pet House lists. *Why:* the CLI's only equipment output was the forecast's ore rows; without this, the CLI would lose equipment entirely. It's informational, like the tab.
- **The Everything tab's Blacksmith section keeps its ore totals** (every remaining level). *Why:* "everything left" is informational, not a 24-hour need, and has no "needed by" time.
- **`forecast.blacksmithTopN` is deleted** (type, defaults, `coerceSettings`, `config/settings.sample.yaml`). Nothing else used it. A value saved in localStorage is ignored by `coerceSettings` (tested).
- Tests: the old "ore totals cover the top-N picks" test was replaced by "ore is never forecast" (no ore in totals, "needed by" or the CLI resources; equipment still has ore costs; the CLI Blacksmith list says "ore cost" with no "needed"). The meta test now checks equipment order only. The UI test checks: no ore tile, no "Ore picks", and equipment rows show "ore cost:" with no "needed by".


# Decisions (daily game-data update Action)

One line each: decision, then why. The owner asked for no questions, so these are my calls.

## Workflow (`.github/workflows/data-update.yml`)
- **Daily at `17 10 * * *` (10:17 UTC) + `workflow_dispatch`**, no secrets, never `npm run meta`. `actions/checkout@v7` / `setup-node@v7` (Node 24), like the Pages workflow. Concurrency group `data-update`, never cancelled midway.
- **Deploying: `gh workflow run pages.yml --ref main`** after the push (needs `actions: write`). *Why:* a push made with `GITHUB_TOKEN` doesn't trigger other workflows, but `workflow_dispatch` is the documented exception. I didn't call Pages as a reusable workflow (`workflow_call`) because its checkout would build the caller's commit (the one *before* the data commit), not the new `main`. Dispatching runs Pages exactly as a normal push would, tests included, on the latest `main`. No PAT needed.
- **The commit:** `git add` of exactly `package.json`, `package-lock.json` and `public/data-changes.json`; message `data: clash-of-clans-data <old> → <new> (N changes)`; author `github-actions[bot]`; `git pull --rebase origin main` then push. *Why:* only the files the owner named; the rebase covers a push to `main` landing while the job ran (a conflict is a failure → issue).
- **Steps run as named steps** (`npm ci` → `check` → `npm test` → commit → deploy). The last three only run when `check` says `updated`, so "no new version" ends after `check` with a green run.

## Same code as `npm run sync`
- **`scripts/lib/dataUpdate.ts` wraps `syncData` unchanged**: same deps (`nodeSyncDeps`), so the same version pin (`<N+1.0.0`), validation, known-good restore, snapshot and diff code. It only observes the steps (versions, the failure reason, the diff) through thin wrappers.
- **One change to sync itself, for both paths: snapshot the installed version before installing a newer one.** *Why:* CI starts with an empty `data/snapshots/` (git-ignored), so without it there's no "before" and no diff. Locally it's a no-op (the snapshot exists). A test runs both paths (CI with no snapshots, local with the old snapshot) and gets identical changes.
- **`public/data-changes.json` isn't rewritten when it already holds the same diff** (same versions and changes, ignoring the date). *Why:* after `git pull` brings in the Action's commit, a local offline sync would otherwise change only the date and leave a dirty working tree.

## Stricter checks for unattended deploys
- **A merge missing from `config/merges.yaml` fails the update** (locally it stays a warning, §9). *Why:* the owner asked for an issue naming the merge; and deploying would give every user a Plan-tab warning plus wrong building counts until someone edits merges.yaml. A missing diff also fails (the banner depends on it). Hero-cap mismatches stay warnings (known data quirk).
- **Naming the merge:** `explainMissingMerges()` finds sources whose count drops with no recipe explaining it (per TH), then candidate merged defenses: defenses first available at that TH, not already a recipe, whose count divides each source's extra drop. The data has no "merged from" field, so candidates are ranked: new in this release (from the diff), then the name contains a source's name, then ≤ 2 of each source. *Why:* with today's data and the Super Wizard Tower recipe removed, the count arithmetic also fits Revenge Tower (1 copy = 4 Wizard Towers); the ranking puts Super Wizard Tower first and lists Revenge Tower as "less likely".
- `npm test` runs on the new data in the data-update job, before the commit (Pages runs it again on deploy).

## Failure issue
- **Title `Data update failed: <new version>`** (`Data update failed: npm check` when npm couldn't be asked at all). An open issue with exactly that title is **edited** (fresh body) and gets a "Failed again: <run>" comment; otherwise a new one is created. *Why:* "update, not duplicate"; a newer failing version gets its own issue.
- **Body:** the failing step, from → to, "Nothing was committed", the run link, a plain "A merge is missing from config/merges.yaml" section when that's the cause, the reason, the sync/validation output (the last 120 lines, diff lines left out), the diff summary (first 60 changes) and, for a test failure, the last 80 lines of the test log. If the commit was pushed but the Pages dispatch failed, it says to run Pages by hand instead.
- The failing step comes from the step outcomes (`npm ci`, `check` (the result names its sub-step: npm registry check, install, load + validate, validation: merges.yaml, snapshot + diff), npm test, commit and push, start the Pages workflow). If the issue builder itself can't run (e.g. `npm ci` failed), a minimal body is written by shell.

## Local: `git pull --ff-only` in the predev refresh
- **Step 0 of the refresh**, before the data check: `git pull --ff-only` with a 30 s timeout and `GIT_TERMINAL_PROMPT=0`. Silent when there's nothing new; "[refresh] pulled N new commits from origin." otherwise. Any failure (uncommitted changes that block the merge, diverged history, offline, no repo) is a one-line warning and the refresh continues. *Why:* the owner's rule; `--ff-only` never creates a merge commit or touches local work.
- **If the pull changed `package.json` / `package-lock.json`:** `npm install`, then `npm run sync -- --offline`. *Why:* otherwise `node_modules` would still hold the old data version and the site would run old data with the new lockfile; the offline sync records the local snapshot for the new version (and leaves `data-changes.json` alone, see above).
- Tests: the existing refresh tests now expect a `git` field in the result; the offline wiring test now expects the git pull's own timeout warning first (every command times out there).

## Run on GitHub
- Triggered once with `workflow_dispatch` after pushing (run 43973368778): passed in 15 s, "no new version" (0.19.1 is the newest 0.x); test / commit / deploy / issue steps skipped, nothing committed, no issue opened.


# Decisions (daily Legend I meta Action)

One line each: decision, then why. The owner asked for no questions, so these are my calls.

## Auth (`scripts/lib/auth.ts`)
- **clashofclans.js 5.1.15 is used only to get the token** (`new RestManager().login({ email, password, keyName, keyCount: 1, keyDescription })`). The existing raw-HTTP collector does all the API calls. *Why:* the collector already has the throttle, retries, `Retry-After`, resume and tests; the library's value here is the developer-site key management.
- **Key names:** `hibiscus-ci` when `GITHUB_ACTIONS=true`, `hibiscus-local` otherwise. I read the library source: it revokes only keys with *that* name whose IP doesn't match, reuses a matching one, and creates one if needed. The owner's other keys are never touched. Each CI run lands on a new runner IP, so it revokes yesterday's `hibiscus-ci` key and creates one: the account never holds more than one key of that name. The description says "auto-managed … safe to revoke".
- **Order of sources:** login (email + password from the environment, or `.env` locally) → `COC_API_TOKEN` → a clear "no credentials" error. *Why:* the owner's rule; login survives a changed home IP. The owner's `.env` has only `COC_API_TOKEN` today, so local runs are unchanged until they add the two lines.
- **Masking:** in Actions, `::add-mask::<token>` is printed right after `login()` returns, before anything else (a fixed `COC_API_TOKEN` is masked too). The email and password come from repository secrets, which Actions masks itself.
- **Redaction:** any error text from login or the API passes through `redact()`, which removes the email, the password, the token, JWT-like strings, email addresses, player tags and IPv4 addresses. The library's login error includes the response body, and an API 403 message includes the caller's IP. An unexpected crash in `meta-ci.ts` is printed redacted too.
- `hasToken()` in the predev refresh now means "login credentials or `COC_API_TOKEN`".

## Workflow (`.github/workflows/meta.yml`)
- **Daily `7 11 * * *` + `workflow_dispatch`**, Node 24, same action versions as the others, concurrency group `meta`, 30-minute timeout. Secrets are passed only to the meta step and to the issue step (there, only for redaction).
- **Deploy like the data-update Action:** `gh workflow run pages.yml --ref main` after the push (needs `actions: write`).
- **Committing meta.json:** `git add public/meta.json` only; message `meta: <generatedAt>`; author `github-actions[bot]`. Skipped when the staged file is identical. `git pull --rebase -X theirs` before pushing. *Why:* `-X theirs` during a rebase means "our replayed commit wins", so a concurrent `npm run push-meta` from the PC can't make the Action fail on a conflict in that one file; the Action's copy is the newer one.

## battles.jsonl on the `meta-data` branch
- **One file, `battles.jsonl.gz`, plus a README, in a single parentless commit** made with `git hash-object` / `git mktree` / `git commit-tree` and force-pushed to `refs/heads/meta-data`. *Why:* "single commit, no history growth"; plumbing builds it without touching the checked-out tree or needing a second clone, and uses the checkout's push credentials. The first run's file: 13,707 rows, 304 KB gzipped.
- **Pruned to the 14-day aggregation window** in CI (`pruneDays: windowDays`), instead of the local 60 days.
- **Player tags are pseudonyms in CI rows** (`h` + the first 16 hex of SHA-256("hibiscus-meta:" + tag)), applied before dedupe through a new `tagMap` option. *Why:* the repo is public, and the project never committed raw tags before (SPEC §15, REVIEW #11). Aggregation needs a tag only to dedupe (`tag + ts`) and to count distinct players, and both work on a stable pseudonym. It's pseudonymity, not anonymity: someone hashing every tag from the public rankings could match them. That's written in SPEC §15.
- **No run state in CI** (`noRunState`): no resume or carry-over between CI runs. *Why:* `run-state.json` holds the raw player list, and each daily run gathers 1,000 players afresh anyway.
- **Stored whenever new attacks were collected**, even if `meta.json` isn't committed (a run that's "worse" than the current meta still adds real attacks for tomorrow). Not stored after a login failure, a 403 or "API down" (nothing new).

## Never commit a worse meta.json (`decideMeta`)
- **Minimum 2,000 attacks in the window** (`MIN_META_ATTACKS`). *Why:* a normal daily run has ~13.7k (two days of Legend I logs from ~900 players). 2,000 is ~15 % of that: still a few hundred armies per popular troop, so shares are stable to a point or two, yet far above what a broken run produces.
- **A partial run may commit if it fetched ≥ 50 % of the players it gathered** and meets the other minimums. It still opens/updates the issue, which says it was committed anyway. *Why:* the owner's "a partial run with enough attacks can still commit"; under half the players skews the sample towards whichever countries answered.
- **Never below 50 % of the current meta's attack count.** *Why:* it catches a run that "worked" on a small sample (e.g. an empty meta-data branch while the current meta came from two weeks of data).
- **API down:** no players gathered, or no battle log fetched → failure; nothing stored.
- **Unchanged** apart from `generatedAt` → no commit, not a failure.

## Issue "Meta update failed"
- **One issue with that exact title**, edited (fresh body) plus an "Again: <run>" comment on each later failure; created when none is open. **Closed automatically** with a "Recovered: <run>" comment by the next clean run. *Why:* "open or update one issue"; closing it keeps the list honest without a manual step.
- **Body:** step, whether `meta.json` changed, run link, redacted reason, numbers (players fetched / gathered / failed, new attacks, attacks vs current), the minimums, which auth was used. It's built from the result file; if the meta step never wrote one (e.g. `npm ci` failed), the shell writes a minimal body.

## Predev refresh
- `npm run meta` runs locally only when the pulled `meta.json` is over 24 h old (the git pull in step 0 brings the Action's copy first). The 24 h check itself didn't change; the new part is that the pull runs first. The stale and no-credentials messages say the Action probably missed a day.
- **The push-meta reminder now reads:** "meta.json updated locally (the daily Meta Action normally does this). Run npm run push-meta only if you want this copy on the live site now."

## First run (workflow_dispatch, 16 Nov 2026)
- Run 43976109553 passed in 2 m 20 s. It logged in (key "hibiscus-ci"), fetched 1,000 of 1,000 players with 1,037 API requests, and kept 13,707 Legend I attacks (900 players). It committed `meta: 2026-11-16T23:07:32.292Z`, started Pages (deployed; the live `meta.json` shows 13,707 attacks) and created `meta-data` (1 commit, 304 KB). No issue was opened. There was no `meta-data` branch before, so the run started from an empty battles.jsonl; the new meta (13,707) passed the "≥ 50 % of current" check against the local one (13,629).

# Decisions (game data from ClashKing)

The game data now comes from ClashKing's `static/static_data.json` (`ClashKingInc/clashy.go`). clash-of-clans-data stays for item images, TH weapons and as the backup source. SPEC §3.1, §5, §7, §9, §9a, §9b, §12 and §15 are updated.

## Where the data lives
- **Pinned in the repo:** `data/clashking/static_data.json` + `pin.json`, both committed. *Why:* the Pages build and the browser need the file without network access, and the commit is what pins the version (like `package-lock.json` pins clash-of-clans-data). The daily Action commits a new copy; `npm run dev` pulls it (§9a step 0).
- **Trimmed before pinning:** only `buildings, traps, troops, spells, heroes, pets, equipment, guardians, helpers`, home village only, without the `info` texts and `TID` keys. That's 0.94 MB on disk (1-space indent, so version-to-version git diffs stay readable), down from 1.79 MB. `pin.json` keeps the sha256 of the **untrimmed** download, so the pinned version can be checked against upstream.
- **Version:** `clashking-<tag>` (e.g. `clashking-v0.1.20`), or `clashking-main-<sha7>` when no release has the file. This is `GameData.version`, the snapshot name and the `data-changes.json` version. The footer shows "ClashKing v0.1.20".
- **Release resolution:** `releases/latest` → its commit → the file must exist at that tag (`contents/…?ref=<tag>`), else main. The file is downloaded from `raw.githubusercontent.com/<repo>/<commit>/…`, by commit rather than by tag name, so a re-pointed tag can't swap the file under the pin. Only `api.github.com` gets the workflow token (for rate limits); raw downloads get no token. It's never printed.
- **Fetching:** a synchronous child `node -e fetch(…)` process, with the URL and headers passed through the environment. *Why:* the sync code is synchronous (npm calls via `execSync`) and fully injected for tests; this keeps it that way and works the same on Windows and Linux (no curl/wget dependency). Tests inject a fake (`execFile` / `ClashKingDeps`), so no test touches the network.

## Normalization (`src/data/clashking.ts`)
- **Cost/time semantics differ by kind, and I checked them against clash-of-clans-data before choosing.** For every shared item and level I counted matches at offsets −1/0/+1. Buildings and traps match at offset 0 (362 costs, 380 times). Troops, spells, heroes, pets, guardians and equipment match at +1 (troops 174 costs vs 12 at offset 0, heroes 441 vs 5, pets 143 vs 0). `required_*` matches at offset 0 everywhere (troop lab 313 vs 24). So for upgrade-style items, row N's `upgrade_cost`/`upgrade_time` is the cost of N → N+1: level N takes row N−1, level 1 is free, requirements are not shifted. The remaining differences follow a rebalance pattern (lower costs on older levels), not a shift.
- **Item ids are slugs of the names** (`Builder's Hut` → `builders-hut`). All 220 items that clash-of-clans-data also has get the same id as its file id, except the two swapped dataId pairs below. So settings (hero order, pins) and engine ids keep working unchanged.
- **Building counts = running sum of Town Hall `unlocks`.** That gives pre-merge totals, identical to clash-of-clans-data's `availablePerTownHall.count` except for a few low-TH values (Cannon at TH1, B.O.B's Hut, Hero Hall at TH4–6, Monolith at TH14, Crafting Station TH18 → TH19).
- **A TH-level `merge_requirement` (TH17 → Eagle Artillery) reduces that building's count from that TH.** *Why:* clash-of-clans-data has Eagle Artillery count 0 from TH17; without this, a TH17+ player would be told to build an Eagle Artillery. ~~It is not made a TH gate~~ — superseded: TH upgrade requirements are now part of the TH gate (see "Decisions (TH upgrade requirements, hero order lock)").
- **Merges = buildings whose level 1 has `merge_requirement`.** The source levels are the exact `level` values (no longer the source's max at the unlock TH). Counts after merges are derived: count − Σ(qty × merged count), from the first merge's unlock TH. At TH16–18 they equal clash-of-clans-data's `countAfterMerges` exactly. `geared_up` is ignored (gear-ups aren't modelled).
- **Recipe order breaks ties at the same unlock TH:** the former `merges.yaml` order (Ricochet, Multi-Archer, Multi-Gear, Super Wizard), then Town Hall `unlocks` order. *Why:* ClashKing's own order puts Multi-Archer before Ricochet at TH16, which would reorder TH-gate items with no data reason. The task says plans must not change except for real data differences.
- **Supercharges** = the `supercharge` block on the top level that has one (`levels[]` priced like buildings, `required_townhall` of the block).
- **Guardians get `countPerTH = {first level TH: 1}`.** *Why:* ClashKing doesn't list guardians in the Town Hall unlocks (it lists the TH19 Guardian Shrine instead). clash-of-clans-data had 1 each from TH18, so this keeps the planner's behaviour.
- **Buildings without levels** (Helper Hut, Crafting Station, Guardian Shrine, Sour Elixir Cauldron) are still items, with queue `none`. *Why:* the real export contains them, so dropping them would add "unknown id" warnings. clash-of-clans-data had a single free level 1 for Helper Hut, B.O.B's Hut and Crafting Station; nothing was ever scheduled for them.
- **Seasonal troops/spells** (`is_seasonal`) are items with `queue: 'none'` and `seasonal: true`: recognised, never in the lab queue, never in the meta catalog. clash-of-clans-data didn't have them, so their army-code IDs were "unknown" before and still don't count. Behaviour is unchanged.
- **Super troops** are not items (as before). They're `GameData.superTroops` (dataId → base id, own housing space), and the base troop's `superHousingSpace` is the super's. `buildCatalog` reads them from the data; `config/super-troops.yaml` adds to or replaces them.
- **Sieges** = troops with `production_building: "Workshop"`.
- **Equipment keeps only the Blacksmith requirement; heroes only the Hero Hall requirement** (ClashKing also gives `required_townhall`). *Why:* that's the existing model (SPEC §5/§6.9). Both buildings are TH-gated, so the extra field would be redundant.
- **TH weapons come from clash-of-clans-data's `town-hall.json`**, the one use beyond images and backup. *Why:* ClashKing has no weapon levels at all, and dropping them would remove the SPEC §6.3 TH-weapon rule for TH17 players (Inferno Artillery 1–5).
- **Images** are matched to ClashKing items by item id, then dataId. *Why:* by dataId alone, the Monolith Arrow / Electro Fangs swap would show the wrong icon.
- **Two dataId conflicts, both settled in ClashKing's favour.** Each piece of equipment belongs to one hero. In the local Legend army codes, `e16` appears only with hero 1 (Archer Queen) 610 times and `e59` only with hero 7 (Dragon Duke) 1,132 times. So 90000016 = Monolith Arrow (AQ) and 90000059 = Electro Fangs (DD), as ClashKing says; clash-of-clans-data has them swapped. The export's helpers (93000002 at level 2, 93000003 at level 1 with no levels in ClashKing) fit ClashKing's Alchemist = 93000002, Prospector = 93000003. The old `id-overrides.yaml` entry (93000003 → alchemist) would now collide, which is why it had to go.

## Overrides (`config/*.yaml`, shipped empty)
- **An entry wins over the data**: merges (an entry replaces the data's recipe and may give `level`), super troops (add/replace), ids (`<dataId>: <item id>`, with a warning when it differs from the data). A dataId used by two items is a warning too.
- **The backup can't rely on empty files**, because clash-of-clans-data lacks merges, super-troop dataIds and the Alchemist's dataId. So `src/data/cocDataBackup.ts` holds those tables, frozen at 0.19.1, and the override files still win. *Why:* without them, a fallback would ask for merged-away buildings.

## Backup: clash-of-clans-data
- **Used only when there is no usable ClashKing copy**: `data/clashking/static_data.json` missing or unreadable, or it fails to normalize. The site and scripts then show "Game data: using the clash-of-clans-data backup because …" (Plan tab warning, `npm run sync`, every `npm run dev`).
- **A new ClashKing file that fails validation never triggers the backup:** the previous pinned copy stays (known-good rollback). The backup is for "no copy at all".
- **Browser:** clash-of-clans-data's JSON is in a separate lazy chunk (`cocBackupBrowser`), fetched only on fallback; `loadGameDataBrowser()` became async. The main bundle went from 1,017 kB (153 kB gzip) to 772 kB (116 kB gzip).
- The clash-of-clans-data package is still updated within its major by sync and the Action (images for new items, backup). With ClashKing active, its update makes no game-data diff, so the Action commits it with "0 changes".

## Validation of a new ClashKing file (before it replaces the pinned one)
- It must parse and trim (all nine sections present), normalize, pass the level checks (contiguous, non-negative), and contain Laboratory, Archer Queen, Cannon, Barbarian and Builder's Hut. The max TH must not drop, and the base-item count must not fall by more than 10 % against the pinned copy. *Why:* those are the cheap signals of a truncated, renamed or restructured file; a normal release only adds.

## Sync, Action, refresh
- **`syncAll`** runs clash-of-clans-data (existing `syncData`, restore on failure) → ClashKing (`syncClashKing`) → validation of the active data → snapshot/diff → cross-check. The exit code is non-zero for any failure, a restore, or a kept-previous ClashKing copy.
- **`runDataUpdate`** keeps its clash-of-clans-data-only path when no ClashKing deps are given; the existing fake-registry tests cover that path unchanged. With ClashKing deps it adds that stage. The failing step names start with "ClashKing …", and the issue title is `Data update failed: clashking-v…` (or `… ClashKing check`). The commit message names only what changed, e.g. `data: ClashKing v0.1.20 → v0.1.21 (12 changes)`. The commit adds `data/clashking/`.
- **The predev refresh** also asks GitHub for the latest ClashKing commit (24 h cadence, like npm) and runs `npm run sync` when it differs from the pin. A recorded ClashKing failure warns on every start and isn't retried automatically, and running on the backup warns on every start. All of it is optional in `RefreshDeps`, so the existing refresh tests are unchanged. The "offline" wiring test now expects the two extra lines (backup warning for its empty temp root, ClashKing check skipped).
- **Cross-check:** compares cost (incl. resource/ore), time and TH requirement on every shared item and level, and lists items and levels only one side has plus which has the higher max TH. It prints at most 60 difference lines, but the counts always cover everything. It never fails a sync. TH weapons are skipped (same source on both sides).

## Tests
- **Tests that edited clash-of-clans-data JSON** (`modifiedData`, `rawItem`, `addTownHallLevel`, `addBuildingLevel`) now edit ClashKing raw data. The rule assertions are unchanged.
- **Tests that hard-coded TH18 as the max TH** use `MAX_TH = data.maxTH`. Where a test needed an item with a level at the new max TH, it now uses one that has it: Clan Castle instead of Army Camp, Multi-Archer instead of Super Wizard Tower, and Inferno Tower instead of X-Bow for supercharges, because X-Bow got a TH19 level and lost its supercharge in ClashKing. The test of what a future TH does now adds TH20.
- **The "merge the recipes don't know" tests** run on the clash-of-clans-data backup with a built-in recipe dropped. That's the only way it can happen now (ClashKing carries every merge).
- **Real data differences in expectations:** the fixture's first builders are now Laboratory → **Squad Barracks** (new, Tier 0) → Town Hall; Wall 17→18 costs 6M (was 7M); Hero Hall caps are checked on the backup's table; two squads have no housing space in ClashKing; ClashKing-only items have no clash-of-clans-data image.
- **New `tests/clashking.test.ts` (49 tests)** on a hand-made trimmed fixture (`tests/fixtures/clashking-mini.json`). It covers: trimming; each level semantic; counts from unlocks incl. a TH-level merge; merges with exact levels and counts after merges; super troops; seasonal units; supercharges; guardians; helpers; crafted modules; each override winning; the backup (missing / broken / good copy); the sync stage (up to date, update with pin + sha256, bad JSON, failed validation, GitHub down, download down, no copy, offline); the release lookup (tag, main fallback, error); the fetch child process (no secrets in errors); the Action with ClashKing; the refresh; and the cross-check.

# Decisions (TH upgrade requirements, hero order lock)

## TH upgrade requirements in the TH gate (SPEC §3.1, §5, §6.3)
- **Read generically from the Town Hall levels:** every array on a TH level whose entries have a numeric `_id` naming a building or trap and a numeric `level` is a requirement for upgrading **to** that TH. `unlocks` is skipped (quantities, no level); `variants` doesn't match (troop requirements, no building `_id` + level). Today that's only TH17's `merge_requirement` (Eagle Artillery 7). *Why:* the task said generic, and ClashKing may name the field differently for a future TH; a test adds a `building_requirement` field on TH19 and the gate picks it up.
- **Stored as `GameData.thRequirements`** (TH → `{ id, dataId, level, qty }`); several entries for the same building raise `qty`. A requirement naming a building not in the data is dropped with a warning. The clash-of-clans-data backup has none (it doesn't list them), and I didn't add a built-in backup table: that would be hard-coding the one building the task said not to.
- **The TH-level `merge_requirement` still also reduces the Eagle Artillery count from TH17** (the absorption, unchanged). The requirement only matters before the upgrade, the count only after.
- **Which copies:** the `qty` highest copies not already used by a merge, highest first. Only those are tier-1 gate items; other copies stay in their normal tier. *Why:* one copy at the level is what the game asks for; pushing every copy would spend builders on nothing.
- **Ranking:** `gate` group with the target TH and recipe index `merges.length + i`, so requirement items come after the merge-source items for the same TH and are ordered by level like them. Reason: `TH gate: TH17 requires Eagle Artillery 7`.
- **An upgrade in progress doesn't meet it** (the TH waits until the level is reached). *Why:* the game checks the finished level; the scheduler re-asks when that builder frees up.
- **No deadlock:** like a merge (DECISIONS #1), a requirement holds the gate only if there are enough copies and the level is reachable at the current TH. Otherwise it's ignored for the gate, and the TH is offered.
- **Lookahead (TH upgrading):** the target is the TH **after** the one being reached (upgrading 15 → 16 works on TH17's requirement). *Why:* the requirement of the TH being reached was already passed when that upgrade started; "TH+1" for the merge lookahead means "what the next gate will ask", which for requirements is the next upgrade's. Upgrades only go as far as the current TH allows (EA 5 → 6 at TH15). Lookahead items never hold the gate (the TH is busy anyway).
- **Rush only:** at max TH there's no next TH, so nothing to require.
- **When met, the Town Hall's reason adds `, TH17 requirements met: Eagle Artillery 7`.** Without requirements for the next TH, the TH reason is unchanged, so plans for other THs (your TH18 export) are byte-identical.
- **Tests adapted (real effect of the rule):** the TH16 fixture's Eagle Artillery is at 6, so its third free builder takes Eagle Artillery 7 (TH gate) instead of the Town Hall. The Gold Pass timing test now times that job. `makeExport(16, 15)` has EA at 6, so the "Lab never holds the gate" test sets EA 7. The merge-lookahead test now also expects the EA lookahead.

## Hero order: the Archer Queen locked at position 1 (SPEC §13 Step 1, §12)
- **`LOCKED_HERO = 'archer-queen'`** in `src/state/settings.ts`. `heroOrder()` (used for YAML and localStorage) always puts her first and keeps the rest of the saved order. `moveHero()` never moves her, and a move to her slot or above lands just below her. *Why:* normalizing in the model means every path (UI, YAML, old saved settings) gets the same result, and the UI can't produce an order the model would reject.
- **UI:** her row has class `locked` (greyed via opacity), `aria-disabled`, a tooltip, an empty grip, no ↑/↓, and isn't draggable or a drop target. #2's ↑ is disabled. The label reads "· Tier 0 · locked".
- **Drag fix found by the tests:** a drag dropped on the locked row (or outside the list) left the drag source set, so the next drop reused it. `dragend` now clears it, and a drop with no valid source is ignored.
- The engine is unchanged: the Queen was already Tier 0 regardless of slot, and her slot never affected the Heroes tier. The old "Queen keeps Tier 0 even when last" test can't set her last any more; it now puts the Barbarian King right after her.

# Decisions (helper assignment, SPEC §10.1)
- **The export's repeat setting wins while its upgrade runs.** A helper with `helper_recurrent` on an upgrade still running at the work hour works on it, even when the planner would pick another job. *Why:* that's what the game does, and the timeline should match the game.
- **Only the export's running upgrades carry the repeat flag.** Before, a job the planner started later on the same instance inherited `helper_recurrent` (e.g. the King's next level). Now planner jobs never do. *Why:* the task says the planner picks once that upgrade finishes; whether the game keeps the setting on the next level of the same item isn't in the export.
- **A repeat target that isn't running at the work hour counts as "nothing set to repeat"** (the planner picks, no suggestion). This also covers a repeat flag on an idle item.
- **Planner's pick:** lowest tier first, with the Town Hall ranked above everything (key −1), then longest remaining, then slot id. *Why:* the task says "Town Hall first in rush mode". Taken literally, "highest priority tier" would put a Tier 0 job (e.g. Squad Barracks under construction, Laboratory) ahead of the TH. A running TH upgrade only exists in rush mode, so ranking it first needs no mode check.
- **Tiers of jobs running at the export** come from `runningJobTier()`, a category mapping (they have no candidate). Laboratory, Archer Queen and level 0 → 1 (under construction) are Tier 0; TH → TH path; weapon → weapon; army → offense; hero → heroes; storage/collector → resources; defense/trap/merged/wall → defenses; else temporary. Unknown ids get 99. *Why:* re-running the full candidate generator for each running job would be heavy and circular (the job is busy). The approximation is that a running merge-source or requirement upgrade counts as a defense, not a gate item. Jobs the planner starts use their exact candidate tier.
- **Lab Assistant:** the current research. There's one Laboratory slot (Goblin research excluded), so a repeat on the running research always matches and never makes a suggestion.
- **Suggestion:** checked once per helper, at the first work hour from now (t ≥ 0) where the repeat setting decides the target. If the planner's pick at that hour differs, the plan shows "Apprentice: repeating on X. Suggest switching to Y N after X finishes (or now)." Hours between the export and now are past, so they don't suggest. *Why:* that hour is when the player's setting and the planner first disagree for real. Later hours compare against the same repeat job, and the line would only repeat itself.
- **Shown** under the helper line in the Plan tab summary (💡) and as `Suggestion:` in `npm run plan`. The timeline isn't changed by it.
- **Settings help text** for "Simulate helpers" now describes the new rule.
- **Effect on your export:** the Apprentice repeats on Grand Warden. The 24 h plan only gains the suggestion line (Town Hall 19). Over 14 days, once Grand Warden finishes, the Apprentice goes to Town Hall 19 (−3d instead of −2d 8h, done 16 h sooner) instead of the longest job. The fixture plan is unchanged (no helpers).

# Decisions (unknown level-1 equipment = likely unreleased)
- **Rule:** an export entry in `equipment` whose dataId isn't in the game data, at `lvl` 1 and with no timer, is "likely unreleased" (`isLikelyUnreleased()` in `src/state/parseExport.ts`). It's dropped from the Plan-tab warnings and listed once as "Unrecognized items (likely unreleased): equipment 90000062 (level 1), …". *Why:* the game ships new equipment to every account at level 1 before it's released (your 90000062/63), so a warning on every load is noise. Above level 1 it has been used, so the data is really missing something: still a warning.
- **Equipment only:** unknown buildings, traps, units, spells, heroes, pets, helpers and modules warn at any level. The fixture's planted unknown helper (level 1) still warns.
- **An upgrading level-1 entry still warns:** a running upgrade on an unknown id occupies a slot (SPEC "Unknown ids"), which the player should know about.
- **Where it shows:** the Import tab, under the account status (shown whenever an account is loaded, so "once" = one note listing them all, not one warning each), and an `== Info ==` section in `npm run plan` ahead of the warnings. The import message's "N unknown id(s) ignored" counts only the ones that still warn. `Unresolved` now carries the entry's `level`.
- **Your export:** the two warnings for 90000062 and 90000063 are gone; the CLI shows "Unrecognized items (likely unreleased): equipment 90000062 (level 1), equipment 90000063 (level 1)". 90000061 (level 1) is known to ClashKing, so it isn't listed.

# Decisions (Review 2 fixes, REVIEW-2.md)

## Tests vs today's data (#1)
- **Rule tests compute their expectations from the data.** Max TH = the highest Town Hall level in the raw file; the Cannon image = the highest level clash-of-clans-data has an image for (it can lag ClashKing); the book threshold, hero caps and "first book-ready level" come from the data; max-TH tier tests use an export two THs of levels behind, so every tier has work in any release. *Why:* a new ClashKing level or TH must never fail the daily Action or Pages by itself.
- **Facts about today's data live in `tests/current-data.test.ts`** (max TH 19, 8-day threshold, AQ caps 110/115, Cannon top 21 + its image). `npm test` runs them; `npm run test:ci` (the data-update Action and Pages) leaves them out. *Why:* they're a record of the pinned data, not rules; when a data update changes one, the number is updated by hand without blocking the deploy.
- **`npm run test:mutated`** writes a mutated copy of the pinned data to a temp dir (new Town Hall level; new top levels for Cannon, Laboratory, Gold Storage, Army Camp, Hero Hall, Archer Tower at today's max TH, Archer Queen (longer than any hero level, needs the new Hero Hall level), Barbarian, L.A.S.S.I, Barbarian Puppet) and runs `test:ci` with `CK_DATA_DIR` pointing at it. It's a Pages step. An item missing from the data is skipped, so a ClashKing rename can't break the check itself. The browser-loader parity test is skipped there (the browser glob always reads the committed file).
- `CK_DATA_DIR` is read only by the Node loader (`loadNode.ts`); nothing else uses it.

## Counted buildings without levels (#2, ambiguity 1)
- **Never planned, never in the TH gate.** `plannedBuildings` only creates copies of items on the builder queue with a first level; the gate only counts planned items with a first level. *Why:* the planner can't build or time them, so holding the gate deadlocked the Town Hall (0 TH jobs in 365 days after a TH20 release).
- **Informational Tier 0 row** "Build Guardian Shrine (no level data yet)" (`×N` when several are missing) in the Plan tab's "Now" card (greyed, italic) and `npm run plan` ("T0 (info): …"). Only for items that would otherwise be new buildings (same filter as planned copies) and only while not owned; an export entry, even level 0 under construction, counts as built.

## Running jobs on levelless items (#3)
- **They hold their slot**, mapped by category: troop/spell/siege → lab, pet → pet house, equipment/helper → none, everything else → builder (incl. heroes, guardians, modules, `other` buildings). Shown as "<name> (no level data)". When the timer runs out the instance's level is set to the target. Their helper tier comes from `runningJobTier` like any running job.

## Refresh vs committed files (#4, ambiguity 5)
- **Discard only what the refresh generated and the incoming commits replace.** Before `git pull --ff-only`, `git fetch`, then for files that are both locally changed (`git status --porcelain`, incl. untracked) and touched by `HEAD...@{u}`: discard `data/clashking/*`, `public/meta.json`, `public/data-changes.json`; `package.json` / `package-lock.json` only when they differ from HEAD solely in the clash-of-clans-data dependency / lockfile entries. Discard = `git checkout HEAD -- <files>` (untracked: delete). One log line names them.
- **Everything else is a blocker, never touched:** the warning names the files and both fixes (`git stash` … `git stash pop`, or `git checkout -- <files>`). *Why:* the owner's own edits must never be lost to an automatic refresh.
- "Changed only by sync" for package files is a structural JSON comparison with the clash-of-clans-data entries removed, not a guess from the diff text.
- Tested end to end on throwaway repos in the temp dir with a local bare origin (no network).

## Data identity (#5, ambiguity 3)
- **`version` = `clashking-<tag>+<sha7>`** (main: `clashking-main-<sha7>` as before). It names snapshots, diffs, `data-changes.json`, banner dismissal, failure records and issue titles. **The UI shows only the tag** (`versionLabel`: "ClashKing v0.1.20"; the banner now says "clash-of-clans-data 0.19.1 → ClashKing v0.1.20" instead of always prefixing clash-of-clans-data).
- **Old pins** (version = tag only) get the identity from `pin.tag` + `pin.commit` (`pinVersion`), in both loaders and in sync. The committed `pin.json` and `public/data-changes.json` were updated to `clashking-v0.1.20+04babd0` so the banner keeps matching. Side effect: a browser that dismissed the v0.1.20 banner sees it once more (the dismissal is keyed by version).
- **Commit messages show tags only**, and the commits too when the tag didn't change ("ClashKing v1.0.0+aaaaaaa → v1.0.0+fffffff").
- The refresh's log lines use the label plus the commit ("ClashKing v1.0.1 (bbbbbbb) is out (pinned: aaaaaaa)").

## Line endings (#6)
- `.gitattributes`: `* text=auto eol=lf` (binary files are auto-detected). Workflow-file tests read through `tests/workflow.ts`, which normalizes `\r\n`. A test feeds a CRLF copy and expects the same result.

## Free levels (#7, ambiguity 11)
- **Error on any level > 1 of an item with queue ≠ none that costs 0 and takes 0 s; equipment: all three ores 0** (`checkFreeLevels`, run by `validateClashKing`). Level 1 is free by design; seasonal units have queue none; walls cost something; today's data has none. *Why:* it's exactly what a new top level looks like when ClashKing forgets to fill in the row before it.
- Not run on the clash-of-clans-data backup (frozen, not shifted).

## Issue titles and tags (#8, #9, ambiguity 4)
- **Title:** the ClashKing version whenever it changed (any failing step), both versions when both changed ("clashking-v…, clash-of-clans-data 0.20.0"), else the clash-of-clans-data version; "ClashKing check" / "npm check" when a version was never known.
- **Tags:** `^[A-Za-z0-9._-]+$`, else the release is versioned `clashking-main-<sha7>` (of the release's commit, which is still what's downloaded), with a warning, and `pin.tag` is left out (`pin.ref` keeps the raw tag; it's JSON). Snapshot file names are slugged (`[^A-Za-z0-9._+-]` → `-`).
- **The issue shell block is one script** (`.github/scripts/upsert-issue.sh`) for both workflows; the title goes to `jq --arg t` (gh's `--jq` takes no arguments, so `gh … --json | jq`). The search query has quotes stripped; the exact match is in jq.

## Everything totals (#10, ambiguity 6)
- **Total cost = builder tiers + Laboratory + Pet House + walls**; the count excludes "Not scheduled" too. "Not scheduled (N, not in the total)" gets its own line in the totals card. *Why:* SPEC §11 describes the tab as what's left at the current TH; the next TH and book-ready levels are the player's call. On your export the total drops by 191M elixir, 27M gold and 9.9M DE (31 upgrades).

## Hero drag (#11)
- `dragover` only accepts drags that started in the list (`dragFrom ≥ 0`), and `drop` ignores anything else. The `text/plain` payload is still set (some browsers need it to start a drag) but never read.

## Small items (#12)
- **Wall line from now:** `wallDump(data, account, nowTH)`. The wall counts themselves come from the export (walls aren't simulated).
- **Helper text:** "−8h per 23h cycle".
- **Helper cycle waits (ambiguity 7):** at a work hour with no eligible job (none on its queue, or only Goblin jobs) the helper waits; it's assigned to the next job that runs and its next hour is 23 h after that. Before now nothing starts, so a helper that found nothing between the export and now is assigned at now. The event loop doesn't advance on a waiting helper's time (no busy loop). The "next work hour" in the summary line is still the regular schedule (it's a hint).
- **Several `helper_recurrent` jobs:** the planner's priority picks among them (deterministic). A flag on a Goblin job is ignored like any Goblin job.
- **Override errors:** `OverrideError` (YAML error, or a merges.yaml recipe naming an unknown item / a different dataId). The loaders retry **without the override files** and put "Override file error: config/<file>: …" first in the warnings. *Why:* the overrides ship empty, so loading without them is the safe default and the message points at the real culprit; falling back to the backup blamed ClashKing and, since the backup re-parses the same YAML, could fail outright. The daily Action fails on it ("validation: override files (config/)") so a broken override never deploys silently. Unknown super-troop bases were already skipped silently and still are.
- **Resource buildings:** not a storage/collector → `other` (not planned). The warning appears only once such a building has levels, so today's levelless Sour Elixir Cauldron adds no Plan-tab noise. The clash-of-clans-data backup keeps its old mapping (frozen data).
- **Removed / shared:** `CK_DATA_FILE`, `CK_PIN_FILE`, `cocDataVersion`, `readIdOverrides`, the `req` alias; `STORAGES`/`COLLECTORS` exported once from `normalize.ts`; `fence`/`tail`/`setOutputs` in `scripts/lib/ghText.ts`.
- **Not done:** splitting `tiers.ts` / `clashking.ts` / `scheduler.ts` (as instructed).

## CI hardening (#13)
- Checkout `persist-credentials: false` in all three workflows. Pushes (data commit, meta commit, meta-data force push, and their `git pull --rebase`) go through `.github/scripts/git-auth.sh`, which passes the token as a one-command `http.extraheader` (masked), so it's never in `.git/config`. The meta restore step fetches `meta-data` anonymously (public repo).
- `npm ci --ignore-scripts` in data-update and meta (esbuild and sharp ship prebuilt binaries as optional packages). The sync's `npm install clash-of-clans-data@x` also uses `--ignore-scripts` (it's a data-only package).
- Pages: workflow-level `contents: read`; `pages: write` + `id-token: write` only on the deploy job. Actions stay pinned to major tags (all `actions/*`; low risk, as the review says).

## Test tag (#14)
- `#2PP0JQ8` → `#ABC123X` (contains `A`, `B`, `X`: not valid tag characters, still matches the redaction pattern). History left as is.

## Ambiguity decisions
- **2 (supercharge level):** offered only when the base is at its max for the TH **and** at the level that carries ClashKing's supercharge block (`superchargeBaseLevel`). Today only Monolith differs (block on level 5 / TH18, supercharge TH17): a TH17 Monolith 4 is no longer offered it. The backup has no block level and keeps the old rule.
- **8 (guardians):** stay out of planned builds and the TH gate. *Why:* their count is our own derivation (first level's TH), not a Town Hall unlock, and ClashKing lists a guardian clash-of-clans-data doesn't (Logger), so planning one could suggest something the game doesn't offer and hold the gate. Owned guardians are still upgraded (tier 6).
- **9 (wall line):** from now (above).
- **10 (no release has the file):** with a release pinned, keep it and fail with "the latest ClashKing release "vX" has no static/static_data.json; keeping the release pin …" (issue "Data update failed: clashking-vX", stable across days). With no release at all the title is "clashking-release". Nothing pinned yet → follow main as before (bootstrap). A GitHub error on the release lookup now throws instead of silently following main. Locally, the failure is recorded (refresh warns each start, doesn't re-sync until a newer main commit / release).
