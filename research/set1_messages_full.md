

========== ITEM 1 (message)
From the nurse manager: what happens to a lab report when it comes in

When you're asked what to do with a lab report, decide it with the steps below. The choices are to call the provider right away, to have a nurse review it, or to release it to the patient. Go by our own limits in the table at the end, not by the reference range or the high and low flags the lab prints on the report.

A request names the patient, the panel, and the date the report was received into the chart. A report that was filed twice is in the chart twice, and each copy has its own received date.

## Panels this rule covers

Complete blood count, Basic metabolic panel, Thyroid panel. For a report of any other panel, answer `NOT_COVERED`.

## Critical results

A result is critical when it is below the low critical limit or above the high critical limit for that test. A result exactly at a limit is not critical.

If anything on the report is critical, answer `CALL_PROVIDER_NOW:` followed by the name of every critical test as the report prints it, in alphabetical order, separated by commas, for example `CALL_PROVIDER_NOW:Potassium,Sodium`. Nothing else on the report matters then.

## Review items

If nothing is critical, count the review items. A test is one review item if it is out of range, fails the change rule, or both. One or more review items is `NURSE_REVIEW:<n>`, for example `NURSE_REVIEW:2`. None is `RELEASE`.

**Out of range** means below the low end or above the high end of the review range. A result exactly on an end is in range. Some ranges depend on the patient:

- Sex is the sex on the chart. If it is neither Female nor Male, a result is in range when it is inside either the female range or the male range.
- Age is the patient's age in whole years on the date the sample was collected, as printed on the report. A patient born on February 29 turns a year older on March 1 in years without a February 29.
- Type 2 diabetes mellitus counts when it is on the problem list, whatever its onset date.

**The change rule** applies only to the tests that have one in the table. Compare the result with the same test on the previous report. The change is the difference between the two, as a percentage of the previous result. More than the table's percentage is a review item, even when the result is in range. Exactly the percentage is not. For Hemoglobin (more than 15%) with a previous result of 12.0, a result of 13.8 is a change of exactly 15% and is not a review item. A result of 13.9 is.

## The previous report

- Use only reports that print this chart's record number. A report in the chart that prints a different record number is ignored, both as the report asked about and as a previous report.
- Each report prints a report number. Two copies in the chart with the same report number are the same report filed twice. The second copy is not a previous report.
- The previous report is the other report of the same panel with the latest collected date before this report's collected date. If two have that date, take the one with the higher report number. The received date plays no part in this.
- Use the previous report for the change rule only if it was collected within the 12 months before this report. For a report collected on 2026-05-10, that means collected on 2025-05-10 or later. For a report collected on February 29, the same date a year earlier is February 28. If the previous report is older than that, or there is none, no test fails the change rule.

## Table

Results, ranges, and limits are in the units the report prints.

**Complete blood count**

| Test | Unit | Review range | Critical when | Change rule |
|---|---|---|---|---|
| White blood cell count | 10^3/uL | 4.0 to 11.0 | below 2.0 or above 30.0 | none |
| Hemoglobin | g/dL | Female: 12.0 to 15.5. Male: 13.5 to 17.5 | below 7.0 or above 20.0 | more than 15% |
| Hematocrit | % | Female: 36.0 to 46.0. Male: 41.0 to 53.0 | below 21.0 or above 60.0 | none |
| Platelet count | 10^3/uL | 150 to 400 | below 50 or above 1000 | more than 30% |

**Basic metabolic panel**

| Test | Unit | Review range | Critical when | Change rule |
|---|---|---|---|---|
| Sodium | mmol/L | 135 to 145 | below 120 or above 160 | none |
| Potassium | mmol/L | 3.5 to 5.1 | below 2.8 or above 6.2 | none |
| Chloride | mmol/L | 98 to 107 | none | none |
| Carbon dioxide | mmol/L | 22 to 29 | below 10 or above 40 | none |
| Blood urea nitrogen | mg/dL | Age under 65: 7 to 20. Age 65 or over: 8 to 26 | above 100 | none |
| Creatinine | mg/dL | Female: 0.50 to 1.10. Male: 0.70 to 1.30 | above 5.00 | more than 25% |
| Glucose | mg/dL | 70 to 99. With Type 2 diabetes mellitus on the problem list: 70 to 180 | below 50 or above 400 | none |
| Calcium | mg/dL | 8.6 to 10.2 | below 6.5 or above 13.0 | none |

