# drkr news

A dependency-free static clone of [hckrnews.com](https://hckrnews.com/) with
dark mode and customizable themes. No build step, no framework:
`index.html` + `css/style.css` + `js/app.js` (all vanilla), plus
`about.html`, fed by `crawl.py` — a standard-library Python crawler that
writes the feed as static JSON into `data/` (gitignored).

## Running / verifying

```sh
python3 crawl.py &                 # writes data/ — see "The crawler" below
python3 -m http.server 8347        # then open http://localhost:8347
```

A fresh `data/` starts cold, and for two days the page approximates what the
crawler hasn't seen — fine for checking layout, useless for checking feed
fidelity (do that against a crawler that has run for 48 h, or with the
side-by-side method under "The crawler").

Verify changes visually with headless Chromium; URL params make states
reproducible without interaction:

```sh
chromium --headless --disable-gpu --hide-scrollbars --window-size=1440,2000 \
  --virtual-time-budget=10000 --screenshot=out.png \
  'http://localhost:8347/?mode=dark&filter=20&settings=open'
```

Params: `?theme=<name>`, `?mode=auto|light|dark`, `?filter=10|20|half|homepage|all`,
`?settings=open`, `?redirects=on|off|open` (`open` expands the per-service list
without touching the switch). Mobile: add `--user-agent=<iPhone UA>` and
`--window-size=390,1600`.
Reference screenshots of the clone AND of the real hckrnews.com live in
`screenshots/` (`reference-original-*.png`).

## Deployment

Static files plus one long-running process: any static file server or host
serves the site, as long as `crawl.py` keeps writing its `data/`. Edit the
files and re-serve the directory; there's nothing to compile. A change to
`crawl.py` needs a crawler restart, which loses nothing — it reloads its state
from `data/` on start.

**Cache busting**: assets aren't content-hashed, so browsers (especially an
installed iOS PWA) cache CSS/JS aggressively. They're referenced as
`css/style.css?v=N` / `js/app.js?v=N` (and the favicon/manifest links as
`?v=N` too) — **bump `N` in BOTH `index.html` and `about.html` whenever you
change that asset**. That's the whole deploy step (the original does the same
thing with hashed filenames).

**Content-Security-Policy**: both pages ship a strict `default-src 'none'`
policy as a `<meta http-equiv>` (no backend, so it lives in the page). It's
load-bearing and has two coupling gotchas:

- **The inline FOUC theme script is pinned by SHA-256 hash** (`script-src
  'sha256-…'`) — a *different* hash per page, since the two inline blocks
  differ. **Edit that inline script and you MUST recompute its hash**, or the
  browser silently blocks the boot script and every load flashes the wrong
  theme. Recompute with (swap `about.html` for its hash):
  `python3 -c "import re,hashlib,base64;d=open('index.html','rb').read();c=re.findall(rb'<script>(.*?)</script>',d,re.S)[0];print('sha256-'+base64.b64encode(hashlib.sha256(c).digest()).decode())"`
  There are no inline event handlers, so
  scripts need no `'unsafe-inline'`; inline `style=` attributes do, hence
  `style-src 'unsafe-inline'`.
- **`script-src`/`connect-src` are pinned to the data sources.** `index.html`
  runs scripts from `'self'` only (plus the hashed inline block) and connects
  to `'self'` (the crawler's `data/`) + `hn.algolia.com` +
  `hacker-news.firebaseio.com` (the approximation the archive falls back on).
  If you serve `data/` from another origin or add an API, **update the CSP**
  or the browser blocks the new origin. `about.html` is tighter — it loads no
  `app.js` and makes no fetches.

Meta CSP can't set `frame-ancestors`; add an `X-Frame-Options`/`frame-ancestors`
header at the host if you want anti-clickjacking. Editing the CSP or the metas
is an HTML change, so no `?v=` bump — that's only for `css`/`js` assets.

**Favicons**: `favicon.svg` is the hand-authored vector source — the "Moonlit"
mark: drkr's dark field (`#181a1b`) + a two-tone geometric `d` (a dim ring
`#a83c00` with its left half over-painted bright `#ff8a33`, plus a bright stem),
echoing the ◐ mode toggle and drkr's split accent. Drawn as shapes (circle +
rects), not text, so it's font-independent. The raster set derives from it — `favicon.ico` (16/32/48), `favicon-96x96.png`,
`apple-touch-icon.png` (180, full-bleed opaque square; iOS masks its own
corners), and `web-app-manifest-{192,512}.png` (referenced by
`site.webmanifest` for install-as-PWA). No rasterizer/Pillow is assumed:
regenerate the PNGs by screenshotting the SVG in headless Chromium at each size
and pack the `.ico` by hand (PNG-in-ICO). Edit `favicon.svg`, re-derive, and
bump the `?v=` on the icon links in both HTML files.

