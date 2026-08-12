---
name: debugging
description: Debug a bug or test failure with a root-cause workflow — reproduce, isolate, hypothesize, fix, then verify — instead of guessing at fixes.
---

# Debugging

Use this skill when the user reports a bug, a failing test, or unexpected
behavior. Follow the workflow below rather than jumping to fixes.

## Workflow

### 1. Reproduce
- Get the exact failing input and the exact expected vs. actual behavior.
- Reproduce the failure yourself (run the failing command or test) before
  changing anything.
- Note the environment: OS, versions, and configuration that matter.

### 2. Isolate
- Find the smallest case that still fails: reduce the input, disable
  unrelated features, bisect recent changes (`git bisect` if useful).
- Read the relevant code before theorizing — never guess from the symptom.

### 3. Hypothesize
- State one hypothesis: "X fails because Y" — with a mechanism, not a vibe.
- Pick the check that would most strongly confirm or refute it (a targeted
  log, a probe, a minimal test) and run it before fixing anything.

### 4. Fix
- Make the smallest change that addresses the root cause. Do not paper over
  the symptom.
- If the evidence points elsewhere than expected, return to step 3.

### 5. Verify
- Re-run the original failing case; it must pass.
- Run related tests to confirm no regression.
- Add a regression test that would have caught this bug.

## Anti-patterns to avoid

- Changing code before reproducing the failure
- Fixing symptoms (e.g. extra null-checks everywhere) instead of the cause
- Untested "obvious" one-line fixes in unfamiliar code
- Restarting or clearing state as the answer without explaining why it worked