**Thyroid panel**

| Test | Unit | Review range | Critical when | Change rule |
|---|---|---|---|---|
| Thyroid stimulating hormone | mIU/L | Age under 65: 0.40 to 4.50. Age 65 or over: 0.40 to 6.00 | none | none |
| Free T4 | ng/dL | 0.80 to 1.80 | none | none |

## Example

If someone asks: "What happens to the Basic metabolic panel lab report for Nancy Oliver (born 2011-04-19), received 2025-11-08?"

The answer is `NURSE_REVIEW:1`.

The report was collected on 2025-11-04. The patient was 14 on that date, and the problem list does not have Type 2 diabetes mellitus. There is no earlier report of this panel, so no test fails the change rule. Sodium 145: in range. Potassium 5.0: in range. Chloride 98: in range. Carbon dioxide 23: in range. Blood urea nitrogen 17: in range. Creatinine 1.17: out of range. Glucose 85: in range. Calcium 9.7: in range.



========== ITEM 5 (message)
Expect about 40 lab reports to triage in what's left of today.


========== ITEM 16 (message)
Second-floor copier is working again. Toner is in the supply closet.


========== ITEM 30 (message)
From the urgent care charge nurse: tetanus checks for wound visits

For every wound we see, the patient needs a tetanus vaccine, a tetanus vaccine plus tetanus immune globulin (TIG), or neither. We go by the CDC wound management table, applied the way it's written here. You'll be asked what a patient should have had at a wound visit, with the patient and the date of the visit. The answer is what they should have had, whatever was actually given.

## How to answer

`<ACTION>:<count>:<last>`, where:

- `ACTION` is `VACCINE`, `VACCINE_AND_TIG`, or `NONE`.
- `count` is the number of documented tetanus doses the patient had before the day of the visit.
- `last` is the date of the most recent of those doses as YYYY-MM-DD, or `NONE` if the count is 0.

For example: `VACCINE:2:2019-05-03`, `NONE:5:2021-08-14`, `VACCINE_AND_TIG:0:NONE`.

## Was there a wound visit?

Every wound visit has a triage note written that day whose text starts with `Triage:`. If the chart has no such note on that date, there was no wound visit, and the answer is `NO_WOUND_VISIT`. Only the triage note decides this: an appointment, a visit, or a vaccine entry on that date doesn't make it a wound visit, and neither does a phone call note that mentions a triage nurse.

## The decision

| Documented tetanus doses before the visit | Clean and minor wound | Any other wound |
|---|---|---|
| 0, 1, or 2 | `VACCINE` | `VACCINE_AND_TIG` |
| 3 or more | `VACCINE` if the last dose was 10 or more years before the visit, otherwise `NONE` | `VACCINE` if the last dose was 5 or more years before the visit, otherwise `NONE` |

For the years, count back to the same month and day that many years before the visit. A last dose on that date or earlier is that many years old. For a visit on 2026-05-10, a last dose on 2016-05-10 is 10 years old and one on 2016-05-11 is not. A last dose on 2021-05-10 is 5 years old and one on 2021-05-11 is not. If the visit is on February 29, count back to March 1 of the earlier year.

## Clean and minor, or any other wound

Go by the triage note. The wound is clean and minor unless the note says the wound treated at this visit is:

- Contaminated with dirt, soil, feces, or saliva. A bite, from an animal or a person, has saliva in it.
- A puncture wound.
- An avulsion, where skin is torn away.
- A missile wound: a bullet, a pellet, or shrapnel.
- A crush injury.
- A burn.
- Frostbite.

When one of these applies, the note says so in plain words, and nothing else makes it "any other wound". A cut from a knife, glass, paper, or a razor, or a scrape, with nothing in it, is clean and minor however long or deep it is. A sentence that rules something out, such as "No dirt, soil, or saliva in the wound" or "Not a puncture and not a bite", describes a clean wound. Ignore what the note says about someone else's wound, or about an earlier wound of the patient's that has healed.

