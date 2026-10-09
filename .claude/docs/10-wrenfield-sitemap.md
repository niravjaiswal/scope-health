# Wrenfield 4.2.0 — site map, protocol, speed, gotchas (cartographer, Oct 8 2026)

Client: `research/scripts/wf_client.py` (+ `wf_font.py`, `wf_font_ref.json`, all three must ship together; needs
`pip install playwright fonttools brotli` + chromium). Tests: `research/scripts/wf_client_test.py`.

## 0. TL;DR — things that will silently cost points
1. **Scrambled identifier font.** Some values (phones on the chart; in other loads possibly MRN / member ID / any
   mono-font value) are rendered with a per-page-load font whose cmap permutes digits 2-9 and A-Z. The DOM text is
   cipher text: DOM said `(450) 559-3335`, screen showed `(620) 223-4442`. Reading `innerText` / HTML gives WRONG
   answers. `wf_client` decodes by matching glyph outlines against the reference font (verified vs screenshots).
2. **Per-character shuffles + decoys.** e.g. Member ID: one `<span>` per char, `position:relative; left:±n ch`
   reorders them visually, plus 2 `display:none` decoy chars. DOM order `MVX758109714` (14 chars w/ decoys) vs screen
   `VXM801577149`. Client sorts leaf char runs by rendered x-position and drops hidden/zero-width spans.
3. `/patients/all` is a **honeypot** (hidden `aria-hidden tabindex=-1` link in the shell nav) → "This patient record
   is not available". There is no all-patients list. (No data poisoning observed after visiting it, but don't.)
4. **Location is session state** and filters list pages (billing list, dashboard, schedule) and sets the time zone
   shown (Northgate `times in CDT`, Front Range `MDT`). Fresh session default = Northgate.
5. Restricted charts show a gate ("This chart is restricted" + reason select + Request access) — opening needs a
   WRITE (access request, audited, expires "after a short time"). Never do it on practice.
6. Document contents are **images** (PNG page render) + a PDF (Noto fonts, ToUnicode present) — no HTML text.