## The prime directive: fidelity to the original

Every behavior here was reverse-engineered from hckrnews.com (its compiled
CSS, minified JS, and `/data/*.js` files). When changing feed/filter/layout
behavior, compare against the live site first — the original is the spec.
Non-obvious semantics that took real digging (don't re-break these):

- **Selection**: hckrnews is "a chronologic list of items that have made it
  onto the HN homepage" — NOT all stories by submission time.
- **Sort key**: each entry's `date` field = when the story first reached the
  front page (`time` = submission). Sort `date` desc. Second-chance-pool
  stories make these differ by days.
- **Day files are UTC**; the *visible* day tabs and 6am/12pm/6pm gutter
  markers follow the viewer's local clock. Both at once, on purpose.
- **top 10/20/50% thresholds are per UTC day and pro-rated**:
  `n = ceil(hours_spanned/24 * n)`, threshold = nth-highest points (lowest
  if fewer than n; floor 1). Without pro-rating, the partial current day
  shows its entire tail. Ties pass (`>=`), so 21 for "top 20" is correct.
- **`homepage` flag** = "on the front page right now" (drives the orange
  points + homepage filter). Archived days decay to false.
- **Dead entries** render title `undefined` (sic — original behavior) and
  are visible by default (the original's server render ignores the
  setting), hence `showdead: true` default + the `_v` state migration.
- Links render in the text color (the original has no blue anywhere);
  visited = muted gray; day-tab labels format as `ddd, MMM D`.

## Data pipeline (js/app.js)

1. **Primary**: `data/latest.json`, the crawler's current + previous UTC
   day, `fetch`ed same-origin by `loadData()` (`cache: 'no-cache'`, so it
   always revalidates). Re-polled every 4 min (`POLL_MS`) for count updates
   and the "N new stories" link.
2. **Archive** (infinite scroll): the crawler's frozen `data/YYYYMMDD.json`
   for each older UTC day, and for a day it has no file for (before it
   started), HN Algolia `search_by_date` — one UTC day per query pair
   (stories ≥ `ARCHIVE_MIN_POINTS` = 20, plus jobs), `date := created_at_i`.
   That's an approximation (front-page arrival times aren't public) fitted
   against real day files, F1 ≈ 0.7. Infinite scroll stops at `MAX_DAYS` =
   14 UTC days. Percent-encode `<`/`>` in `numericFilters` or Algolia's proxy
   400s.
3. **Backfill**: a file whose oldest story lands more than 2 h into its UTC
   day came from a crawler that started that day, so `backfill()`
   approximates the stretch *before* that story from Algolia. Only that
   stretch — merging Algolia's whole day would scatter approximations through
   the part the crawler saw exactly.
4. **Fallback**: no `latest.json` at all → Algolia for today + yesterday at a
   gentler `FALLBACK_MIN_POINTS` = 10.
5. Firebase `topstories.json` (top 30) supplies `homepage` for Algolia rows.
6. `merge()` dedups by id; crawler (`exact: true`) data always wins.

Rendering is one flat `allEntries` stream (sorted by `date` desc) rebuilt by
`renderStream()` into per-local-day `<ul>`s. Filtering only toggles
`display` via `applyFilter()`/`utcThresholds()`.

## The crawler (crawl.py)

It replaces hckrnews's own crawler, which nobody outside can see — so every
rule below was inferred from the original's output (`/data/latest.js`, its
day files, its minified JS) against HN's Firebase API, then checked by
running both side by side and diffing every field. Changing one of them means
re-doing that comparison, not reasoning about it.

- **The front page is `topstories[:30]`**, not the HTML at
  news.ycombinator.com. The two disagree around rank 30 every few minutes,
  and the original's homepage flags follow `topstories`.