## Counting documented tetanus doses

A documented dose is a record that a tetanus vaccine was given on a stated date. Use records from every location in the group. Three kinds count, and nothing else in the chart does:

1. **Immunization entries in the chart.** Every entry counts except one marked "Entered in error", whether it says the dose was given at one of our locations or "Given elsewhere, from the patient's records".
2. **Outside immunization records**: documents printed by another clinic or a health department, usually scanned, filed with the type "Immunization record". Their titles start with "Immunization record:" and the name of the place that printed them. Every date printed for a tetanus vaccine is a dose. A document of any other type, such as a discharge summary or a referral letter, is not a record of a dose.
3. **Our own notes of a tetanus vaccine given here** at a visit, with its lot number. For example: "Td (Tenivac) given today in the left deltoid, lot number TK4471D." The dose date is the date of the note.

Some patients have a second chart that was opened by mistake and later merged into the main one. Whatever was filed under the duplicate (immunization entries, notes, documents) shows in the main chart with nothing to set it apart, and counts like the rest.

These are not documented doses:

- What the patient says about past shots, such as "thinks the last tetanus shot was about 6 years ago" or "says the tetanus shots are up to date".
- A note that a vaccine was offered, discussed, declined, or ordered but not given, or that a letter about a vaccine lot was mailed.
- A note about a vaccine that another clinic or a pharmacy gave.

When you count:

- Count only doses given before the visit date. A dose given on the day of the visit (usually the shot for this wound) does not count, and neither does anything given later.
- All records of a tetanus vaccine with the same date are one dose. The same dose often appears more than once: in the chart and on an outside record, on an outside record filed twice, repeated on a merged record, in a note and a chart entry for the same visit, or under two different names.
- Count every documented dose, whatever the patient's age at the time and however close together the doses were.

### Dates on outside records

Near the top of each outside record, under Sex, "Dates written" says how it writes dates: `YYYY-MM-DD`, `MM/DD/YYYY`, `DD.MM.YYYY`, or day month year (as in `14 Mar 2021`).

Some records list one dose per row. Others are a grid, with a row for each vaccine and its doses side by side under Dose 1, Dose 2, and so on. In a grid, later dates in a row can be printed without the year (`05/16`, `16.05.`, `16 May`). Such a date is the first date with that month and day after the date before it in the same row. A row reading `03/14/2019`, `05/16`, `11/02`, `01/15` means 2019-03-14, 2019-05-16, 2019-11-02, and 2020-01-15.

### Which vaccines are tetanus vaccines

A record is of a tetanus vaccine if it names one of these. The first column is the name the chart's entries use, the second is the name an outside record prints.

| Name in the chart | Name on an outside record |
|---|---|
| DTaP (Daptacel) | Daptacel |
| DTaP (Infanrix) | Infanrix |
| DTaP-HepB-IPV (Pediarix) | Pediarix |
| DTaP-IPV/Hib (Pentacel) | Pentacel |
| DTaP-IPV-Hib-HepB (Vaxelis) | Vaxelis |
| DTaP-IPV (Kinrix) | Kinrix |
| Tdap (Boostrix) | Boostrix |
| Tdap (Adacel) | Adacel |
| Td (Tenivac) | Tenivac |
| DTaP | DTaP |
| Tdap | Tdap |
| Td | Td |

No other vaccine is a tetanus vaccine. That includes Hib (ActHIB), Hib (PedvaxHIB), IPV (IPOL), HepB (Engerix-B), PCV20 (Prevnar 20), MMR (M-M-R II), Varicella (Varivax), Influenza (Fluzone), Influenza (Flucelvax), Zoster (Shingrix), HPV (Gardasil 9), MenACWY (Menveo), and the same vaccines written without a brand name.

## Example

Request: "Doing chart review on wound visits. Kathryn Lewis, DOB 1998-12-03, came in on 2025-02-08. What was due for tetanus?"

Answer: `VACCINE:4:2013-01-14`

