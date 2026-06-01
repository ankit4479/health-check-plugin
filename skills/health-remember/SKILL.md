---
name: health-remember
description: Record a short build-time learning about this project's health-check setup into .health-check/notes.md.
argument-hint: "<the learning to record>"
user-invocable: true
---

# health-remember

## When to use
Optional. Use it to capture a durable note about how health-check is set up for **this** project — a gotcha, a why-we-did-it-this-way, a quirk of a collector or data source — so future sessions don't relearn it.

## Steps
1. Take the learning from the user's argument (or ask for one if none was given). Keep it to a sentence or two.
2. Append it to `.health-check/notes.md` in the project root, creating the `.health-check/` directory and the file if they don't exist. Add a short dated bullet; don't rewrite existing notes.

## What to tell the user
- Confirm what was recorded and where (`.health-check/notes.md`).
- Keep entries short and specific — this is a scratch log of setup learnings, not documentation.
