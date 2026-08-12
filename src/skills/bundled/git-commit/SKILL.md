---
name: git-commit
description: Author a Conventional Commits message for the current changes — inspect the actual diff first, then write a type-scoped summary with a body when needed.
---

# Git Commit

Use this skill when the user asks to commit changes, write a commit message,
or amend the last commit. Always inspect the actual diff before writing.

## Process

1. Run `git status` and `git diff` (staged and unstaged) to see what changed.
2. Summarize the changes in your own words before drafting the message.
3. Draft a message following Conventional Commits (below).
4. Commit directly only if the user asked to; otherwise confirm the message
   with the user first.

## Conventional Commits format

    <type>(<scope>): <summary>

    <body>

- `type` (required): one of `feat`, `fix`, `refactor`, `perf`, `docs`,
  `test`, `build`, `ci`, `chore`, `revert`, `style`
- `scope` (optional): the area changed, e.g. `tools`, `ui`, `api`
- `summary`: imperative mood, lowercase, no trailing period, under 50 chars
- `body` (optional): the why, not just the what — include trade-offs,
  migration notes, or linked issues (`Fixes #123`)

## Rules

- One logical change per commit; split unrelated changes into separate commits.
- Summary <= 50 chars; body lines <= 72 chars.
- Never put internal process details (e.g. "as requested") in the message.
- If the working tree is incomplete, say so and suggest a `feat`/`fix` type
  once the work is finished instead of committing a half-done state.

## Example

    feat(tools): add SkillTool for model-invokable skills

    Embed the available-skill listing in the tool description so the model
    can discover and invoke skills autonomously. Fixes #42.