In the chart's Notes section, the triage note on 2025-02-08 says the wound is contaminated with feces. That is on the list, so it counts as any other wound. From the Immunizations section, the outside immunization records in Documents, and the notes of vaccines given here, the documented tetanus doses before the visit date, one per date, are 1999-02-24, 1999-04-24, 1999-06-13, 2013-01-14. That is 4. Not counted: a dose given on the visit date. Going back 5 years from the visit date gives 2020-02-08. The last dose, 2013-01-14, is on or before that date, so it is 5 or more years old: VACCINE. The answer is VACCINE:4:2013-01-14.



========== ITEM 44 (message)
We're working through today's cancellation requests at the front desk, so some appointments on the schedule will be cancelled in the next few minutes.


========== ITEM 62 (message)
From the nurse manager: change to how we handle lab reports

A Basic metabolic panel report is not covered by this rule. Answer NOT_COVERED for it, whatever its results.

Use it for reports received on or after 2026-06-01. Reports received before 2026-06-01 are handled as before.



========== ITEM 76 (message)
From the immunization coordinator: counting the patients to notify about a recalled vaccine lot

When a manufacturer recalls a vaccine lot, we notify every patient we gave a dose from that lot. You will be asked how many patients are left to notify for a recalled lot, and the person asking gives you the lot number. Please work out each of those counts with the rule below.

## Who got a dose from the lot

Doses given at any location of the group count. We gave a patient a dose from the lot if either of these records it:

- An Active chart entry in the patient's record that names the lot.
- A note saying the vaccine was given here at a visit, with this lot as the lot of that dose. Some doses are recorded only in a note like this, with no chart entry.

These are not doses we gave from the lot:

- A chart entry marked Entered in error.
- A chart entry in a test record. A test record is not a patient.
- A note about a dose that another clinic, a pharmacy, or a health department gave, even if it has the same lot number.
- A note about a patient who asked about the recall and whose dose was not from this lot.
- A note about the recall of a different lot that mentions this lot only as the lot shown in the patient's chart.
- A note about a recall letter or notice.

The number of doses we received in the delivery does not matter.

## Count each patient once

A patient is one record number. The same patient can come up more than once: two chart entries, a chart entry and a note for the same dose, or an entry filed under a duplicate record that was later merged into the patient's chart. Count each record number once. A restricted record counts like any other.

## Who has already been notified

A patient has been notified if a note says the recall notice or letter for this lot was mailed to them, sent to them through the patient portal, or handed to them in person.

These are not notifications:

- A note that the letter came back undeliverable or was returned by the post office.
- A note that no letter is needed, or that no letter was sent.

If a patient has a note that the notice was sent and a note that the letter came back, both for this lot, go by the later note.

## How to answer

Give the number of patients who got a dose from the lot and have not been notified, as a whole number. Example: `7`. If the lot is in our inventory and nobody is left to notify, answer `0`. If no location of the group has a lot with that number in its inventory, answer `UNKNOWN_LOT`. A patient who was notified but never got a dose from the lot does not change the count.

## Example

Request: "How many patients are left to notify about the recall of lot M81X24L?"

Answer: `4`

17 patients have an Active chart entry with this lot, and 1 patient has a dose from it recorded only in a note. That is 18 patients who got a dose from the lot. 14 of them have been notified, so 4 are left.



========== ITEM 96 (message)
Did someone borrow the billing office's label printer? They need it back by the end of the day.


========== ITEM 118 (message)
Expect about 40 claims to work after a remittance in what's left of today.


========== ITEM 120 (message)
From the billing supervisor: working a claim after its remittance

When a remittance comes back on a claim, the claim needs a next step. Pick it with the rule below. The request names the patient and the claim's date of service. Today is 2026-10-14.

The answer is one of these:

| Answer | When |
|---|---|
| `AWAIT_PAYER` | The payer has not given a final answer yet |
| `NO_ACTION` | Paid, and the patient owes nothing |
| `BILL_PATIENT:<amount>` | Paid, and the patient owes this amount |
| `BILL_OTHER:<plan>` | Denied because another plan should pay, and we know which one |
| `CONTACT_PATIENT` | Denied because another plan should pay, and we have no plan on record that covered the patient |
| `RESUBMIT:<field>` | Denied for missing information, and the payer said which field |
| `CALL_PAYER` | Denied for missing information, and the payer did not say which field |
| `APPEAL:<last day to appeal>` | Denied, and we have grounds and time to appeal |
| `WRITE_OFF:<amount>` | Denied, and we cannot appeal |

Write amounts in dollars with two decimals and no dollar sign or thousands separator (`45.00`, `1250.50`), and dates as `YYYY-MM-DD`. Examples: `BILL_PATIENT:45.00`, `APPEAL:2026-11-07`, `WRITE_OFF:160.00`.

A claim filed under a duplicate record that was later merged into the patient's chart is the patient's claim like any other. The authorizations filed under both records count for it.

## Start from the current remittance

A remittance is the payer's answer on a claim: what it allowed, paid, and adjusted on each line. A remittance is either a payment or the reversal of an earlier payment. A reversal is the payer taking a payment back.

Work the claim from its current remittance: of the payments on the claim that have not been reversed, the one with the latest payment date. A reversal is never the current remittance. Use only the lines of the current remittance for this claim. One remittance can pay several claims. Earlier remittances play no part, even when they show a different outcome. The lines of a paper remittance that was scanned count the same as keyed lines.

If no remittance has been received for the claim, or every payment on it has been reversed, the payer has not given a final answer: `AWAIT_PAYER`.

## Reading a remittance line

A line has adjustments. An adjustment is a group code, a reason code, and an amount, written like `CO-45 47.60`. A line can have several adjustments and can also carry remark codes.

The group code says who carries the amount. `CO` (contractual obligation) is ours to absorb and can never be billed to the patient. `PR` (patient responsibility) is the patient's.

The reason codes, with their standard X12 meanings:

| Reason | Meaning |
|---|---|
| 1 | Deductible amount. |
| 2 | Coinsurance amount. |
| 3 | Co-payment amount. |
| 16 | Claim/service lacks information or has submission/billing error(s). At least one remark code must be provided. |
| 22 | This care may be covered by another payer per coordination of benefits. |
| 29 | The time limit for filing has expired. |
| 45 | Charge exceeds fee schedule/maximum allowable or contracted/legislated fee arrangement. |
| 97 | The benefit for this service is included in the payment/allowance for another service/procedure that has already been adjudicated. |
| 197 | Precertification/authorization/notification/pre-treatment absent. |

A line is denied when it has an adjustment with group `CO` and reason 16, 22, 29, 97, or 197. `CO-45` is not a denial. It is the normal write-down to the contracted rate on a line that was paid, and it is never part of any amount in this rule.

## Nothing denied

If none of the claim's lines on the current remittance is denied, the claim was paid. Add up the `PR` adjustments with reason 1, 2, or 3 on the claim's lines. If they come to more than zero, bill the patient for that total, however small: `BILL_PATIENT:<total>`. If they come to zero: `NO_ACTION`.

## Something denied

A claim can be denied for more than one reason across its lines. Work it by one reason only, the one that comes first in this order: 29, 22, 16, 197, 97. Leave the denials with the other reasons alone.

The denied amount is the total of the `CO` adjustments with that one reason, across the claim's lines. Denials with other reasons, `CO-45`, and `PR` amounts are not part of it. A write-off is always for the denied amount.

**Reason 29, filed too late.** The payer's contract says how many days after the date of service it accepts claims. The last day to file is the date of service plus that many days: with 90 days, a service on 2026-06-01 had to be filed by 2026-08-30. We can prove timely filing if one of the claim's submissions was accepted by the payer with a result date on or before that last day. A submission the clearinghouse rejected never counts. With proof, appeal (see Appeals). Without it: `WRITE_OFF:<denied amount>`.

