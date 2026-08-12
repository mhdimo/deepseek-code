export const SKILL_TOOL_NAME = "Skill";

// Static guidance for the SkillTool. The actual tool description appends the
// dynamic listing of available skills (name + description) to this header —
// see buildSkillToolDescription() in src/skills/skillService.ts.
export const DESCRIPTION_PREFIX = `Model-invokable skills: specialized instructions you can load on demand.

When the user's request matches one of the available skills below, invoke this tool with that skill's name BEFORE doing the work, then follow the returned instructions. The listing shows each skill's name and what it does; the full instructions are loaded only when you call the tool.

Rules:
- Check the available skills for a match before answering, but do not force a skill that does not fit the request.
- Call Skill with the exact name from the listing: {"name": "..."}.
- When the user references a "slash command" or "/<something>" (e.g. "/code-review"), that is a skill — invoke it.
- Do not invoke a skill that is already loaded and running.
- If the tool reports an unknown skill, do not retry endless variants — re-read the listing and pick the best match.`;