- **Polls every 30 s, on the :00/:30 grid.** The original's arrival stamps
  are spaced in multiples of ~33 s (a 30 s timer plus crawl time); `date` is
  the poll that first saw the story.
- **Every recorded story is re-read every poll.** The original keeps points
  and comment counts current for stories *off* the front page too — a slower
  rotation shows up in a diff. `get()` keeps connections alive for that: one
  TLS handshake per request would cost several times the data.
- **The schema is the original's, types and quirks included.** `id` and
  `time` are strings, `date` and `points` ints. `points`/`comments` are null
  wherever the API omits them (jobs, the dead, the deleted). `link` is `''`
  without a URL. `source` is the URL's hostname, `www.` included — absent for
  text posts, and *kept* when a dead story loses its URL. A missing title or
  submitter is the string `'undefined'`, which is where the "undefined" dead
  rows come from. The newest entry in `latest.json` carries `last_update`
  (time of the last poll); day files don't.
- **Same-poll arrivals tie on `date` and sort by id, descending**
  (`newest_first()`), as the original orders them.
- **Day files freeze at 00:00 UTC**, when their day leaves the two-day
  window: `homepage` forced false, never rewritten after (the original's
  scores stop moving at that point too).
- **A cold start leaves out the front page and whatever on the next two
  pages could have been on it** (`cold_start()`, kept in
  `data/.baseline.json` for three days). Stories around rank 30 drop off and
  return for hours, so without it the first day fills with "arrivals" stamped
  at their re-entry — three of the first four a fresh crawler logged were
  exactly that. The exception is anything below rank 30 younger than 2.5 h
  (`CLIMBING`): in snapshots checked against the original, nothing that
  young had been on the front page yet — the youngest that had and dropped
  off was ~3 h old — while every one of them still climbing would otherwise
  have been lost on arrival. Excluding by *submission* time instead looks
  tidier and is wrong: about a quarter of arrivals are second-chance stories
  submitted one to three days earlier.
- **All state lives in `data/`.** On start it reloads `latest.json`, every
  day file (for the ids it has ever recorded) and `.baseline.json`, so a
  restart loses nothing; an outage just stamps whatever arrived meanwhile with
  the time it comes back. Writes are atomic (dot-named temp file, then
  rename).

## Redirects (the `FRONTENDS` registry, js/app.js)

Story links can resolve to an alternative front end (Nitter for X, Redlib for
Reddit, …). This is ours, not the original's — hckrnews has no such feature —
so fidelity doesn't constrain it; correctness and honesty do.

- **The feature itself is opt-in** (`state.redirects.on` defaults false):
  rewriting someone's links to a third party is not something to do to a
  visitor who didn't ask. Don't quietly flip that back.
- **The `gated` rule decides what happens once it's on**: a service marked
  `gated: true` (the site withholds basic reading from signed-out visitors) is
  switched on within the feature; everything else ships off. `svc.on` falls
  back to `svc.gated`, so adding a gated service enrolls it automatically. Two
  gated services opt out with an explicit `on: false` — TikTok (every ProxiTok
  instance we found is broken) and paywalled news (archive.today captchas too
  often to surprise someone with). If you flip one of those, say why in `note`.
- **Host matching walks up the labels**, so `hosts: ['medium.com']` also claims
  `netflixtechblog.medium.com`, and `reddit.com` claims `old.`/`np.`/`new.`. It
  never matches a bare TLD. `skip` excludes specific hosts that the parent walk
  would otherwise catch (`i.redd.it`, `miro.medium.com`).
- **`map(url, base, instance)` returns null to leave a link alone**, which is
  the right answer whenever the front end can't serve that path —
  AnonymousOverflow only renders `/questions/<id>`, BreezeWiki needs a wiki
  subdomain. Falling through to a broken page is worse than not redirecting.
  The default (no `map`) is an origin swap keeping path, query and hash.
- **Instances rot, fast, and you cannot verify them from this box.** Nearly all
  of them sit behind Anubis or Cloudflare bot challenges: curl gets
  "Just a moment…" / 418 / 403 and *headless Chromium is also refused*
  ("Automated verification failed"), so a failed probe means nothing. What a
  probe does prove: NXDOMAIN is dead (that's how freedium.cfd and
  proxitok.pabloferreiro.es were caught), and a 404 on a correct deep path is a
  broken route. Lists were last checked 2026-08-04.
