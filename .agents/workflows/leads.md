---
name: leads
description: End-to-end lead pull. Usage — /leads Indore dentist
---

# /leads — pull a scored lead list

Input is free-form. All of these are valid:

```
/leads Indore dentist
/leads Bhopal ke interior designers
/leads Pithampur factory owners, only 4+ rating
/leads Guna, dental clinic aur orthodontist dono
```

Execute these steps in order. Do not skip step 1 or 2.

---

## Step 1 — Parse and confirm

Extract from the operator's message:

- `city` (required)
- `category` (required)
- optional filters: minimum rating, minimum reviews, max results

If either city or category is ambiguous, ask **once**, with your best guess as
the default, then proceed. Do not ask a series of questions.

Echo back one line before doing anything else:

> `Indore · dentist · 96 queries planned · est. 5-6 hrs · starting`

---

## Step 2 — Extend the config if needed

Read `config/localities.json` and `config/categories.json`.

**If the city is missing:** add it with 15–25 real neighbourhood / locality
names. Use commercial and residential areas where this business type would
actually exist — not administrative wards. For a tier-2 Indian city, include
the main market area, 3–5 major residential colonies, the bypass/highway
commercial strip, and any well-known landmark areas.

**If the category is missing:** add it with 4–8 search-term synonyms as people
actually search them. For `dentist` that's dentist, dental clinic, dental
hospital, orthodontist, dental surgeon, implant clinic.

Tell the operator exactly what you added in one line. These entries are
permanent — the next run reuses them.

---

## Step 3 — Run the pipeline

```bash
npm run pipeline -- --city="<city>" --category="<category>"
```

This runs scrape → score → report and writes `output/<runId>/`.

Monitor the terminal. Do **not** open the browser tool to watch it.

**Interrupt and report to the operator immediately if:**
- 3 consecutive queries return 0 results (block or broken selectors)
- A CAPTCHA appears in the log
- The error rate exceeds 20% of attempted records

Otherwise let it finish. It takes hours. That is expected and fine.

---

## Step 4 — Report

Read `output/<runId>/REPORT.md` and give the operator the summary block defined
in `.agents/rules/00-mission.md`, plus the top 5 leads.

Point them at:
- `output/<runId>/leads.csv` — full scored list
- `output/<runId>/tier-a.csv` — today's call list

Do not paste the full list into chat.

---

## Step 5 — If it failed

If the run produced fewer than 50 records for a city that should obviously have
hundreds, do not retry blindly. Run `/verify-selectors` and report what broke.
