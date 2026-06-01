---
name: health-heal
description: Generate the healing plan, present each fix with its risk and safety gates, get explicit approval, then run only the approved fixes.
argument-hint: ""
user-invocable: true
---

# health-heal

## When to use
Use this when the user wants to act on the latest report by running automated fixes. Healing is safety-gated and **never runs without explicit human approval of specific items**.

## Steps
1. Generate the advisory plan (read-only):
   ```
   npx tsx ${CLAUDE_PLUGIN_ROOT}/src/cli.ts plan
   ```
2. Present each plan item to the user with its index, what it would do, its fix type, and its risk. Note the safety gates that apply:
   - Healing only runs if `healing.enabled` is true.
   - Each item's fix type must be in `healing.allowedFixTypes`.
   - No more than `healing.maxPerRun` fixes execute per run.
   - `healing.dryRun` simulates without changing anything.
   - `manual` and `github_issue` fix types are **not** auto-executable — flag these as human work.
3. Ask which indices the user approves. **Do not pick for them; wait for explicit approval.**
4. Run only the approved items:
   ```
   npx tsx ${CLAUDE_PLUGIN_ROOT}/src/cli.ts heal --approve <comma-separated indices>
   ```
   Use `--approve all` only if the user explicitly says to run everything.
5. Report executed vs skipped, with the outcome and reason for each.

## What to tell the user
- Exactly which fixes ran, which were skipped, and why (gate, not approved, over `maxPerRun`, etc.).
- If gates blocked something they wanted, point them to `/health-configure` to adjust `healing.*`.
