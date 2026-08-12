---
name: code-review
description: Run a systematic code review of a diff or pull request, checking for correctness bugs, security issues, and style problems before they ship.
---

# Code Review

Use this skill whenever the user asks you to review code, a diff, or a pull
request. Work through the checklist in order and report findings as a
prioritized list.

## Process

1. Read the diff or changed files first. For a PR, inspect the full diff,
   not just the summary.
2. For each changed file, read the surrounding context so you understand
   intent, not just the patch.
3. Work through the checklist below, then write up your findings.

## Checklist

### Correctness
- Does the change do what the commit/PR message claims?
- Edge cases handled? (empty input, missing keys, off-by-one, null/undefined)
- Error paths: do failures surface clearly instead of being swallowed?
- Shared state mutated safely? (races, reentrancy, locking)
- Resources (files, handles, timers, subscriptions) cleaned up on all paths?
- Regression risk: does it change behavior for existing callers?

### Security
- Input validated and sanitized? (path traversal, injection, shell quoting)
- No secrets or sensitive data logged or committed?
- Permissions checked at the right layer?

### Style and maintainability
- Clear naming; no dead code or commented-out blocks.
- Follows the project's existing conventions.
- Tests added or updated for behavior changes.

## Reporting

Report findings most-severe-first, each with: file:line, what is wrong, why
it matters, and a concrete fix. Separate "must fix" from "nice to have".