**Reason 22, another plan should pay.** Read the account notes on the claim. Only the most recent note that says anything about the patient's other insurance counts. It replaces whatever earlier notes said. If that note names a plan that covered the patient on the date of service, bill that plan: `BILL_OTHER:<plan>`, with the plan name as the note writes it and without the payer's name. A note that says "Silver 3500 from Tallgrass Health Plan" gives `BILL_OTHER:Silver 3500`. Otherwise: `CONTACT_PATIENT`. That covers a claim with no note about other insurance, a note saying the patient has none, a plan that belongs to someone else and does not cover the patient, and a plan that ended before the date of service.

**Reason 16, information missing.** Look at the remark codes on the lines denied with reason 16. Go down this table from the top and stop at the first remark code that appears on any of those lines: `RESUBMIT:<field>`.

| Remark code | Meaning | Field |
|---|---|---|
| N290 | Missing/incomplete/invalid rendering provider primary identifier. | `RENDERING_PROVIDER_ID` |
| N286 | Missing/incomplete/invalid referring provider primary identifier. | `REFERRING_PROVIDER_ID` |
| N382 | Missing/incomplete/invalid patient identifier. | `MEMBER_ID` |
| M51 | Missing/incomplete/invalid procedure code(s). | `PROCEDURE_CODE` |
| M76 | Missing/incomplete/invalid diagnosis or condition. | `DIAGNOSIS` |
| M77 | Missing/incomplete/invalid/inappropriate place of service. | `PLACE_OF_SERVICE` |

Remark code MA130 only says the claim was unprocessable. If none of the codes in the table is on those lines: `CALL_PAYER`.

**Reason 197, no authorization.** An authorization on file for the patient covers a denied line when its payer is the claim's payer, its procedure is the procedure code of the line, and its valid dates include the date of service. The first and last valid days both count. If every line denied with reason 197 is covered, appeal (see Appeals). If even one is not: `WRITE_OFF:<denied amount>`.

**Reason 97, bundled into another service.** The payer may fold the column 2 code of a pair into its payment for the column 1 code:

| Column 1 code | Column 2 code | Indicator |
|---|---|---|
| 17110 | 11102 | 1 |
| 17000 | 11102 | 1 |
| 20610 | 20605 | 1 |
| 12001 | 10060 | 0 |
| 17110 | 11200 | 0 |

A line denied with reason 97 has grounds for appeal only when all three of these are true: its procedure code is the column 2 code of a row with indicator 1, another service line of the same claim as we billed it has that row's column 1 code, and the denied line was billed with modifier 59. Indicator 0 means the two are never paid separately. If every line denied with reason 97 has grounds, appeal (see Appeals). Otherwise: `WRITE_OFF:<denied amount>`.

## Appeals

The payer's contract says how many days it accepts appeals, counted from the payment date of the current remittance. The last day to appeal is that payment date plus that many days: with 120 days, a remittance paid on 2026-07-10 can be appealed through 2026-11-07.

If the last day is today or later, appeal, however small the denied amount: `APPEAL:<last day>`. If the last day has already passed, write the denied amount off: `WRITE_OFF:<denied amount>`.

## Example

If someone asks: "Next step on claim: Coleman, Linda, DOB 1958-09-16, service date 2026-07-06"

The answer is `APPEAL:2026-12-15`.

In the claim page's Remittances panel, the current remittance is CHK4578491, paid on 2026-08-17, with its lines keyed under it. Above it are 2 earlier remittances (a reversed payment and its reversal), which are not used. The claim is denied with reason 197. The denied amount is 190.00. The Authorizations panel has an authorization with the claim's payer for the denied procedure code whose valid dates include the service date, so the denial can be appealed. The payer's contract page gives 120 days under Appeals accepted within, counted from the remittance date, so the last day to appeal is 2026-12-15, which has not passed.



========== ITEM 132 (message)
Northfield Life and Health accepts appeals within 180 days of the remittance date. This isn't in Wrenfield yet. Go by this note until it is.


========== ITEM 150 (message)
From the billing office lead: the last day to file a claim

Payers deny claims that arrive after their filing limit, so before a claim goes out we need to know how long we have. When someone asks for the filing deadline of a claim we haven't sent yet, they'll give you the patient and the date of service. Today is 2026-10-14.

## Which claim they mean