- The escape hatches exist because of the above: every row has a `custom…`
  entry, and alt-clicking a rewritten link goes to `data-original`. Don't
  remove either.
- **The source label keeps the story's own domain** — renaming it to the front
  end would lie about what the story is. `.source.redirected` (dotted
  underline + title) is the only tell.

- **The settings panel has room for exactly one line of this.** The master
  switch is the fourth checkbox in the existing `Settings:` group — not a
  section of its own — and the twelve-row list hides behind `customize`,
  standing in as a muted line naming what's on (`redirectNames()`, capped at
  four). Its own section cost 503px of an 858px panel, 1064px of 1603px on a
  phone; collapsed it's ~30px. Anything else added here should collapse too.
  Two things that bit once: the summary goes stale unless every per-service
  change calls `syncRedirectUi()`, and `restore defaults` must preserve
  `state.redirects.on` — it sits inside the list, so flipping the master
  switch above it is not its business.

State lives at `state.redirects = { on, services: { <id>: { on, instance } } }`.
`normalizeRedirects()` rebuilds it against the registry on every load: unknown
ids are dropped, missing ones arrive with defaults. **That's why adding a
service needs no state migration** — don't write one. The one real migration
is `_v < 4`, which clears `redirects.on`: v3 shipped the feature on by default
for a few hours before it became opt-in, and saves from that window would
otherwise keep a setting nobody chose.

## Theming (css/style.css)

Everything flows through CSS custom properties defined per
`[data-theme="…"]` block; themes are pure variable swaps. Registry lives in
BOTH `THEMES` (js/app.js) and the CSS blocks — add new themes in both.
Light: classic (default), sepia, solarized-light. Dark: drkr (default),
dracula, nord, solarized-dark, terminal (also swaps `--font` to monospace).

Accent has three roles — `--accent` (fills: tabs/pills), `--accent-hi`
(orange text: homepage points, "N new"), `--accent-line` (day rule). Only
drkr splits them (Dark Reader-style two-tone); other themes inherit via
`--accent-hi/line: var(--accent)` in `:root`. The user accent picker and the
FOUC-prevention inline scripts (in BOTH `index.html` and `about.html` —
keep them in sync) set all three. A custom accent also needs the text that
sits on it: a theme's `--accent-fg` was chosen for its own accent and vanishes
on a light user color (white on yellow), so `applyTheme()` sets `--accent-fg`
from `textOn()` — white unless the accent is too light to carry it at 2.5:1,
which keeps the HN orange white. Only `app.js` does this; the inline scripts
don't, since nothing accent-filled is on screen before it runs. With no custom
accent the picker shows the theme's own `--accent`, not a fixed `#ff6600`.

**`theme-color` (the mobile browser chrome / PWA status bar) is deliberately
two metas plus a JS override, and the pieces only work together.** `index.html`
ships a `(prefers-color-scheme: light)` / `dark` pair as the pre-JS guess, then
`applyTheme()` strips their `media` and writes the *resolved* background to
both — because the OS preference is only a guess: a forced `mode`, a non-default
dark theme (nord is `#2e3440`, not `#181a1b`) or a light theme all outrank it.
Three ways to re-break it: reverting to `querySelector` (singular) sets only the
light-media meta, which does nothing on a dark phone; deleting one of the
metas loses the pre-JS guess; and reading the color off `body` instead of the
`--bg` variable — body transitions its background, so straight after a toggle
it still reports the *old* color and the chrome lags one switch behind.
`about.html` has no `app.js`, so its inline script does the same swap itself
on `load` (the first moment the stylesheet is guaranteed in).
`site.webmanifest` can hold only one color, and it's the dark field, matching
the icons' own background so the install splash doesn't flash white.

Each theme swatch in settings carries its own `data-theme`, so it previews
that palette — which means `--accent` *inside a swatch* is that theme's
accent (correct for its dot, wrong for anything else). `--ui-accent`, set on
`:root` only, carries the page's accent past those local rebinds; the swatch
selection ring uses it so the marker matches the active mode pill instead of
changing color per theme. Chrome that must stay in the page's accent belongs
on `--ui-accent`, not `--accent`.

