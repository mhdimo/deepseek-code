import { loadSettings, saveSettings } from "../../state/storage.js";
import type { AgentColorName, TeamConfig } from "../../types/index.js";
import { AGENT_COLORS, isAgentColor } from "../agents/agentColorManager.js";

/**
 * Team registry — the backing service for /teams (Claude Code team context
 * parity). Teams persist in settings; teammates are built-in or discovered
 * agent names with round-robin color assignment.
 */

export function listTeams(): TeamConfig[] {
  return loadSettings().teams ?? [];
}

export function getTeam(name: string): TeamConfig | undefined {
  return listTeams().find((t) => t.name === name);
}

function saveTeams(teams: TeamConfig[]): void {
  saveSettings({ ...loadSettings(), teams });
}

function saveTeam(team: TeamConfig): void {
  const teams = listTeams();
  const idx = teams.findIndex((t) => t.name === team.name);
  if (idx >= 0) teams[idx] = team;
  else teams.push(team);
  saveTeams(teams);
}

export function createTeam(name: string, description?: string): TeamConfig | null {
  const trimmed = name.trim();
  if (!trimmed || /^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(trimmed) === false) return null;
  if (getTeam(trimmed)) return null;
  const team: TeamConfig = { name: trimmed, description, teammates: [], colors: {} };
  saveTeam(team);
  return team;
}

export function deleteTeam(name: string): void {
  saveTeams(listTeams().filter((t) => t.name !== name));
}

export function setTeamDescription(name: string, description: string): void {
  const team = getTeam(name);
  if (!team) return;
  team.description = description;
  saveTeam(team);
}

/** First AGENT_COLORS entry not yet used by the team. */
export function nextFreeColor(team: TeamConfig): AgentColorName {
  const used = new Set(Object.values(team.colors));
  return AGENT_COLORS.find((c) => !used.has(c)) ?? AGENT_COLORS[0]!;
}

export function addTeammate(teamName: string, agentName: string): TeamConfig | undefined {
  const team = getTeam(teamName);
  if (!team || team.teammates.includes(agentName)) return team;
  team.teammates = [...team.teammates, agentName];
  team.colors[agentName] = nextFreeColor(team);
  saveTeam(team);
  return team;
}

export function removeTeammate(teamName: string, agentName: string): TeamConfig | undefined {
  const team = getTeam(teamName);
  if (!team) return team;
  team.teammates = team.teammates.filter((n) => n !== agentName);
  delete team.colors[agentName];
  saveTeam(team);
  return team;
}

export function setTeammateColor(
  teamName: string,
  agentName: string,
  color: AgentColorName | undefined,
): TeamConfig | undefined {
  const team = getTeam(teamName);
  if (!team || !team.teammates.includes(agentName)) return team;
  if (color) team.colors[agentName] = color;
  else delete team.colors[agentName];
  saveTeam(team);
  return team;
}

/** The color assigned to an agent by ANY team (first match wins). */
export function colorForAgent(agentName: string): AgentColorName | undefined {
  for (const team of listTeams()) {
    const color = team.colors[agentName];
    if (color && isAgentColor(color)) return color;
  }
  return undefined;
}

/** The team an agent belongs to (first match wins). */
export function teamForAgent(agentName: string): TeamConfig | undefined {
  return listTeams().find((t) => t.teammates.includes(agentName));
}

