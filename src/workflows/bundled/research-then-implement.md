---
name: research-then-implement
description: Research a change with parallel read-only agents, implement it, then review the result
---

## Phase: Research

- agent: plan · name: map · desc: map the relevant architecture · prompt: Analyze this codebase and map out the architecture and key files relevant to the following task. Report file paths and a short summary of how the pieces fit together. Task: {input}
- agent: plan · name: risks · desc: find pitfalls and constraints · prompt: Investigate this codebase for constraints, pitfalls, and existing patterns that an implementer must respect for the following task (tests, conventions, error handling, dependencies). Task: {input}

## Phase: Implement

- agent: code · name: implement · prompt: Implement the following task. Architecture map from the research phase:\n\n{map.result}\n\nConstraints and pitfalls:\n\n{risks.result}\n\nTask: {input}\n\nFollow the constraints above, keep changes minimal, and run relevant checks when done.

## Phase: Review

- agent: review · name: review · prompt: Review the most recent uncommitted changes in this repository. They were made to fulfill this task: {input}\n\nCheck correctness, edge cases, and consistency with the constraints described in:\n\n{risks.result}\n\nReport findings by severity; say clearly if the change looks complete.
