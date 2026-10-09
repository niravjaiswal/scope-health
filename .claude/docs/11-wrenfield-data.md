# 11 — Wrenfield data inventory (practice clinic, v4.2.0)

Author role: data inventory analyst. Explored 2026-10-08 evening (clinic clock: Wed **Oct 14, 2026**, starting
10:00 AM CDT and advancing in real time). Strictly read-only, except the one allowed restricted-chart access request.
Raw page dumps: `research/dumps/` (one file per page). Scripts: `research/scripts/inv_*.py`.

---------------------------------------------------------------------------------------------------------
## 0. TL;DR: what will bite us

1. **The phone number in the DOM is fake.** The Demographics phone is drawn in a **cipher font that changes on every
   page load**. The DOM text (and so `innerText`, `get_page_text`, and LLM reading of HTML) gives a different wrong number
   each time. Carol Jones: the screen showed `(785) 310-6041`, the practice expected answer was `7853106041`, and the DOM said
   `(568) 210-4031`, then `(623) 910-4051`, then `(457) 210-8091`.
   **Decoding works and needs no model** (§9): fetch the page's `@font-face` fonts, match glyph outlines against the plain
   "Wrenfield Mono" face, and map each character back. `research/scripts/inv_fontdecode.py` does this and was
   checked against the screenshot and the expected answer. So far only the phone uses the cipher font. Uppercase
   letters and digits are both remapped, so other versions could cipher MRNs, invoice numbers or amounts the same way.
   Run the same check on every field.
2. **There are decoys in the notes.** One Carol Jones note says "Patient says the best number to reach them is
   7853499086". That is *not* the phone on file. The phone on file is the Demographics → Contact → Phone value.
3. **Document PDFs come in three kinds** (§8):
   (a) vector PDF with an honest text layer;
   (b) vector PDF whose **ToUnicode map is booby-trapped**. Labels decode correctly, but values and names use duplicate
       glyphs mapped to wrong characters. Example: the screen shows "David Ramírez, Potassium 3.4", the text layer says
       "Divam Ridíroz, Petissaud 2.5";
   (c) **scanned image** PDF (1-bit 1700×2200), which has no text at all.
   Every referral letter seen so far is a scan. Lab reports are either kind. **We need OCR or a vision model for
   documents, or glyph-shape decoding.** Never trust the PDF text layer blindly.
4. **Misfiled documents exist.** Ana Corbett's "Referral letter from Granite Fork Internal Medicine" (Dec 1, 2024) is
   actually about *Charlotte Johnston, DOB 1979-09-07*. The practice task still expected the practice name from
   that letter.
5. **The location switcher is per-session state on the server and defaults to Northgate.** Patient search, dashboard
   and lists are filtered by it. **Set "All locations" first**, or most patients are invisible. Guadalupe Driscoll-type
   lookups fail otherwise.
6. **The appointment list stops at 500 rows** (count text says "200+"; page 6 says "No more results"). A full day across
   all locations has ~920 appointments. Filter by provider, location or status, or use narrow ranges. Long date ranges
   combined with filters can take >30 s, or time out.
7. **There is a honeypot.** A hidden nav link `<a href="/patients/all" aria-hidden="true" tabindex="-1">All patients</a>`
   goes to "This patient record is not available". Never follow `aria-hidden` or `tabindex=-1` links.
8. **The guide's example patients (Guadalupe Driscoll, Randy Singh b.1939-12-04, Julie Martínez b.2010-01-10, Jack
   Williams) DO NOT EXIST** in the current practice data, because the data was regenerated. The *current* practice-set
   tasks (from our practice run `t633e670acb34`, via `arena runs t633e670acb34`) DO match this clinic. Details in §14.

---------------------------------------------------------------------------------------------------------
## 1. Global shell, clinic, locations, time zones

- Shell: left nav = Dashboard, Patients, Schedule, Billing, Documents, Activity. Header: location switcher; "Harbor Glen
  Medical Group · Wrenfield 4.2.0"; account menu "frontdesk / Administrator" (theme toggle). The main content is in an
  `<iframe>` (see 00-context).
  The guide's screenshot of another version also has **Inbox** and **reports** in the nav. Expect extra pages elsewhere.
- Location switcher (`summary[aria-label^="Location"]`, then `button:has-text("All locations")`). The choice is stored in the
  session (2 POSTs) and survives page loads. A new browser context starts at **Northgate**.