It's the claim with that date of service on the patient's list of claims not yet filed, which you'll find with the insurance information in the chart. The patient will often also have a claim with the same date of service in the Claims area. Everything in the Claims area has already gone to a payer, so it is never the claim being asked about, and nothing on it is used.

Each claim on the not-yet-filed list has a type (Original, Secondary, or Corrected) and the payer it is billed to. A Secondary claim also shows the date the primary payer's remittance arrived, or that it hasn't been received. A Corrected claim shows the date the remittance for the original claim arrived.

## Which filing terms to use

Use the claim filing terms of the payer the claim is billed to. The terms give a limit for an Original claim (in days or in months), one for a Secondary claim (in days), one for a Corrected claim (in days), and the date they took effect. When a payer has more than one set, use the set in effect on the date of service, meaning the one with the latest effective date on or before it. The set in effect today or on a remittance date doesn't matter.

The Claims area also shows, with each payer's contract terms, a number of days within which the payer accepts claims. That is a different figure. Don't use it for this.

Check this first: if the payer had no claim filing terms in effect on the date of service, the answer is `NO_FILING_TERMS`, whatever the type of claim. That includes a Secondary claim still waiting on the primary payer.

## Counting to the last day

| Type | Counted from | Limit |
|---|---|---|
| Original | The date of service | The limit for an Original claim |
| Secondary | The date the primary payer's remittance arrived | The limit for a Secondary claim |
| Corrected | The date the remittance for the original claim arrived | The limit for a Corrected claim |

A Secondary claim whose primary remittance hasn't been received can't go out yet. The answer for it is `AWAITING_PRIMARY`.

For a limit in days, add that many days to the starting date: 90 days from 2026-01-10 is 2026-04-10.

For a limit in months, go to the same day of the month that many months later: 12 months from 2025-11-03 is 2026-11-03. If that month doesn't have that day, use its last day, so 6 months from 2025-08-31 is 2026-02-28.

## Weekends and office holidays