Grid = the original's customized Bootstrap-2 18-column metrics, hand-carried
at four breakpoints (<768, 768–979, 980–1199 default, ≥1200). Don't swap in
flexbox/grid "modernizations" — pixel parity with the original matters.

Pixel-parity subtleties, verified against the live site's computed styles
(2026-07-08) — don't re-break these:

- **The tablet + phone media blocks live at the END of style.css** (the
  original ships them in bootstrap-responsive.css, loaded last) and rule
  order inside them is load-bearing: phone `.entries .source { 10px }` must
  beat the base 12px rule, and phone `.span15`'s `margin-left: 124px` must
  come AFTER `.offset3 { 13px }` so day tabs align with story titles.
- **Time-of-day gutter markers are plain text** — Bootstrap's `.label` badge
  component isn't in the original's compiled CSS at all. No background, no
  border-radius, no font tweak; just absolute positioning.
- **Day tab / last-visit label are `inline`, not `inline-block`** — their
  vertical padding overflows the line box instead of inflating it (day rule
  = 21px tall, not 27px).
- **Nav pills are floated `li` + block anchors with `margin: 2px 2px 2px 0`**
  (plus the `.nav-pills` clearfix), and `.nav` keeps Bootstrap's 20px
  margin-bottom in the header — that margin IS the header's height; only
  `.menu .nav` zeroes it.
- **`p { margin: 0 0 10px }`** (Bootstrap base) sizes the comments/points
  menu row to 34px; `.entries p` zeroes it back for story rows.
- The header `<h3>` subtitle must fit ONE 12px line at the default
  breakpoint (300px column) — keep it short.
- **Phone `.span15`'s 124px offset is for story rows only.** It exists so
  titles clear the comments/points columns; the settings form and the about
  prose have no such columns, so they override it back to the plain 20px
  column margin (which, against `.row`'s -20px, lands them flush with the
  comments/points column). Without that they lose ~30% of a 390px screen.
- **The appearance chip rows (`.mode-pills`/`.swatches`/`.theme-controls`)
  must set their own `gap`** — swatches are appended from JS with no
  whitespace between them, so absent a gap their borders touch and the
  `.selected` ring bleeds onto the neighbor. Don't rely on inline whitespace
  the way the hand-written `.mode-pills` buttons once did.
- **The last-visit rule belongs to `li.lastvisit` only.** The link inside
  carries the `lastvisit` class too (it's the click target); a selector that
  catches both draws a second rule 9px under the first.

Phone and touch-screen rules — ours, not the original's:

- **Every hover effect sits inside `@media (hover: hover)`.** A touchscreen
  applies `:hover` on tap and keeps it until the next tap elsewhere, so a bare
  hover rule leaves the tapped story row or settings pill highlighted. Don't
  add one outside that query.
- **On a phone the mode toggle is the glyph alone** (`.mode-name` hidden; the
  link's `aria-label` names the mode). The original's header holds two pills;
  with the word, three only fit beside the 150px logo column from ~370px, so
  360px Androids got the whole nav dropped under the logo. ☀ carries U+FE0E or
  iOS draws it as a color emoji.
- **Numbers that outgrow their columns.** Points are `flex-end` so a 3-digit
  score in the phone's 22px column overflows left, not into the title; an
  unread count's `/ total` is its own `.total` span, which a phone stacks on a
  small second line instead of letting the 42px column wrap it mid-figure.
- **Story links break long tokens** (`overflow-wrap: break-word`): a title or
  domain with no break opportunity otherwise widens a phone's page and the
  browser zooms everything out to fit it.
- **Instance `<select>`s and the custom URL field are 16px on a coarse
  pointer** — iOS zooms in on focusing anything smaller, and stays zoomed.

When checking parity, diff computed styles in a headless browser
(`getBoundingClientRect` + `getComputedStyle` on matching selectors at 1440px
and 390px widths) rather than eyeballing screenshots.

## State

One localStorage key `drkrnews:v1`, versioned via `_v` (see
`loadState()` migration). Holds filter, settings, theme choices, custom
accent, redirect switches and instances, lastVisit, and per-story
read-comment counts (capped at 500).
