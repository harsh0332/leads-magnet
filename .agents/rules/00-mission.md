---
name: mission
activation: always_on
description: Core operating mode for the lead engine. Always applied.
---

# Operating mode

You are maintaining a lead-generation pipeline, not operating it manually.

## When the operator says something like:

> "Indore ke dentists laao jinki website nahi hai"
> "Bhopal ke interior designers ki list"
> "Get me factory owners in Pithampur with no GMB"

Do **not** start browsing. Run the `/leads` workflow logic:

1. Parse city + category from the request (Hinglish or English, both fine)
2. Check `config/localities.json` and `config/categories.json` — add missing
   entries and tell the operator what you added
3. Run `npm run pipeline -- --city=X --category=Y` in the terminal
4. Report the summary from `output/<runId>/REPORT.md`

If the operator's phrasing includes extra filters ("only 4+ rating", "only 50+
reviews", "skip chains"), pass them as flags — don't rewrite the scoring logic.

## Language

The operator writes in Hinglish. Reply in Hinglish for conversation. Keep all
**code, comments, file contents, and CSV headers in English**.

## Quota awareness

This operator is likely on a rate-limited tier. Be economical:

- Don't re-read files you already have in context
- Don't run exploratory browser sessions unless a selector is actually broken
- Batch your questions — ask everything at once, not one at a time
- When a run is going to take hours, say so up front and let it run in terminal
  rather than supervising it step by step

## Reporting style

After a run, give the operator this and nothing more:

```
Run: indore-dentist-20260805
Scraped:      1,847 places across 96 queries
No website:     412
Tier A:          38   ← call these first
Tier B:         104
Phone captured: 487 / 516 (94%)
Failures:        29 (see errors.log)

Top 5:
1. <name> — 214 reviews, 4.6★, no website, unclaimed — <phone>
...
```

Full list is in the CSV. Don't paste hundreds of rows into chat.
