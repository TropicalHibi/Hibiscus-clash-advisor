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
