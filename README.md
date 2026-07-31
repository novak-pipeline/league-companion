# League Companion

A personal League of Legends companion app: a mid-lane timer **overlay** on top of the game, a **draft assistant** during champ select, and an **improvement tracker** built from your real match history.

Two windows, one process:

- **Overlay** — transparent, click-through, always-on-top. Cannon wave countdowns, back-window advice, scuttle and objective spawns, dragon/baron respawn timers.
- **Companion** — a dashboard for your second monitor. Live game reference, draft analysis, long-term trends, and data controls.

---

## Is this allowed?

Yes. Everything here uses Riot's own local, documented APIs:

- **Live Client Data API** (`https://127.0.0.1:2999/liveclientdata/allgamedata`) — live game state, served by the game itself while a match is running.
- **LCU API** — the desktop client's local API, used read-only to read champ select.
- **Data Dragon** — Riot's public static-data CDN.
- **Riot Games API** — official, key-authenticated, for your match history and meta sampling.

There is **no memory reading, no process injection, no packet capture, and no client automation**. Riot's [Vanguard FAQ for third-party applications](https://www.riotgames.com/en/DevRel/vanguard-faq) confirms overlays built on these APIs continue to work; what Vanguard blocks is memory reading and injection.

Two deliberate restraints:

- The app **never sends actions to the League client**. It can read champ select but will not auto-pick, auto-ban, or auto-accept — automating the client violates Riot's third-party policy.
- The app **never infers enemy summoner-spell cooldowns or scuttle respawns**. Riot does not expose them, and deriving them automatically is against policy. Those are user-started manual timers only.