We only file on days the billing office is open. It's closed Saturdays, Sundays, and these holidays: 2025-11-27 (Thanksgiving), 2025-11-28 (Day after Thanksgiving), 2025-12-25 (Christmas Day), 2026-01-01 (New Year's Day), 2026-05-25 (Memorial Day), 2026-07-03 (Independence Day, observed), 2026-09-07 (Labor Day), 2026-11-26 (Thanksgiving), 2026-11-27 (Day after Thanksgiving), 2026-12-24 (Christmas Eve), 2026-12-25 (Christmas Day), 2027-01-01 (New Year's Day), 2027-05-31 (Memorial Day), 2027-07-05 (Independence Day, observed), 2027-09-06 (Labor Day), 2027-11-25 (Thanksgiving), 2027-11-26 (Day after Thanksgiving), 2027-12-24 (Christmas Eve). Use this list, not the clinic calendar. The clinic calendar has the closures of the clinic locations, which aren't the same.

If the day you counted to falls on a day the office is closed, the last day to file is the nearest earlier day it's open. It never moves later.

## How to answer

- If the last day is today or later, give the date as `YYYY-MM-DD`, for example `2026-11-20`.
- If the last day has passed, give `EXPIRED:<days>`, the number of days from the last day to today. A last day of 2026-10-09 checked on 2026-10-14 is `EXPIRED:5`.
- Otherwise `NO_FILING_TERMS` or `AWAITING_PRIMARY`, as above.

## Example

Request: "Davis, Andrea, DOB 2018-12-19, date of service 2026-05-07. We haven't billed this one yet. What's the deadline to file?"

Answer: `2027-05-07`

Under Claims not yet filed in the chart's Insurance section, claim 87827990 is an Original claim for a visit on 2026-05-07, billed to Union Workers Health Fund. In the Claim filing table on the Union Workers Health Fund page in the Payers area, the row in effect on that date is the one effective 2024-01-01. The limit for this claim type is counted from the date of service, 2026-05-07, and 365 days from then is 2027-05-07. The office is open that day, so that is the deadline. Today is 2026-10-14, so the deadline has not passed.



========== ITEM 164 (message)
This is in Wrenfield now: Northfield Life and Health accepts appeals within 180 days of the remittance date.


========== ITEM 176 (message)
Billing is posting this morning's payments now, so some invoice balances will go down soon.


========== ITEM 198 (message)
From the front desk supervisor: when a good faith estimate is due

When a patient isn't using insurance for a scheduled visit, we have to give them a good faith estimate of the charges (No Surprises Act, 45 CFR 149.610). How soon it's due depends on how far ahead the visit was scheduled. Here's the rule, so you can answer when the front desk asks about an appointment. The numbers are as of October 1, 2026.

You'll get the patient and the date and start time of one appointment. The time is on a 24-hour clock in the local time of the appointment's location, so 14:40 is 2:40 PM. It's always a single appointment, never one date of a recurring appointment, and it can be at any of our locations.

## Is insurance paying for the visit?

We owe an estimate when insurance isn't paying, which means either of these:

- The chart has no insurance on file. For this, the insurance the chart itself is registered with (payer, plan, and member ID) decides, and nothing else does. If the chart says no insurance is on file, the patient counts as uninsured for the estimate, even if the chart lists coverage records, authorizations, or claims.
- The chart has insurance on file, but a note in the chart says the patient chose to pay for this visit themselves and insurance isn't to be billed for it. The note has to name the date of this appointment. Any type of note counts (chart note, phone call, or message), whenever it was written.

Otherwise the answer is `NOT_REQUIRED:INSURED` and nothing below applies.

Some notes about paying look similar but don't make the visit self-pay:

- The patient asked about the self-pay price and then decided to use insurance.
- The patient won't self-pay.
- The self-pay is for someone else, such as a family member with their own visit.
- The note names a different date.
- The patient used to be self-pay and insurance is billed now.

## The scheduling date

The scheduling date is the date the appointment was booked. If the start time was moved after booking, it's the date of the most recent move instead. Other changes to the appointment, such as a change of status, don't change the scheduling date. Take these dates in the local time of the appointment's location.

## Business days

A business day is a Monday through Friday when the appointment's location isn't closed. The location is closed on a date when the clinic calendar has an entry for that date with the status Active that applies to all locations or to this one. Entries with the status Withdrawn and closures of other locations don't count.

## The deadline

Count the business days after the scheduling date, up to and including the appointment date. Don't count the scheduling date itself. Count the appointment date if it's a business day.

- 0 to 2 business days: `NOT_REQUIRED:SHORT_NOTICE`.
- 3 to 9 business days: the estimate is due on the first business day after the scheduling date.
- 10 or more business days: it's due on the third business day after the scheduling date.

Booked Monday 2026-03-02 for Thursday 2026-03-05 with no closures: Tuesday, Wednesday, and Thursday make 3 business days, so the estimate is due Tuesday 2026-03-03. If Tuesday 2026-03-03 is an Active closure for that location, only Wednesday and Thursday count, and the answer is `NOT_REQUIRED:SHORT_NOTICE`. Booked Friday 2026-03-06 for Friday 2026-03-20 with no closures: that's 10 business days, so the estimate is due on the third business day after March 6, which is Wednesday 2026-03-11.

The appointment's status (Scheduled, Completed, Cancelled, or anything else) doesn't change the answer, and a due date that has already passed is still the answer.

## How to answer

Give the date the estimate is due as `YYYY-MM-DD`, or `NOT_REQUIRED:INSURED` or `NOT_REQUIRED:SHORT_NOTICE`.

## Example

Request: "Good faith estimate question: Williams, Ann, born 1934-10-19, 11:00 on 2025-04-04. Is one required, and if so, when's it due?"

Answer: `2025-03-19`

The chart's Insurance section says No insurance on file, so we owe an estimate. The appointment's Booking panel shows it was booked on 2025-03-14, and its History has no Start time moved entry, so 2025-03-14 is the scheduling date. From the next day through 2025-04-04, the location has 15 business days, counting Monday through Friday and leaving out the Active closures on the clinic calendar that apply to it. That is 10 or more, so the estimate is due on the third business day after the scheduling date, 2025-03-19.



========== ITEM 212 (message)
Employee health is giving staff flu shots in the break room on Thursday from 7 to 9 am. Bring your badge.
