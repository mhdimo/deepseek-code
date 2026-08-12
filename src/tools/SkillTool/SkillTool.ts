// SkillTool — model-invokable skills
//
// The DESCRIPTION embeds the listing of available skills (name + description)
// so the model can discover skills autonomously. Invoking the tool with a
// skill name returns the skill's full instructions (SKILL.md body with
// frontmatter stripped). Read-only and concurrency-safe — it only reads
// skill files.

import { z } from "zod";
import { buildTool, type ToolUseContext, type ToolResult } from "../../Tool.js";
import {
  buildSkillToolDescription,
  getSkill,
  listSkills,
} from "../../skills/skillService.js";
import { SKILL_TOOL_NAME, DESCRIPTION_PREFIX } from "./prompt.js";

const inputSchema = z.object({
  name: z.string().describe("The exact name of the skill to invoke"),
}) satisfies z.ZodType;

export const SkillTool = buildTool({
  name: SKILL_TOOL_NAME,
  // toolsToBindingFormat reads `description` synchronously at binding time, so
  // the skill listing is embedded once at module load (skills are discovered
  // at startup). Install new skills and restart, or call clearSkillsCache()
  // and re-register tools, to refresh the listing.
  description: buildSkillToolDescription(DESCRIPTION_PREFIX),
  inputSchema,

  async call(
    args: z.infer<typeof inputSchema>,
    _context: ToolUseContext,
  ): Promise<ToolResult<string>> {
    const skill = getSkill(args.name);
    if (!skill) {
      const available = listSkills().map((s) => s.name).join(", ");
      return {
        data: `Unknown skill: "${args.name.trim()}". Available skills: ${
          available || "(none)"
        }`,
      };
    }
    return { data: skill.content };
  },

  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  userFacingName: (input: z.infer<typeof inputSchema>) =>
    `Use skill ${input.name}`,
}) satisfies import("../../Tool.js").Tool;
