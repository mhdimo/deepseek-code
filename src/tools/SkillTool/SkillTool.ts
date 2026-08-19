







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

// The skill listing does a synchronous readdir + SKILL.md scan across
// project/user/bundled skill dirs — it used to run at MODULE LOAD, before
// the first frame painted. Defer it: the tool definition is only needed
// when a session is built (first message), and listSkills/getSkill stay
// cached by skillService.
let skillDescription: string | null = null;
function getSkillDescription(): string {
  if (skillDescription === null) {
    skillDescription = buildSkillToolDescription(DESCRIPTION_PREFIX);
  }
  return skillDescription;
}

export const SkillTool = buildTool({
  name: SKILL_TOOL_NAME,
  
  
  
  
  description: getSkillDescription,
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
