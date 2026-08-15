---
name: review-and-fix
description: Review uncommitted changes with the review agent, then have the code agent fix the findings
---

## Phase: Review

- agent: review · name: review · prompt: Review the uncommitted changes in this repository for bugs, correctness issues, and code-quality problems. Focus areas (if given): {input}\n\nReport findings by severity with file paths and line numbers, and state clearly which findings are worth fixing now versus later.

## Phase: Fix

- agent: code · name: fix · prompt: Fix the actionable findings from this review of the uncommitted changes:\n\n{review.result}\n\nFix the critical and high-severity items with minimal, focused edits. Do not refactor beyond the findings. Re-run relevant checks when done and summarize what you changed and what you deliberately left alone.