| Location | City, State | TZ shown | location id (URL `location=`) |
|---|---|---|---|
| Northgate | Harbor Glen, KS | CDT/CST | 2mgdl287kq |
| Front Range | Summit Hollow, CO | MDT/MST | 4qsqd44qnv |
| Eastside | Harbor Glen, KS | CDT | 1018khchrv |
| Stonebrook | Stonebrook, CO | MDT | 2c49dv31pr |
| Lakeside | Marrow Lake, KS | CDT | 3wx9xbhbpz |
| Riverbend | Pell Junction, KS | CDT | 2j2bxc4p1z |
| Highline | Granite Fork, CO | MDT | 2dm0zb9mll |
| Prairie View | Tilden Grove, KS | CDT | 09dj1xgd2r |
| Cedar Hollow | Juniper Flats, CO | MDT | 6796t5g2mq |
| Willow Creek | Alder Creek, KS | CDT | 5d4q1sfn6w |

(The ids are random tokens. They were stable across our sessions, but this is unverified on other instances.
Resolve them from the `select[name=location]` options.)

- **Times always carry a tz abbreviation**: "Oct 22, 2026, 8:20 AM MDT", "8:00 AM to 8:20 AM CDT", and CST/MST in
  winter. Chart appointment lists, appointment detail and recurring pages use **the location's local time**. The
  date of an appointment is the local calendar date ("Times are local to the location" on recurring pages).
