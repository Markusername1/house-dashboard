# House dashboard — working brief

Read this before changing anything. It covers what the project is, what must not break,
and the design direction.

If you rename this file to `CLAUDE.md` it loads automatically in every Claude Code session
in this folder. Otherwise reference it explicitly: `read BRIEF.md, then …`.

---

## 1. What this is

A single page answering one question for one household in Canberra: *what do I need to know
about today?* It is checked at a URL a few times a day, mostly on a phone, sometimes on a laptop.
It has an audience of one. There is no onboarding, no settings screen, no login, no city picker.
Everything is hardcoded to this house.

Treat that as a design freedom, not a limitation. Nothing here has to be general.

## 2. Architecture

```
fetch.js  --(GitHub Actions cron, every 30min)-->  data/dashboard.json  --(fetch)-->  index.html
```

Static hosting on GitHub Pages. No server, no database, no build step, no bundler, no npm
dependencies. `fetch.js` runs on Node 20+ using native `fetch` only.

| File | Role |
|---|---|
| `config.json` | Suburb, split suburb, lat/long, timezone, house name, incident radius |
| `fetch.js` | Polls each source independently, writes `data/dashboard.json` |
| `data/dashboard.json` | The only thing the page reads |
| `index.html` | Entire frontend: markup, CSS, JS in one file |
| `.github/workflows/update.yml` | The cron |
| `tools/` | Development checks only. Never loaded by the page. |

### The data contract

Every source is wrapped so one failure can't blank the page:

```json
{
  "generatedAt": "ISO",
  "houseName": "Home",
  "sections": {
    "bins":     { "ok": true, "fetchedAt": "ISO", "data": { ... } },
    "weather":  { "ok": false, "fetchedAt": "ISO", "error": "...", "data": { ...last good... } },
    "air":      { "ok": true, "fetchedAt": "ISO", "data": { ... } },
    "holidays": { "ok": true, "fetchedAt": "ISO", "data": { ... } },
    "fire":     { "ok": true, "fetchedAt": "ISO", "data": null }
  }
}
```

On failure the previous value is carried forward with its **original** `fetchedAt`, so the age
shown on screen is the age of the data, not the age of the attempt. Preserve this behaviour.
It is also why the workflow commits `data/dashboard.json` back to the repo rather than
regenerating it from nothing each run — the previous file *is* the carry-forward store.

`"data": null` with `"ok": true` means "nothing to report" and renders no card at all.
Only the `fire` section uses it.

---

## 3. Sources

All five were confirmed against live responses. `node fetch.js --inspect` re-checks them at
any time and writes nothing.

| Section | Endpoint |
|---|---|
| bins | `data.act.gov.au/resource/jzzy-44un.json` (Socrata) |
| weather | `api.open-meteo.com/v1/forecast` |
| air | `air-quality-api.open-meteo.com/v1/air-quality` |
| holidays | `date.nager.at/api/v3/PublicHolidays/{year}/AU`, filtered to national + `AU-ACT` |
| fire | `esa.act.gov.au/feeds/firedangerrating.xml` and `/feeds/currentincidents.xml` |

### Bin columns — confirmed, not guessed

The real Socrata field names are:

```
suburb  split_suburb  collection_week  greenwaste_collection_week  greenwaste_type
garbage_collection_day    garbage_collection_frequency    garbage_pickup_date
recycling_collection_day  recycling_collection_frequency  recycling_pickup_date
greenwaste_collection_day greenwaste_collection_frequency next_greenwaste_date
```

Dates are `DD/MM/YYYY`. `fetch.js` reads these exact keys first and keeps a regex fallback in
`pick()` in case the portal renames one.

**The dataset publishes real forward pickup dates.** Nothing is derived from a weekday offset,
which is why there is no bin-day-offset knob in `config.json` — the off-by-one this project was
most likely to have simply has nowhere to live. If the dataset ever falls behind today,
`bins()` rolls the date forward on the published frequency and flags `projected: true`, which
the page states on screen rather than hiding.

### Split suburbs — real, and a hard error

119 rows cover 114 suburbs. Three are split and need `splitSuburb` set in `config.json`:

| Suburb | Values |
|---|---|
| CHARNWOOD | `Tuesday`, `Wednesday`, `Thursday`, `Friday` |
| DUNLOP | `North`, `South` |
| LYNEHAM | `North`, `South` |

If a suburb matches more than one row and `splitSuburb` is unset, `bins()` throws and names the
options. Guessing would put the wrong bin on the kerb, which is the worst thing this page could
do, so it refuses rather than picking. `--inspect` prints every matching row.

### Fire

`fire()` returns `null` — and the page renders no card — unless there is a total fire ban today
or tomorrow, a danger rating above Moderate, or an ESA incident within `incidentRadiusKm`.
A fire *failure* with no prior value still renders, saying it could not be checked; silence is
reserved for "checked, nothing active".

---

## 4. Design direction

**Minimalist but futuristic**, meaning precision instrumentation: aerospace telemetry, a
well-designed measuring device, Swiss data typography. The future-feeling comes from
**information presented with unusual exactness and confidence**, not from decoration.

Lean into: tabular numerics (`font-variant-numeric: tabular-nums` everywhere figures appear,
so nothing jitters between refreshes); hairlines and precise alignment; layered translucency
over the live background rather than flat panels; mechanical motion (120–200ms, sharply eased);
and **data provenance made visible** — every region carries its own age, and that is a feature,
not fine print.

### What to avoid

"Futuristic minimalist" has an extremely strong default that everything drifts toward. Do not
produce it. Concretely, avoid:

- Near-black background with a single acid-green, cyan, or magenta accent
- Neon glow, `box-shadow` halos, glowing borders, pulsing dots
- Glassmorphism applied uniformly as a texture rather than for a purpose
- Purple-to-cyan gradients anywhere
- Wide-tracked uppercase geometric display faces (Orbitron, Exo, Michroma and relatives)
- Scanlines, grid overlays, corner brackets, reticles, fake HUD chrome
- Decorative monospace on things that are not data
- Numbered markers (01 / 02 / 03) on content that is not a sequence

If a choice would look at home in a generic "AI dashboard" dribbble shot, it is the wrong choice.

### The signature: the background is the actual sky

The gradient is interpolated from the sun's real position using today's actual sunrise and
sunset out of the weather data, so the page looks materially different at 6am, midday and 9pm.
The stops live in `keyframes()` inside the `==SKY-START==` block in `index.html`, anchored to
sunrise/sunset in minutes rather than to clock hours, so it tracks the season.

Do not remove this. Build around it. The page should feel like a window with an instrument
overlaid on it.

**How contrast is held.** Text is light, so instead of a fixed scrim, `panelAlpha()` measures the
brightest current sky stop and solves for the panel opacity that keeps the composited background
at or below `PANEL_MAX_L`. At night the panel drops to fully transparent and the real sky shows
through; at midday it rises to about 0.71. Full-vividness sky is always visible in the margins
around the panel. `tools/check.mjs` asserts the resulting floor at every minute of the day
against midsummer, midwinter and equinox sun times.

That block is deliberately pure — no DOM — so the checker can lift it straight out of the page
and exercise it. Keep it that way.

### The state-dependent hero

The bins are the only thing on this page a person actually forgets, so they get the loudest
treatment. Three states, recomputed **in the browser** from the absolute dates rather than read
from the file, so the page stays right across midnight even if the collector has stopped:

| State | Treatment |
|---|---|
| Collection tomorrow | "Bins out tonight" + full lid-colour blocks naming each bin |
| Collection today | "Collection today" + the same blocks |
| Anything else | One quiet line, colour reduced to 9px markers |

Real red / yellow / green lids are **the only saturated colour on the page**. Preserve this
asymmetry — it is the reason the page is useful rather than decorative. The visual treatment is
open; the behaviour is not.

### Typography

IBM Plex Sans with IBM Plex Mono — a technical superfamily with real tabular figures, chosen
against the brief rather than as a default, and specifically not a wide-tracked geometric
display face. Weights 400/500/600 sans, 400/500 mono, and nothing else is loaded. Mono is
restricted to actual data: times, dates, ages, distances, units. Never on prose.

---

## 5. Hard constraints

These survive any redesign:

1. **One HTML file.** All CSS and JS inline in `index.html`. No frameworks, no build step,
   no bundler, no npm packages on the frontend.
2. **No browser storage.** No `localStorage`, no `sessionStorage`, no cookies. State lives in
   `data/dashboard.json` and in memory.
3. **Failure is a visible state, never a blank.** A stale region renders its last good value,
   visually marked, with its true age. A failed region with no prior value says what happened.
   Never a spinner that never resolves, and one dead source never empties the page.
4. **Contrast holds at every hour.** Body text stays at or above 4.5:1 against the composited
   background — enforced by `panelAlpha()`, verified by `tools/check.mjs`.
5. **Accessible floor.** Responsive to 360px. Visible keyboard focus. `prefers-reduced-motion`
   fully respected — under that query, no transitions and no animations, including the sky.
6. **Timezone correctness.** Actions runs in UTC; the house is in `Australia/Sydney`. All date
   arithmetic and display goes through `Intl` with an explicit timezone, in both files.
7. **No fabricated data.** If a value is missing, show that it is missing. Never fill a gap with
   a plausible placeholder. A projected bin date is labelled as projected.

## 6. Running it

```bash
node fetch.js --inspect     # raw upstream shapes, writes nothing
node fetch.js               # writes data/dashboard.json
node tools/check.mjs        # syntax, contrast floor, lid contrast, constraint regressions
node tools/render-test.mjs  # renders every failure and hero state against fixtures
npx serve .                 # then open the printed URL
```

Serve over HTTP. Opening `index.html` over `file://` blocks the fetch of `data/dashboard.json`;
the page detects this and says so rather than failing silently, but you still won't see real data.

`tools/` is development-only and is never loaded by the page — the one-file constraint is intact.

### Acceptance checks

`node tools/check.mjs && node tools/render-test.mjs` covers, automatically:

- [x] `fetch.js` and the inline script both parse
- [x] Renders against the seeded `data/dashboard.json`
- [x] Renders with `"ok": false, "data": null` forced on each section in turn
- [x] Renders with `fetchedAt` backdated 48 hours (stale path)
- [x] Bin hero in all three states
- [x] Contrast floor at every minute, against three sun-time extremes
- [x] Bin lid colours against their own label text
- [x] No browser storage, no external script, one style block, one script block

Still needs a human with a browser:

- [ ] Layout at 360px and 1440px
- [ ] `prefers-reduced-motion: reduce` disables all motion including the sky transition
- [ ] Nothing on screen resembles the avoid-list in section 4

## 7. Working style

Small commits, one concern each. When changing the design, work on the CSS in place rather than
rewriting `index.html` wholesale — the failure-state and timezone logic is the fiddly part and
is already correct. Run both tools before calling anything done. If you disagree with a
constraint above, say so before working around it.
