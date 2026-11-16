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
- Equipment `cost`/`resource` = shiny ore. All three ores are kept in `ore`. *Why:* `LevelInfo` has a single cost; the forecast needs all three.
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
- **Pins:** the newest pin goes to the top. Pins are stored in the existing settings object (`lab.pinned`, `petHouse.pinned`, `blacksmith.pinned`) in localStorage, keyed by the item's file id. The same ranking feeds the scheduler (lab/pet order) and the ore forecast (top-N blacksmith picks), so pins change the Plan tab too.
- With no meta (missing file, 404 or empty `units`), the tab shows a "run `npm run meta`" note and the Step 1 order, without errors. The fallback reason now says "No meta data yet" instead of "Not seen in Legend I meta" when the file has 0 attacks.
- Footer: meta `generatedAt`, attack count and player count.
- **Not changed:** the meta score stays plain `usage` (SPEC §8.3), even though it rewards cheap filler troops (Archer: 88% usage at ~2.6 per army). See REPORT "Check".

## Mid-step request
- Added a test for SPEC §10.1 (new wording): a Goblin Builder and a Goblin Researcher job in the export each finish inside the 24h window, then those slots get no new job. They also don't appear in "Now" or the forecast, and they don't count as builders. Mutation-checked: removing the goblin guard in the scheduler fails the test. The engine already behaved this way, so no code change was needed.
