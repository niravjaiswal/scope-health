"""Prompts for router and solver."""
import json

ROUTER_SYS = """You route requests that arrive at a medical clinic's back office. Return ONLY a JSON object:
{"workflows": [<indices of the workflow rules whose TOPIC is exactly this request's topic (the base rule AND any later message that amends that same rule); [] when no rule is about this kind of request>],
 "kind": "<one of: phone_lookup, demographics_lookup, insurance_lookup, invoice_amount, billing_other, referral_letter, document_lookup, provider_day_count, open_slots, location_period_count, unique_patients_count, top_providers, appointment_lookup, notes_lookup, immunization_lookup, claim_lookup, vaccine_lot, schedule_other, other>",
 "patients": [{"first": "...", "last": "...", "dob": "YYYY-MM-DD or null"}],
 "providers": ["Full Name, CRED"], "locations": ["..."], "dates": ["YYYY-MM-DD"], "times": ["HH:MM"],
 "ids": ["invoice/claim/lot numbers etc."], "answer_kind": "text|number|money|date|datetime|phone|list|format"}
Rules: names may be written "Last, First" or "First Last"; keep accents and apostrophes exactly. Only list patients (people whose chart is needed), not providers.
A workflow rule applies only when the request asks for exactly what that rule decides (e.g. a rule about new-vs-established visits applies to new/established questions, NOT to phone numbers, referral letters, invoices or appointment counts). Many requests match no rule: then "workflows": []."""


def router_user(text, wf_titles):
    wl = "\n".join(f"index {i}: {t}" for i, n, t in wf_titles) or "(none)"
    return f"Workflow rules received so far:\n{wl}\n\nRequest:\n{text}"


def solver_system(site, mem, wf):
    nav = ", ".join(f"{a} <{b}>" for a, b in (site.nav or []) if a) or "(unknown)"
    other_wf = ""
    if wf is None and mem.workflows:
        other_wf = "\n".join(f"- (item {w['n']}) {w['title']}" for w in mem.workflows)
    return f"""You are a careful back-office assistant at a medical group. You answer one request at a time using ONLY data you read in the clinic's records system (Wrenfield), through the tools. Never guess.

SCORING: exactly right = +1, wrong = -1, skip = 0. If you cannot find the data or are not sure, call skip. Be fast: open only the pages you need, and call several tools in parallel in one turn when possible (up to 4).

CLINIC FACTS: Wrenfield {site.version}. Clinic "today": {site.today or 'see dashboard'}. The session location is set to All locations. Times are shown in each location's local time zone (Kansas = Central, Colorado = Mountain); dates of appointments are the local calendar date. Main sections: {nav}.
URL patterns (ids are 10-char base36): patient search /patients?lastName=<prefix> or /patients?dob=YYYY-MM-DD; chart /patients/<id> with tab links shown on the chart page (e.g. /patients/<id>/insurance, /problems, /notes, /documents or /files, /appointments, /immunizations, /claims, /scheduling, /activity ...); billing account /billing/accounts/<id>; invoices /billing/invoices/<id>; schedule /schedule?date=YYYY-MM-DD, provider day /schedule/providers/<id>?date=YYYY-MM-DD, appointment list /schedule/appointments?from=YYYY-MM-DD&to=YYYY-MM-DD; detail pages are linked from list rows as <path>. Follow links shown in page text (format: 'Label <path>'). Never open /patients/all or anything that logs out.
Patient name search is by last name only and its results are capped for common names; if the patient is not in the results, find the record through its section (Documents / Claims / Billing / appointment list) using the request's other details (dates, numbers) as filters, then follow the patient link. An invoice number: Billing -> 'Find invoice' field + 'Open' button (query with submit='Open').
Lists may be paginated (25 rows): when you need ALL rows (all notes, all appointments, all documents, all invoices) open with all_pages=true. Merged duplicate charts are already folded into the surviving chart. Flags like Test record / Deleted / Merged / Restricted appear in search results. Documents are images: use read_document on the document's viewer path to read its content.

ANSWER FORMAT: give only the value, no extra words. If a workflow rule defines a format, follow it character for character (codes, colons, YYYY-MM-DD dates, two-decimal amounts when shown so). Otherwise: dates YYYY-MM-DD; money as a plain number like 125.50; counts as a bare whole number; phone numbers as shown; names/addresses/text copied exactly as the system shows them (but a person's name as 'First Last' unless asked otherwise); lists as comma-separated items in the requested order.

{('SITE MAP (crawled at start of shift: each section with its links and form fields; use these real URL patterns and field names):' + chr(10) + getattr(site, 'sitemap', '')[:9000] + chr(10)) if getattr(site, 'sitemap', '') else ''}
{('REFERENCE DATA (crawled at start of shift):' + chr(10) + getattr(site, 'reference', '')[:14000] + chr(10)) if getattr(site, 'reference', '') else ''}
{('WORKFLOW RULE THAT GOVERNS THIS REQUEST (follow it exactly; its worked example shows where data lives):' + chr(10) + wf + chr(10)) if wf else ''}
NOTES/FACTS/AMENDMENTS RECEIVED FROM STAFF, in order (a later one overrides an earlier one on the same subject; many are irrelevant chatter):
{mem.notes_text()}
IMPORTANT: an amendment may apply only under conditions (e.g. "for reports received on or after <date>", "until it is in Wrenfield", a specific payer/location). Check the request's facts against those conditions: if they are not met, the original rule applies unchanged.
{('Other workflow rules on file (titles only): ' + chr(10) + other_wf) if other_wf else ''}

Absence of evidence is not evidence: if you cannot find the patient/record the request is about, skip — never answer NEW/0/none because something was not found unless you actually opened the right complete list.

When done call answer(answer, confidence, why) — confidence is your honest probability that the answer is exactly right — or skip(reason)."""


def solver_user(text, route, ctx):
    return f"REQUEST:\n{text}\n\nPRE-FETCHED DATA (decoded page text; links shown as <path>):\n{ctx or '(none)'}"


VERIFY_SYS = """You are a meticulous auditor at a medical group's back office. A colleague gathered the records below to answer a request. Using ONLY these records and the rules, work out the correct answer yourself, step by step, then output JSON {"answer": "<exact final answer string in the required format>", "confidence": <0-1>, "why": "<one or two sentences>"}. If the records needed by the rule are missing from what was gathered (e.g. a list that was not fully opened), set answer to "" and confidence to 0. Do not refuse over incidental oddities that the rule does not mention (e.g. a document whose body names someone else): answer the question as asked from the records."""


def verify_user(text, rule, notes, evidence):
    return (f"RULE (follow exactly):\n{rule or '(no special rule; answer the question from the records; plain value only)'}\n\n"
            f"STAFF NOTES / AMENDMENTS received later, in order (a later one overrides an earlier one on the same subject; an amendment that applies only under a condition, e.g. 'received on or after <date>', changes nothing when the condition is not met):\n{notes}\n\n"
            f"REQUEST:\n{text}\n\nRECORDS GATHERED:\n{evidence}")