- The same instant can be shown in different zones on different pages. The Dashboard's "Recent activity" showed all
  rows in CDT ("10:46 AM CDT … Porter, Catherine"). The /activity page showed that row as "9:46 AM MDT"
  (the record's location zone).
- Clinic "now": the Dashboard says "Oct 14, 2026 · Updated 10:00 AM CDT". The audit log shows the clock moving in real
  time (10:52 AM, then 11:45 AM CDT about an hour later). "As of now" questions mean this clock, not the real date.

## 2. URL map (GET works for all of these, so you can navigate without clicking)

| Path | Notes |
|---|---|
| `/` | Dashboard |
| `/patients?lastName=X` / `/patients?dob=YYYY-MM-DD` | Search. Last name is **prefix** and **accent-insensitive** (`Mart` gives 200+; `Martinez` also matches `Martínez`). Paging and size are *not* URL params; set them by clicking (POST) |
| `/patients/<pid>` | Chart: Demographics |
| `/patients/<pid>/{insurance,problems,notes,documents,appointments,activity}` | Chart tabs |
| `/patients/<pid>/appointments/<aid>` | Appointment detail (rendered above the chart's appointment list) |
| `/patients/<pid>/recurring/<rid>` | Recurring series detail |
| `/patients/<pid>/documents/<did>` or `/documents/<did>` | Document viewer |
| `/billing` | Invoice list (filters are POST, not in the URL) |
| `/billing/invoices/<iid>` | Invoice detail |
| `/billing/accounts/<pid>` | Patient billing account (same id as the chart) |
| `/schedule?date=YYYY-MM-DD&location=<lid>` | Day view (one location) |
| `/schedule/providers/<provid>?date=YYYY-MM-DD` | Provider day view (shows **specialty**) |
| `/schedule/appointments?from=&to=&location=&provider=&status=&type=&order=` | Appointment list. status 1=Scheduled 2=Completed 3=Cancelled 4=Late cancel 5=No-show. Type codes: allergy, physical, anticoag, bh, bpcheck, cardrehab, cast, diabetes, echo, ekg, followup, hearing, immun, infusion, inject, lab, medcheck, proc, newpt, nutrition, office, pt, postop, preop, prenatal, sick, biopsy, skin, sleep, smoking, consult, sports, stress, tele, travel, ultrasound, vision, wellchild, wound, xray |
| `/documents` | All documents (type, received range, patient filter) |
| `/activity` | Audit log |
| `/about/notices` | Third-party notices (font info, §9) |

All ids are 10-char base36 tokens. They are stable per record, unlike the class names.

## 3. Patients list (search results)

- The page shows nothing until you search: "Find a patient by last name or date of birth". Sorted by last name, then first name.
- Columns: **Patient** ("Last, First", a link) | **MRN** (`HG` + 7 digits) | **Date of birth** (`MM/DD/YYYY (NN y)`) | **Sex**
  (Female/Male) | **Flags**.
- Flags seen: `Restricted`, `Merged`, `Deleted`, `Test record`, and combinations such as "Restricted Test record" or
  "Test record Deleted". Flags render on their own line, so `innerText` puts "Merged" or "Restricted" on the next line.
- Paging: 25 per page by default (25/50/100); "Showing 1 to 25 of 70 patients"; counts cap at "200+".
- Accents are kept: "Martínez, Andre", "Rodríguez", "Gómez", "Zoë". Many lookalike surnames exist (Martinez vs
  Martínez, Ramirez vs Ramírez).
- **Duplicates and merges**: typo copies sit next to the real record with flag `Merged`, for example "Martínez, Annna
  08/11/1999 Merged" vs "Martínez, Anna 08/11/1999", "Jackson, Juith" vs "Jackson, Judith", "Driscoll, Chris" /
  "Driscoll, Chistopher" vs "Driscoll, Christopher". The `Merged` flag is on the **absorbed duplicate**. Opening it
  redirects to the survivor with a banner (§5.8).
- Same name + same DOB with different MRNs also exists (e.g. "Test, QA" 09/13/1989 ×2), as do many same-name patients with
  different DOBs (e.g. 5 × "Driscoll, Mary"). Always disambiguate by DOB.
- Test records: last names `Test`, `Demo`, `Donotuse`, `Zztest` (first names Demo, Dummy, QA, Sample, Test…), with
  flag `Test record`. 129 hits for prefix "Test".
- Below the results: a "Restricted chart requests" table (Patient | Reason | Status Approved/Ended). It is **shared
  by every session that uses the frontdesk user**, so other competitors' requests show up here.

## 4. Restricted charts

- Opening one gives the title "Patient chart · Wrenfield" and the text: "This chart is restricted · MRN HG3001317 · Give a reason to
  open it. Your request and the reason are recorded, and access ends after a short time." `select[name=reason]`:
  **Providing care to this patient / Scheduling an appointment / Billing or insurance question / Request from the
  patient / Other reason** (+ `textarea[name=details]`, needed for "Other reason"), then the button "Request access".
- We sent ONE request (Martínez, Andre, "Billing or insurance question"). **It was granted instantly.** The same response shows the
  full chart, with a `Restricted` badge next to the name and all tabs working. The requests table showed "Approved". Access was
  still open at +47 s and gone (gate shown again) at +8 min. The table then showed "Ended". Each opening is written to the
  audit log ("Restricted chart opened. Reason: …").
- In lists, a restricted patient's name still shows, with the `Restricted` flag (schedule, billing, appointment list). In
  /documents the title is replaced by "Restricted chart".
- Prevalence: 21 of 500 appointment rows on 2026-10-21, and about 4 of 25 rows in the "Martinez" search. Roughly 4–15% of patients are restricted.

## 5. Patient chart

Header (every tab): `Last, First` [+ badge Restricted/Deleted/Test record], **MRN** `HG9736761`, **Date of birth**
`09/07/1982 (44 years)`, **Sex** `Female`, **Billing** link `Invoices` (→ `/billing/accounts/<pid>`).
Tabs: **Demographics · Insurance · Problems · Notes · Documents · Appointments · Activity**. There is no allergies,
meds, guarantor, emergency-contact or immunization tab in this version.

### 5.1 Demographics
- **Contact**: Phone `(785) 310-6041`, drawn in the **cipher font** (§9); Email masked `j•••••@wrenmail.example` or
  "Not on file"; Address on 2 lines, e.g. `8005 Glen Blvd Apt 25` / `Tilden Grove, KS 66785`.
- **Care team**: Primary provider `Jennifer Parker, MD`; Home location `Eastside`.

### 5.2 Insurance
- "Primary insurance": Payer `Meridian Mutual Health`, Plan `High Deductible 5000`, Member ID `XGM028175053`. The member ID
  is rendered **one character per span**, but `innerText` joins them correctly. Other payers seen: Lakeshore Community Care /
  Community HMO.

### 5.3 Problems
- "Conditions on the problem list": Code | Condition | Onset. Example: `I10 Essential hypertension Apr 6, 2015`,
  `G47.33 Obstructive sleep apnea`, `K21.9 Gastroesophageal reflux disease`. Or "No conditions recorded".

### 5.4 Notes
- Filter: Written from / Written to, Apply / Clear. Cards, newest first: **type** (`Message`, `Phone call`,
  `Chart note`) / **author** (staff name, "Dr. Parker", "Joyce Nelson, NP") / `Jul 22, 2026, 4:37 PM` / `CDT` / body.
  "8 notes".
- Bodies are free text with decoys (alternative phone numbers, medication names, "Next visit on or about
  2026-06-03").

### 5.5 Documents (chart tab)
- "Documents in this chart, newest first": **Title** (`Referral letter from <Practice>`, `Lab report: <Panel>`,
  `Statement of account YYYY-MM`) | **Type** (Referral letter / Lab report / Statement) | **Received** (`Dec 1, 2024`) |
  `View`. "9 documents" or "No documents in this chart".
- The referring practice appears in the **title**, so the "which practice made the referral" question can be answered from
  the list without opening the PDF. The referral reason, urgency, signer and patient name in the letter need the scan (§8).

### 5.6 Appointments (chart tab)
- Optional section **"Recurring appointments"** first: `Every week on Wednesday at 07:30` (link) / `Nutrition counseling
  with Diane Gonzalez, MD at Eastside` / `Jul 15, 2026 to Nov 11, 2026, 2 changed dates`. **The single-appointment table
  does NOT list the series' dates.** To see each date's status, open the recurring page.
- "Appointments, newest first": Date and time (`Oct 22, 2026, 8:20 AM MDT`, a link) | Type | Provider (`William Kelly,
  NP`) | Location | Status (on its own line). **Paginated at 25** (25/50): "Showing 1 to 25 of 31 appointments". Or "No
  single appointments on record."
- Statuses: `Scheduled`, `Completed`, `Cancelled`, `Late cancel`, `No-show`.

### 5.7 Appointment detail (`…/appointments/<aid>`)
"Appointment on Jul 21, 2025": **Visit**: Date `Jul 21, 2025`, Time `8:00 AM to 8:20 AM MDT`, Length `20 minutes`,
Type, Status. **People and place**: Provider, Location. **Record**: Reference `98717975` (8 digits), Booked `Jul 12, 2025,
7:19 PM MDT`, Last changed. **History** table (When | User | Change): "Booked", "Status changed from Scheduled to
Completed". **The provider's specialty is not shown here** (use the provider view, §6).

### 5.8 Recurring series (`…/recurring/<rid>`)
"Recurring appointment: Every week on Wednesday at 07:30". **Rule**: Repeats, Length `45 minutes`, From `Jul 15, 2026`,
Until `Nov 11, 2026`, Type. "Times are local to the location." **People and place**: Provider, Location, Created, Last
changed. **Changed dates** (Date | Change | Recorded): `Aug 19, 2026 Cancelled Aug 10, 2026, 1:13 AM CDT`.
**All dates** ("Every date of this recurring appointment, newest first"): `Nov 11, 2026, 7:30 AM CST  Scheduled` … per
date status (Completed / Cancelled / Scheduled…). "18 dates". The appointment list shows a series occurrence with a
"Recurring" tag under the time, and its link goes to `/recurring/<rid>`.

### 5.9 Merged records
- Opening the absorbed duplicate (e.g. `/patients/550g1c1tm3`, "Jackson, Juith") lands on the survivor's URL with the banner
  **"The record with MRN HG1531598 was merged into this record. What was filed under it is shown here."**
- The survivor chart already contains the duplicate's items, with **no per-row marker** in the Appointments table.
  Billing account rows show **"Filed under MRN HG1531598"**. Activity shows "(on a record merged into this one)" and
  "Merged the record into another record". Notes may name the typo ("Juith seen for routine review").

### 5.10 Activity (chart tab)
Filter `select[name=kind]`: All activity / Changes / Chart views. Columns: When (with tz) | User (username) | What
("Opened the chart", "Created the record", merged …).

### 5.11 Deleted / test charts
They open normally, with a badge after the name (`Deleted`, `Test record`). Tasks say "leave out … test record or has
been deleted", and both show as flags in the search and appointment lists ("Demo, Test Test record").

## 6. Providers and specialties

- Only one screen shows **specialty**: **Schedule → Provider** (`/schedule/providers/<id>`). The header reads `Angel
  Ali, NP` / `Family Medicine · Wednesday, October 14, 2026`. `select[name=provider]` has optgroups **Active (72)**
  and **Inactive (8)**. An inactive provider shows the badge "Inactive" and still shows its specialty ("Douglas Hughes, MD ·
  Inactive · Cardiology").
- Full table: `research/dumps/providers_specialties.json` (80 rows: name, credential, specialty, status, id).
  Counts: Family Medicine 22 (+2 inactive), Internal Medicine 12 (+1), Physical Therapy 7, Pediatrics 6, Obstetrics and
  Gynecology 5 (+2), Orthopedics 5, Endocrinology 4, Cardiology 4 (+2), Behavioral Health 3, Dermatology 2, Allergy and
  Immunology 2 (+1).
- Inactive (left the group): Ruth Green, DO (FM); Douglas Hughes, MD (Cardiology); Rachel Martinez, MD (FM); Laura Murphy,
  MD (OB/GYN); Martha Olson, MD (OB/GYN); Edward Pierce, NP (Cardiology); Ann Shaw, MD (Allergy & Imm.); Joe Wilson, PA
  (IM).
- Credentials: MD, DO, NP, PA. Names are always shown as "First Last, CRED". Users in the audit log appear as usernames
  (`wkelly`, `jparker`) and display names ("Dr. Parker", "William Kelly, NP").

## 7. Schedule

- **Day** view (`/schedule?date=&location=`): with All locations it says "The day view shows one location at a time",
  with buttons per location (name plus city, state). With a location: header "Northgate · times in CDT". One column per
  provider: the provider name, then working hours ("8:00 AM to 12:00 PM, 1:00 PM to 5:00 PM"), then blocks such as
  `8:00 AM to 8:20 AM / Turner, Shirley / Completed · Office visit`, and **open slots** as `Open` + `8:20 AM to 8:40 AM`.
  A late cancel shows as `10:00 AM to 10:15 AM · Late cancel / Matthews, Omar`. Cancelled appointments still show, and
  an Open slot can sit on top of them.
- **Provider** view: specialty line, location + "Times in MDT", working hours, then a table Time | Patient (+Restricted) |
  Visit type | Status, with `Open slot` rows. It uses `select[name=provider]` and a date input with Previous day / Today / Next day.
- **Appointment list**: filters From, To, Location, Provider (with inactive providers), Status, Visit type (40 types:
  Allergy injection … X-ray), and the order (earliest/latest). Columns: Date | Time (`7:00 AM to 7:20 AM CDT`, plus a "Recurring"
  tag) | Patient (+flags Restricted/Test record/Deleted) | Provider | Location | Visit type | Status. Rows are sorted by
  absolute instant, so CDT and MDT rows interleave. 25/50/100 per page; **hard cap of 500 rows**. Example: one day
  (2026-10-21, all locations) gave 500 rows = 469 Scheduled + 31 Cancelled, with 80 recurring and 21 restricted rows. The
  real total was about 900.
- The Dashboard links into the list: `/schedule/appointments?from=D&to=D&location=<lid>&status=N`.

## 8. Documents

- `/documents`: "Referral letters, lab reports, and statements received for patients." Filters: Type (`select[name=kind]`:
  Referral letter / Lab report / Statement), Received from/to, Patient (last name or DOB). Columns: Received | Type | Title |
  Patient | View. 25/50/100 per page, "200+".
- Lab panels seen: Basic metabolic panel, Complete blood count, Thyroid panel, Vitamin D, Liver function panel, Lipid panel,
  Iron studies. Referring practices seen: Granite Fork Internal Medicine, Marrow Lake Urgent Care, Pell Junction Community
  Clinic, Wickford Women's Health, Harbor Glen Medical Group (our own name), Plains-type names, Dunmore Regional Hospital,
  Tilden Grove Pediatrics, Cinder Pass Orthopedic Associates, Summit Hollow Cardiology Partners, Elk Bend Health Center.
- **Viewer**: the header line is "Referral letter, received Dec 1, 2024 · 1 page · 22 KB", with "Open in new tab" / "Download"
  (`a[download]`, filename `Referral-letter-from-Granite-Fork-Internal-Medicine-2024-12-01.pdf`; one-time `/v/...` URL
  that can be fetched more than once in-page, `application/pdf`). There are zoom buttons, and each page is an
  **`<img alt="Page 1 of 1, …">`, a 612×792 PNG** (`image/png`).
- **PDF kinds** (checked with `inv_pdfprobe.py`, `inv_labtext.py`, `inv_pdfglyph.py`):
  - **Scanned**: one `/Image` XObject (1-bit, 1700×2200 ≈ 200 dpi), no fonts. There is speckle noise, and the signature is drawn
    in a handwriting font. **All referral letters seen so far, plus some lab reports (Corbett Vitamin D).**
  - **Vector, honest**: Type0/Identity-H NotoSans subsets plus ToUnicode, so the text extracts correctly (Corbett CBC, Wallace Vit D,
    statements).
  - **Vector, trapped**: the font subset has *near-duplicate glyphs* (same outline, slightly perturbed). Static labels use
    the honest copy. Names, dates and values use copies whose ToUnicode is wrong (e.g. glyph '1' is mapped to "6", 'm' to "d").
    The text layer looks plausible but is wrong. It even said "Tests reported: 4" where the page shows 8.
    Ways to detect it: in the extracted text, the DOB doesn't match the chart, panel names don't match known analytes, or the
    font has duplicate outlines with different ToUnicode values. Ways to decode it: (i) OCR or vision on the page PNG; (ii)
    glyph-outline matching against reference Noto Sans or Noto Serif (OFL, can be bundled in the image). The fonts are
    named in /about/notices.
- **Lab report layout**: "Harbor Glen Medical Group / Clinical Laboratory, <Location> / address", "LABORATORY REPORT /
  Report status: Final". Then Patient, Date of birth (YYYY-MM-DD), Sex (F/M), Record number (MRN), Ordering provider,
  Collected, Received, Report number (`LR-007926`). Then the panel title, and a table Test | Result | Units | Reference range |
  Flag (normal/low/high, abnormal values in red). Then "Tests reported: N" and "End of report".
- **Referral letter layout** (scan): practice letterhead plus address/phone/fax; addressee "Harbor Glen Medical Group /
  Referral Coordinator, <Location> / address"; "Date: 2024-11-24" (*the letter date, not the received date*); "RE:
  Patient: <Name> / Date of birth: YYYY-MM-DD". The reason sentence comes in varying templates: "The reason for this
  referral is as follows: Post-fracture rehabilitation." or "I would value your assessment of the following problem: Chronic
  cough lasting more than eight weeks." Urgency: "Please treat this referral as urgent." / "The urgency of this referral
  is routine." Then signature, "Steven Matthews, DO", and the practice.
- **Statement**: "STATEMENT", statement date, patient name, Account number (= MRN), address, Due date, Amount due; "Account
  activity": Previous balance, New charges, Insurance payments and adjustments, Payments received, Amount due. Remittance stub.

## 9. Anti-scraping in the rendered UI

- `/about/notices` openly says that "identifier fonts the site serves" are modified JetBrains Mono. PDFs embed modified
  Noto Sans/Serif, Pangolin and Mali subsets (Pangolin and Mali are handwriting fonts). Atkinson Hyperlegible Mono outlines are
  "read … to draw pictures of text". No SVG text-pictures turned up on the pages we probed, but **watch for them in
  other versions**.
- Each iframe document declares `@font-face` "Wrenfield Mono" (`/static/hk47g9j121822h7g4440.woff2`, honest), the
  same file under a random alias (used for MRN and DOB, honest), and **one cipher face with a random alias and random
  `/static/<20 chars>.woff2` URL per load**. The cipher face remaps digits 2–9 and A–Z (0 and 1 stayed fixed in one sample).
  Glyph *names* follow the codepoint, so they are useless. Glyph *outlines* reveal the true character.
- **Decoder** (`research/scripts/inv_fontdecode.py`, `inv_obfprobe.py`): in-page `fetch()` of each non-Atkinson
  `@font-face` URL; fontTools gives `{char: md5(RecordingPen outline)}`; invert the honest face; for each leaf element whose
  `getComputedStyle().fontFamily` is a cipher alias, map each character. This was verified to give `(785) 310-6041`. Cost
  is about 10 ms of CPU plus 2 small font fetches per page. For a screenshot or vision approach, the screenshot is correct
  as drawn.
- Probe results so far: the cipher font is used **only for the Demographics phone**. MRN, DOB, member ID, invoice
  numbers, amounts and dates are honest DOM text. There is no CSS `order` or reverse-flex reordering and no pseudo-element
  content. The only hidden text is screen-reader captions and table header labels, which are harmless.
- Email is masked server-side (`j•••••@…`). It can't be recovered.

## 10. Billing

- `/billing`: "Invoices of the practice". **Find invoice** (`input[name=number]` + "Open" goes straight to the invoice);
  **Patient** (last name, "Find patient"); Location; Status (Open / Partly paid / Paid / Void); Service date range; Issued
  date range; Amount owed at least/at most; "Apply filters" / "Clear filters". Filters are posted and are **not** URL
  params. Sort `select[name=sort]`: Issued/Service date newest/oldest, Amount owed, Total, Patient, Location, Status,
  Invoice number.
- List columns: Invoice (8 digits, leading zeros are significant, e.g. `03483827`) | Patient (+Restricted) | Location |
  Service date | Issued | Total (`$1,016.66`) | Status. 25/50/100 per page, "500+".
- **Invoice detail**: "Invoice 03483827 · Partly paid · Carter, Ryan · Prairie View · Service on Oct 14, 2026" with links
  Patient account / Open chart. **Details**: Patient (name + MRN), Location, Service date, Issued, Total, Status.
  **Ledger** (Date | Description | Charges | Payments and adjustments), with only 3 kinds of line: `Charge for services on
  <date>`, `Payment received`, `Invoice voided` (credits the remaining balance). Then **`Amount owed $160.96`**.
  A void invoice shows the banner "This invoice is void · Nothing is owed on it." and Amount owed $0.00, even if partly paid
  first. There are no CPT codes, line items, claims or insurance payers on invoices in this version. Statements (documents)
  do mention insurance payments.
- Totals range from about $26 to $14,894. Invoice history starts Oct 14, 2024, about two years back.
- **Account page** `/billing/accounts/<pid>`: name, MRN, DOB (`07/28/1969`, no age), "Invoices of this patient, newest
  service first": Invoice | Service date | Location | Issued | Total | Status | **Filed under** (merged MRN).
- The audit log records invoice events: "Issued", "Status changed from Open to Paid", "…from Partly paid to Partly paid".

## 11. Activity / audit log, dashboard

- `/activity`: filters User (≈130 staff, "Display (username)"), Action (Created / Changed / Deleted / Merged / Opened /
  Logged in), Record (Patient / Appointment / Recurring appointment / Invoice / Document / User account), From/To,
  Patient. Columns: Time (record-location tz) | User (display + username) | Action | Record (+flags) | What changed.
  25/50 per page, "200+".
- The audit log is **shared and live**: every competitor's restricted-chart openings appear here as `frontdesk`.
- **Dashboard** (follows the location switch). With All locations: Appointments today **920** (Scheduled 673,
  Completed 133, Cancelled 89, Late cancel 20, No-show 5), Patients seen today 132, Open slots today 293 ("Slots in working
  hours with nothing booked"), New patients this month 78 ("Records created since Oct 1, 2026"), Documents received this week
  175 (Oct 12–18), Invoices issued this week 1,833. Also "Today's schedule" (the rest of today, 8 rows + Show more) and
  "Recent activity" (10 rows, pager). With Northgate: 74 appointments, 35 open slots.
- There is no release-notes or versions page. The version shows only in the header string "Wrenfield 4.2.0". There are no
  reports pages in this version.

## 12. Data volume (rough)

- Patients: **~50,000**, estimated by sampling 40 random DOBs (mean 1.4 patients per date over 1930–2026).
- Providers: 80 (72 active + 8 inactive). Locations: 10 (6 KS/Central, 4 CO/Mountain). Staff users: about 130.
- Appointments: about 920 per weekday clinic-wide. The data runs from Oct 2024 and the scheduled appointments run into
  2027, so there are on the order of 10^5–10^6 appointments. Per patient (9 random charts): 1, 2, 4, 5, 8, 9, 24, 31, 75
  single appointments (median about 8). Recurring series are common: about 80 of 500 rows in one day were recurring
  occurrences, and a series has about 18 dates.
- Documents: about 175 per week. Per chart 0–9 (most have 0–1).
- Notes per chart 0–15. Problems 0–4. Invoices: about 1,800 issued per week (today's batch is skewed). Per patient 0–34.
- Implication: a full crawl of every chart at ~1 s per page is out of reach in a 15–60 min shift. Do targeted lookups
  (search by DOB or last name, then the needed tab). For aggregates, use the appointment list with tight filters.

## 13. Practice-run tasks vs. this clinic (verified)

Current practice set (`arena runs t633e670acb34`). The tasks match this clinic's data:

| Task | Where the answer is | Verified |
|---|---|---|
| Judith Jackson (b.2004-11-12), Kenneth Sullivan, NP on 2028-07-20 → `ESTABLISHED:2025-07-21` | Sullivan = Internal Medicine (provider view). Chart: Jul 21, 2025 Follow-up with William Kelly, NP (IM) Completed. Dec 24, 2025 Allergy injection is excluded. Nov 3, 2025 Prenatal with Mark Sorensen (FM) is another specialty. The duplicate "Juith" was merged in | yes |
| Ana Corbett (b.2000-11-13) referral received 2024-12-01 → `Granite Fork Internal Medicine` | Documents tab title "Referral letter from Granite Fork Internal Medicine, Dec 1, 2024". The letter itself names Charlotte Johnston (misfiled) | yes |
| Carol Jones (b.1982-09-07) phone → `7853106041` | Demographics phone, **cipher font**. The DOM shows a random wrong number. The notes hold a decoy 7853499086 | yes, after font decoding |
| Peter Henry (b.1975-06-23), Douglas Hughes, MD on 2026-12-25 → `NEW` | Hughes is **Inactive**, Cardiology. The only cardiology visit on page 1 is May 22, 2025, an Immunization with Aaron Wagner (excluded). The chart has more than 25 appointments, so page 2 needs checking. There are 2 appointments on Feb 23, 2026 at different locations and zones (MST and CST) | consistent |
| Gregory Porter (b.1976-04-08) referral 2025-09-16 reason → `Chronic cough lasting more than eight weeks` | Scanned letter from Marrow Lake Urgent Care: "I would value your assessment of the following problem: Chronic cough lasting more than eight weeks." | yes (screenshot) |
| Laura Torres (b.2001-02-20), Elena Gutierrez, NP (FM) on 2025-12-30 → `ESTABLISHED:2025-08-14` | **The answer comes from the recurring series** "Every week on Thursday at 08:00, Follow-up visit with Liam Farrell, NP (FM), Mar 20, 2025 to Aug 15, 2025". Its last Thursday is Aug 14. The single-appointment table has only Dec 30, 2025 (the visit date itself), a Dec 4, 2025 Late cancel, and Dec 5, 2024 | yes |

The guide examples are not in the current data (no Guadalupe Driscoll among 76 Driscolls; DOB 1939-12-04 is Joseph Garcia;
no Julie Martínez b.2010-01-10).

### Set 1 shows data this version lacks
Our Set 1 logger run (`arena logs rfc73d9936bfa`) asked about: lab-report triage (call the provider / nurse review / release),
which needs **lab values from documents**; **tetanus for wound visits**, which needs wound and immunization history that this
practice clinic does not show (wound-care visits here have only generic notes); invoice still owed (`invoice 83999703 …
voided owes nothing`); counts of scheduled appointments per provider and date "across all locations", leaving out test and
deleted records (use the appointment list filtered by provider, date and status, and drop rows flagged Test record or
Deleted); phone; and referral practice. **Other clinic versions will have more tabs or fields** (Inbox, immunizations, …).
Handlers should discover tabs by label, not by position.

## 14. Files

- Doc: `.claude/docs/11-wrenfield-data.md` (this file).
- Dumps (`research/dumps/`): `dashboard_*`, `search_*`, `chart_{demographics,insurance,problems,notes,documents,appointments,activity}_*`,
  `chart_merged_dup_annna_redirect`, `chart_deleted_*`, `chart_test_record_demo`, `appt_detail_*`, `recurring_detail_barnes`,
  `schedule_{day_all,day_frontrange_mdt,provider,provider_inactive_hughes,list}`, `billing_*`, `invoice_detail_{partlypaid,void}`,
  `documents_main`, `doc_*` (PDF text layers, incl. the trapped `doc_lab_bmp_ramirez.txt`), `restricted_*` + `restricted_flow.log`,
  `activity_main`, `about_notices`, `providers_specialties.json`, `appts_2026-10-21_2026-10-21.json` (500-row capped day),
  `invoices_sample.log`, `volume_sample.{log,json}`.
- Scripts (`research/scripts/`): `inv_lib.py` (helpers), `inv_run.py` (command runner: `all`, `goto`, `click`, `select`,
  `dump`…), `inv_dump.py`, `inv_providers.py`, `inv_apptscan.py`, `inv_invoices.py`, `inv_volume.py`, `inv_docprobe.py`,
  `inv_pdfprobe.py`, `inv_pdftext.py` (ToUnicode extractor), `inv_labtext.py`, `inv_pdfglyph.py` (duplicate-glyph trap
  detector), `inv_docshot.py` (page-image screenshots), `inv_fontprobe.py`, `inv_fontdecode.py` (**phone cipher decoder**),
  `inv_obfprobe.py` (obfuscation survey), `inv_selectvals.py`, `inv_shot.py`, `inv_restricted_once.py` (the single allowed write).