If you ever distribute this, register it through the [Riot Developer Portal](https://developer.riotgames.com/policies/general) first. Personal use on your own machine is fine.

---

## Install

Grab an installer from the [Releases page](https://github.com/novak-pipeline/league-companion/releases/latest):

| Platform | File |
|---|---|
| Windows | [`League-Companion-Setup-0.1.0.exe`](https://github.com/novak-pipeline/league-companion/releases/download/v0.1.0/League-Companion-Setup-0.1.0.exe) |
| macOS (Apple Silicon) | [`League-Companion-0.1.0-arm64.dmg`](https://github.com/novak-pipeline/league-companion/releases/download/v0.1.0/League-Companion-0.1.0-arm64.dmg) |
| macOS (Intel) | [`League-Companion-0.1.0-x64.dmg`](https://github.com/novak-pipeline/league-companion/releases/download/v0.1.0/League-Companion-0.1.0-x64.dmg) |
| Linux | [`League-Companion-0.1.0.AppImage`](https://github.com/novak-pipeline/league-companion/releases/download/v0.1.0/League-Companion-0.1.0.AppImage) |

Builds are unsigned, so Windows SmartScreen shows "unknown publisher" on first run (More info → Run anyway) and macOS needs right-click → Open. Signing requires certificates this project does not have.

## Getting started (development)

```bash
npm install
npm run dev        # vite dev server + electron
```

Production build:

```bash
npm run build && npm start
```

Checks:

```bash
npm run typecheck   # three projects: renderer, node, preload
npm test            # 121 unit tests
npm run smoke       # boots the real app headless and asserts on it
```

Build installers locally:

```bash
npm run make:icon   # generates build/icon.png
npm run dist        # all targets for the current platform
npm run dist:win    # or :mac / :linux
```

## CI/CD

Two GitHub Actions workflows:

- **`ci.yml`** — on every push and PR: typecheck → unit tests → build → headless smoke test, then packages installers on Ubuntu, Windows, and macOS and uploads them as artifacts.
- **`release.yml`** — on a `v*` tag: re-runs the full check suite, then builds and publishes signed-nothing installers to a GitHub Release via electron-builder.

Cutting a release:

```bash
npm version minor && git push --follow-tags
```

The smoke test earns its place in CI: it boots the real Electron app under a virtual display and asserts the preload bridge loaded, both renderers mounted, and IPC round-trips. A preload module-format bug that broke *every window* passed both typecheck and the entire unit suite — only booting the app caught it.

### Try it without League running

Open the **Data** tab and hit **Toggle demo mode**. A synthetic game drives the whole app — overlay cues, timers, scoreboard, tracker — at 4× speed. This is the fastest way to see whether the overlay is positioned and readable before you queue up.

### Overlay requirements

Transparent overlays cannot draw over a game in **exclusive fullscreen**. Set League to **Borderless** or **Windowed** in its video settings.

### Overlay design: don't repeat the game

**The overlay is off by default.** Turn it on in the Data tab. An overlay you did not ask for, sitting on top of a ranked game, should be opt-in.

The governing rule: **if you can read it off League's own HUD, it does not belong on the overlay.** The game already draws dragon, baron, herald and grub timers on its scoreboard; redrawing them on top of the game costs attention and returns nothing. Those cue kinds ship muted, and the overlay shows only *derived* information:

| Cue | Why it earns screen space |
|---|---|
| **Cannon wave** | The game never tells you which wave has a cannon or when it lands |
| **Back window** | Derived from wave state — shove the cannon, then recall |
| **Jungler clear** | Arithmetic, not observation: when a standard clear puts them in position |
| **Roam window** | The *coincidence* of a shoveable cannon and something worth walking to |
| **Level spikes** | Only when they cross 6/11/16 before you — the case that gets missed |
| **CS pace** | How you compare to **your own** recent games at this exact minute |

Every muted kind can be switched back on per-kind in the Data tab; all of them are always visible in the Live tab.

The presentation is **focus + periphery**:

- **One prominent card** — the single most urgent thing. The only element meant to catch your eye.
- **A strip of pips** — everything else, glyph and time only, no labels. Glanceable, not readable.
- **Nothing at all** when there is nothing to act on.

Cues far enough out that there is nothing to do yet (`idle` severity) are dropped below `full` density, and the default horizon is a tight 45 seconds — a cue that appears two minutes early is a clock, not a prompt.

On what it deliberately will not do: it never claims to know where the enemy jungler *is*. Riot does not expose enemy positions and inferring them is outside their third-party policy. The jungle cues are clear-timing arithmetic, labelled as estimates.

Density is configurable in the Data tab:

| Density | Shows |
|---|---|
| `minimal` | One cue. Nothing else. |
| `normal` | One focus card plus a few pips (default). |
| `full` | Everything, including idle countdowns. |

Live cues are never dropped regardless of density — they are the only ones actionable this instant. Severity changes colour and weight only, never size or position, so the overlay never jitters as timers tick down.

---

## Getting real data in

The app ships with a curated champion table so it works offline on first run, but the interesting data comes from live sources. Set these up in the **Data** tab:

### 1. Riot API key (recommended)

Get one at [developer.riotgames.com](https://developer.riotgames.com). A free personal key works but **expires every 24 hours** and is rate limited (~20 req/s, 100 req/2 min). The app respects those limits automatically.

Enter your key, your platform (`na1`, `euw1`, `kr`, …), and your Riot ID as `Name#TAG`.

The key is stored in `settings.json` in the app's user-data directory and **never crosses the IPC boundary** — the UI only ever learns whether one is set.

### 2. Import your match history

**Import match history** pulls your recent ranked games via `match-v5`, including per-minute timelines. This gives exact CS@10, CS@15, CS differential vs. your lane opponent, and deaths before 10 minutes — and it backfills games played before you installed this.

This is strictly better than the live tracker, which can only sample games as they happen and cannot see the result.

### 3. Build the meta dataset

Riot publishes no aggregate win-rate endpoint. Sites like u.gg compute theirs by sampling matches at scale, and **Collect meta sample** does the same thing on a smaller budget: it seeds from the top of the ranked ladder, walks those players' recent solo-queue games, and accumulates per-champion, per-role outcomes into a patch-keyed tally.

It is **incremental and resumable**. Each run adds to the sample, deduped by match id. A dev key won't build a strong sample in one pass, so run it periodically — the Data tab always shows the honest `sampleSize` behind the numbers.

Win rates are withheld entirely below 30 games, so the UI never shows a percentage built on noise. Nothing is scraped from third-party sites.

---

## How the data layers work

Champion data is merged from three sources, each authoritative for what it actually knows:

| Layer | Owns | Updates |
|---|---|---|
| Curated table (`championData.ts`) | Judgement fields: `cc`, `engage`, `peel`, `waveclear`, `scaling` | Hand-edited |
| Data Dragon | Existence, Riot id, display name, melee/ranged, class tags | Every patch, automatically |
| Meta sample | Which roles a champion is *actually* played in, win/pick rates | Every collection run |

The practical effect: a champion released after the curated table was written still appears in the draft tool the day it ships, with derived defaults, and its real roles fill in as soon as the meta sample sees it.

Champion artwork comes from the same place — `cdn/<patch>/img/champion/<id>.png` on Data Dragon, the only remote host the app's CSP permits. Portraits render over a deterministic initials tile (same champion, same colour, every launch), so the UI looks intentional while art loads, on a cold cache, and fully offline.

Role derivation has two guards so a thin sample cannot rewrite reality: a champion must account for at least 0.5% of a role's games **and** have at least 5 games in it. Below that the curated roles stand. Win rates are withheld entirely under 30 games.

`npm run refresh-champions` reports drift between the curated table and the current patch — missing champions, factual mismatches, dead ids. It **does not** rewrite the table automatically, because the judgement fields cannot be derived and silently guessing them would quietly degrade the draft advice.

---

## What the draft assistant does and doesn't claim

It does **not** produce a win probability. A real one needs millions of scraped games, and anything computed from a static table would be a made-up number wearing a percent sign.

Instead it gives you:

- **A comp functionality score** (0–100) — does this team have the pieces a team needs? Damage balance, frontline, engage, peel, CC, waveclear.
- **Concrete flags** — "92% physical damage, one armour item blunts the whole comp", "no frontline", "no hard engage".
- **A read on the matchup** — who scales, who wins early, who out-engages.
- **Pick suggestions scored by marginal contribution** to your comp: what does this team still need?

Where real data exists, it is shown **alongside** the fit score, never blended into it:

- `meta` — sampled win rate for the current patch, with the game count.
- `personal` — your own record on that champion, from your imported history.

Keeping them separate matters: a champion you're on a hot streak with shouldn't masquerade as a good team-fit pick.

---

## Timer accuracy

Wave and objective timings live in one file: `src/core/patch.ts`. Riot moves these constantly, and the 2026 season moved them *structurally*:

- **Atakhan removed** (patch 26.1), along with Feats of Strength and Blood Roses.
- **Baron back to 20:00** (was 25:00 during the Atakhan era).
- **Void Grubs are a single set spawning at 8:00** — the second set went in 25.09, not 26.1, and the spawn moved from 6:00 in the same patch.
- **First wave at 0:30** (was 1:05), minions move faster, and the wave interval **steps down to 25s at 14:00 and 20s at 30:00**.

### On numbers this project could not verify

Riot does not publish everything, and community sources contradict each other — several widely-quoted "2026" guides still carry pre-season numbers. Rather than launder a guess into an authoritative-looking countdown, unverified values are declared in `DEFAULT_PATCH.caveats` and **shown to the user in the Data tab**, with what is uncertain about each.

Currently flagged: wave travel time (estimated from the move-speed change, not published), the cannon cadence transition (14:00 vs 15:00 — sources disagree), Herald's spawn, and the grub despawn.

Because wave travel time is both the least certain value and the one the cannon countdown depends on most, it is **user-calibratable**: a slider in the Data tab shifts arrival by ±10s, so you can watch one game and dial it in rather than trusting the shipped estimate.

That last one is not a constant-swap. Spawn times have to **accumulate** (`spawnTime += intervalAt(spawnTime)`) rather than multiply (`first + n × interval`), because once the game crosses a step boundary every subsequent wave is wrong under the old model. The cannon counter is likewise stateful — it tracks waves since the last cannon rather than a modulo on the index — because Riot continues counting across a cadence change instead of restarting on a fixed boundary.

**Verify `DEFAULT_PATCH` against current patch notes before trusting it in ranked.** The loaded config's label is shown in the UI for exactly that reason. Objectives carry an `enabled` flag so a removed one (like Atakhan) disappears entirely rather than counting down to something that cannot spawn.

The tests assert the engine's *rules* against whatever config is loaded, not hardcoded clock values — so a patch update changes one file, and a red test means the engine is actually wrong rather than merely out of date.

---

## Architecture

```
src/
├── core/            Pure domain logic — no Electron, no I/O, no clock reads
│   ├── types.ts       The contract. Cue stream, snapshots, draft, tracking
│   ├── patch.ts       All patch-dependent timing constants
│   ├── waves.ts       Minion wave + cannon + back-window scheduling
│   ├── objectives.ts  Dragon/herald/baron/grubs availability
│   ├── cues.ts        The cue engine: snapshot -> sorted cue list
│   ├── draft/         Champion registry, comp analysis, pick suggestions
│   └── tracking/      Per-game metrics, long-term trends
├── services/        I/O adapters
│   ├── liveClient.ts  Live Client Data API poller
│   ├── lcu.ts         Champ select reader
│   ├── normalize.ts   Riot payloads -> domain types
│   ├── mockGame.ts    Demo mode
│   └── data/          Data Dragon, Riot API, meta collector, disk cache
├── main/            Electron main: windows, IPC, persistence
├── preload/         Context-isolated bridge (two capabilities, nothing else)
├── shared/ipc.ts    The main <-> renderer contract
└── renderer/        React: overlay + companion dashboard
```

The load-bearing principle: **`core/` is pure and fully testable**. It never imports Electron, never touches the network, and never reads the clock — game time always arrives as an argument. Every timer, score, and suggestion is a deterministic function of its inputs, which is why the 113 tests can cover the interesting behaviour without mocking a game.

The main process owns all I/O and pushes a complete `CompanionState` to both windows; the renderers are pure views plus command dispatch.

---

## Known gaps

- **Scuttle respawn and enemy summoner cooldowns are manual.** Not a limitation to fix — auto-tracking them is against Riot's policy.
- **Meta sample starts empty.** It needs collection runs to become meaningful, and a dev key builds it slowly.
- **`DEFAULT_PATCH` needs manual verification each patch.** `refresh-champions` covers champion drift but not timing constants.
- **Role detection in the live client** depends on Riot reporting `position`, which it only does in role-assigned queues. The tracker declines to guess a lane opponent rather than reporting a wrong one.
- **Curated ratings are judgement calls.** They're internally consistent and defensible, not authoritative.