## 1. URL map (all deep-linkable via GET of the shell URL; ids are 10-char base36)
| Page | URL | Notes |
|---|---|---|
| Dashboard | `/` | "today" = **Oct 14, 2026**, "Updated 10:00 AM CDT"; KPI tiles link to lists; Today's schedule table (8 rows + **Show more** button = in-page POST); Recent activity |
| Patient search | `/patients?lastName=Mu` or `/patients?dob=1971-06-05` | last-name **prefix ≥2 chars**, case- and accent-insensitive (Rodriguez = Rodríguez); DOB must be `YYYY-MM-DD` in URL (form uses date input); both together → no search. 25/page, "Rows per page" 25/50/100 and Next = in-page POST (not in URL). Columns Patient, MRN, DOB "(age y)", Sex, Flags (`Restricted`, `Test record`, `Deleted`, `Merged`). Also shows "Restricted chart requests" table (shared user ⇒ other teams' requests appear) |
| Chart demographics | `/patients/<pid>` | header dl: MRN, DOB, Sex, Billing→Invoices; Contact (Phone [scrambled font], Email masked `v•••••@…`, Address 2 lines), Care team (Primary provider, Home location) |
| Chart tabs | `/patients/<pid>/insurance` `…/problems` `…/notes` `…/documents` `…/appointments` `…/activity` | tabs are plain `<a href>` (also click tokens). insurance: Payer/Plan/Member ID (char-shuffled) or empty; problems: Code/Condition/Onset; notes: date filter + list (type, author, time+tz, text); documents: Title/Type/Received/View; appointments: Recurring list + table Date and time/Type/Provider/Location/Status (paged); activity: select All activity/Changes/Chart views + When/User/What |
| Appointment | `/patients/<pid>/appointments/<aid>` | Visit (Date, Time "10:40 AM to 11:00 AM CDT", Length, Type, Status), Provider, Location, Reference, Booked, Last changed, History table; chart appointment list below |
| Recurring series | `/patients/<pid>/recurring/<sid>` | Rule (Repeats, Length, From, Until, Type), changed dates table, every date table |
| Chart document viewer | `/patients/<pid>/documents/<did>` | nested iframe: "Referral letter, received … · 1 page · 26 KB", `<img alt="Page 1 of 1, …">` (PNG 1700×2200), PDF via Download/Open in new tab (`/v/<rand>/<rand>`) |
| Billing account | `/billing/accounts/<pid>` (same id as patient) | Invoices of this patient: Invoice/Service date/Location/Issued/Total/Status/Filed under; paged |
| Billing (invoices) | `/billing` | filters (in-page POST, NOT in URL): number, patient last name, location (values 1..10), status open/partial/paid/void, service/issued date ranges, owed min/max; sort select (16 orders); "Showing 1 to 25 of 500+"; 25/50/100 per page. List respects session location |
| Invoice | `/billing/invoices/<iid>` | Details dl (Patient + MRN, Location, Service date, Issued, Total, Status) + Ledger (Date/Description/Charges/Payments and adjustments, Amount owed) |
| Schedule day | `/schedule?date=YYYY-MM-DD` (`/schedule` → replaceState to today) | one location at a time (All locations ⇒ "Choose a location" list); columns per provider with working hours, appointment blocks (time, patient, status · type) and `Open` slots; Previous/Next day/Today buttons (in-page, update URL date) |
| Schedule provider | `/schedule/providers/<prov>?date=` | provider select (80), table "Appointments and open slots at <loc> on <date>": Time/Patient/Visit type/Status |
| Appointment list | `/schedule/appointments?from=&to=[&location=<locid>&status=1..5]` | **nested iframe**; filters From/To/Location/Provider/Status/Visit type (41 types) + Show appointments; table Date/Time (with tz)/Patient/Provider/Visit type/Status. status 1 Scheduled 2 Completed 3 Cancelled 4 Late cancel 5 No-show |
| Documents | `/documents`, `/documents/<did>` (viewer pane) | filter Type (referral_letter/lab_report/statement), received from/to, patient find; table Received/Type/Title/Patient/View; restricted docs show "Restricted chart"; 200+ |
| Activity | `/activity` | filters user (128 staff, value = username), action create/update/delete/merge/view/login, record patient/appointment/series/invoice/document/user, from/to; Time/User/Action/Record/What changed; 25/50 per page |
| Notices | `/about/notices` | font licenses (mentions identifier fonts + "pictures of text") |
| Login | `/login` | practice: 302 → `/` (auto sign-in, cookie `wf_session`); judge: form with password field (client fills generically) |
Shell-only: location switcher (`<details>` summary aria-label "Location: X. Change location", buttons per location
with city/state; KS = Central, CO = Mountain), account menu (theme radios, Third-party notices, **Log out** button —
never click), hidden honeypot `/patients/all`. Location ids seen: Northgate=`2mgdl287kq`.

## 2. Protocol (precise)
1. `GET /path` (shell, ~10 KB): nav + header + `<main>` placeholder `<div data-P="0" data-H=token>Loading Wrenfield</div>`,
   hidden fingerprint block (`<i>` boxes with random classes) and inline `window["_rand"]=function(){…}` returning a
   base36 hash of `getBoundingClientRect` geometry of those boxes. App JS at `/v/<rand>/<rand>.js` (all attribute /
   param names are literals randomized per load).
2. JS POSTs `/v/<rand>/<rand>` form-encoded `{<actionParam>: <token of element>, <fpParam>: window[fn]()}` (+ form
   fields for submits/changes). Wrong fp / replayed token → **401** (app then reloads top page; if reloaded <4 s ago
   shows "Wrenfield is not responding"). Tokens are single-use.
3. Response = `<template data-T="target">` fragments replacing children of matching elements, `<template data-S>`
   scripts (new fp functions), and `<meta data-C="code" content=…>` commands: 1 top.location.assign, 2 pushState,
   3 replaceState, 4 "navigate in app" (POST `{navParam: path}` from the shell), 5 title, 6 reload. Iframes forward
   commands to the parent via `postMessage([code, arg])` (7 theme, 8 close menus, 9 iframe height).
4. Main content = `<iframe src="/v/<rand>/">` — the iframe document is **fully server-rendered HTML** (content is in
   the GET response), with its own CSS (per-load URL, ~40 KB, contains the scrambled `@font-face`), own app JS, own
   fingerprint block → in-iframe actions (search submit, pagination, filters, Next day) POST to the iframe's own
   `/v/<rand>/<rand>` with the iframe's fp. Some pages nest a 2nd iframe (appointment list, document viewer).
5. `/v/<rand>/` URLs are **single-use and session-bound** (re-GET → 401, other session → 401). Fonts under
   `/static/*.woff2` are static and re-fetchable (`immutable`).
6. `frame.goto(deep link)` inside the iframe just loads a nested shell — useless.
7. **popstate trick**: the shell listens to `popstate` and POSTs `{kpffd4-like param: location.pathname+search}` with
   a page token → new iframe for ANY path. So `history.pushState(null,'',path); dispatchEvent(new PopStateEvent('popstate'))`
   navigates in-place with 1 POST + 1 iframe GET (no shell reload). Works for every URL above incl. query strings.

## 3. Speed (from Mac → hosted practice; judge LAN should be faster)
| Method | per page view |
|---|---|
| `page.goto(shell)` + wait all frames ready | 0.40 s (0.33 s with fonts/images blocked — fp still OK) |
| `page.goto` + `networkidle` | 0.9–1.5 s (don't) |
| **popstate in-place navigation** (client default) | **0.17–0.26 s** |
| in-frame action (Next page, search submit, Next day) | ~0.1–0.2 s |
| text extraction incl. font decode | ~10–30 ms |
| throughput, popstate, 1 / 2 / 4 tabs (one browser, one session) | 4.1 / 7.9 / 15.9 views/s |
Readiness signal (generic, no class names): every same-origin doc has `readyState!='loading'`, `body` not `inert`
(app removes it after init), no `aria-busy` on `<html>` (set during POSTs), no visible `[role=status]` "Loading…",
every `<iframe>` loaded (not about:blank) — plus no POST/document request in flight for 40 ms. Fonts must NOT be
blocked (decode fetches them); CSS must load (fingerprint + computed styles). `block_assets=True` blocks only `<img>`.

## 4. Client API (`wf_client.py`)
`async with WrenfieldClient(SITE_URL, SITE_USERNAME, SITE_PASSWORD) as wf:`
- `goto(path)` (popstate fast path, auto-fallback to full load, auto-disables popstate if a version lacks it,
  auto re-login if a password field / `/login` appears); `get_text(path=None)` → `URL:/LOCATION:` header + clean
  text of `<main>` incl. nested frames: headings `#`, tables `a | b | c` rows with header row and link targets
  `Name </patients/id>`, `<dl>` as `Term: value`, inputs `[input name = "v"]`, selects with selected + options,
  buttons `[Next]`, `(current)` for aria-current/pressed; invisible / sr-only / display:none / zero-size / transparent
  text dropped; scrambled fonts decoded; char runs visually re-ordered; `::before/::after` text included.
- `tables()` structured `[{caption, header, rows:[{cells, links}]}]`; `links()`.
- `search_patients(last_name=|dob=)` → rows `{name, mrn, dob, sex, flags, href}` across all pages (deep link, falls
  back to filling the form). `list_all_patients(concurrency=4)` = 676 2-letter prefix searches (~40 s; use sparingly).
- `chart_tab(pid_or_href, tab)`, `open_chart(ref)` → dict of tab texts (stops at restricted gate).
- `set_location(name)`, `location()`, `locations()` (session-wide, all tabs). `click_by_text(text)` (decoded visible
  text, exact > prefix > substring, deepest frame first; internal links followed via popstate), `fill(label|name, v)`,
  `select(label, option)`, `submit(field=|button_text=)`, `paginate_all()`, `document_files()` (PNG/PDF bytes),
  `request_restricted_access(reason)` (WRITE — judge only), `get_texts([paths])` concurrent via tab pool,
  `async with wf.tab() as t:` extra tab (same session).

## 5. Robustness notes for unseen versions (Sets 2/3/final)
- Nothing depends on class or data-attribute names; extraction uses tags/roles/computed style; navigation uses URLs or
  the app's own popstate/click handlers. Font decoding is generic (any `@font-face` used on the page is fetched and
  matched against 772 reference outlines of Wrenfield Mono + Atkinson Hyperlegible Next/Mono; tolerant fallback).
  `wf.fonts.warnings` reports fonts whose glyphs are not in the reference (⇒ a new base font: add it to the table).
- Expect other versions to: rename/move URLs (use links()/click_by_text fallbacks), add more decoy tricks, scramble
  other fields, change wording. If a value looks odd, cross-check with a screenshot (`tab.screenshot`).
- Other candidate tricks not yet seen but handled: flex `order`/`row-reverse`, bidi-override, text-transform,
  off-screen/clip/opacity/font-size:0 decoys. Not handled: text covered by overlays, colour == background, canvas.

## 6. Gotchas
- Shell `document.title` goes stale after popstate on pages without a title meta (search) — use the `#` heading.
- Clinic clock ≠ real clock: today = Oct 14 2026 (practice). Read "today" from the dashboard on each clinic.
- Times carry tz suffix (CDT/CST/MDT) per location; appointment list rows include it.
- Chart list pages are paged (25); counts like "500+" are not exact.
- Shared practice user: Activity / Restricted requests show other teams' actions (Oct 14 10:41–10:52 entries).
- Billing list filters + pagination are NOT in the URL (session state of that iframe) → re-apply after navigation.
