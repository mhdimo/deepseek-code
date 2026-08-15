import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { Dialog } from "../../ui/design-system/Dialog.js";
import { Select } from "../../ui/design-system/Select.js";
import { theme, resolveColor } from "../../utils/theme.js";
import { AGENT_COLORS, agentColorToThemeToken } from "../../services/agents/agentColorManager.js";
import {
  addTeammate,
  createTeam,
  deleteTeam,
  getTeam,
  listTeams,
  removeTeammate,
  setTeammateColor,
} from "../../services/teams/teamService.js";
import { agentManager } from "../../services/agent/index.js";
import type { TeamConfig } from "../../types/index.js";
import InputDialog from "../InputDialog.js";

/**
 * /teams manager (Claude Code TeamsDialog equivalent, adapted): create and
 * delete teams, pick teammates from built-in + discovered agents, assign
 * per-teammate colors. Teammate colors show up in the agent fanout, the
 * task list, and the status pill.
 */

export interface TeamsDialogProps {
  onClose: () => void;
}

type View = "list" | "detail" | "new" | "add" | "confirm-delete";

export default function TeamsDialog({ onClose }: TeamsDialogProps): React.ReactElement {
  const [view, setView] = useState<View>("list");
  const [teams, setTeams] = useState<TeamConfig[]>(() => listTeams());
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [detailName, setDetailName] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = () => setTeams(listTeams());

  useEffect(() => {
    if (selectedIndex >= teams.length && teams.length > 0) {
      setSelectedIndex(teams.length - 1);
    }
  }, [teams.length, selectedIndex]);

  // A single dispatcher so hooks stay unconditional across views.
  useInput((input, key) => {
    if (view === "list") {
      if (key.upArrow) {
        setSelectedIndex((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedIndex((prev) => Math.min(Math.max(0, teams.length - 1), prev + 1));
        return;
      }
      if (key.return) {
        const team = teams[selectedIndex];
        if (team) {
          setDetailName(team.name);
          setView("detail");
        }
        return;
      }
      if (input === "n") {
        setNote(null);
        setView("new");
        return;
      }
      if (input === "d") {
        const team = teams[selectedIndex];
        if (team) {
          setDetailName(team.name);
          setView("confirm-delete");
        }
        return;
      }
      return;
    }
    if (view === "detail" && detailName) {
      if (key.leftArrow) {
        setView("list");
        return;
      }
      if (input === "a") {
        setView("add");
        return;
      }
      if (input === "d") {
        setView("confirm-delete");
        return;
      }
      const team = getTeam(detailName);
      if (!team) return;
      if (key.upArrow) {
        setSelectedIndex((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedIndex((prev) => Math.min(Math.max(0, team.teammates.length - 1), prev + 1));
        return;
      }
      if (input === "x") {
        const target = team.teammates[selectedIndex];
        if (target) {
          removeTeammate(detailName, target);
          setNote(`Removed ${target}.`);
          refresh();
        }
        return;
      }
      if (input === "c") {
        const target = team.teammates[selectedIndex];
        if (target) {
          const current = team.colors[target];
          const idx = AGENT_COLORS.indexOf(current as (typeof AGENT_COLORS)[number]);
          const next = AGENT_COLORS[(idx + 1 + AGENT_COLORS.length) % AGENT_COLORS.length]!;
          setTeammateColor(detailName, target, next);
          setNote(`${target} → ${next}.`);
          refresh();
        }
        return;
      }
      return;
    }
    if (view === "confirm-delete" && detailName) {
      if (input === "y") {
        deleteTeam(detailName);
        setDetailName(null);
        setNote(`Deleted team ${detailName}.`);
        refresh();
        setView("list");
      }
      return;
    }
  });

  if (view === "new") {
    return (
      <InputDialog
        title="New team"
        subtitle="Give the team a name"
        onSubmit={(name) => {
          const team = createTeam(name);
          if (!team) {
            setNote(`Invalid or duplicate team name: "${name}"`);
            refresh();
            setView("list");
          } else {
            setDetailName(team.name);
            refresh();
            setView("detail");
          }
        }}
        onCancel={() => setView("list")}
      />
    );
  }

  if (view === "add" && detailName) {
    const team = getTeam(detailName);
    const options = agentManager
      .listAgentNames()
      .filter((name) => !(team?.teammates ?? []).includes(name))
      .map((name) => ({ label: name, value: name }));
    return (
      <Dialog
        title={`Add teammate to ${detailName}`}
        subtitle="Built-in and discovered agents"
        onCancel={() => setView("detail")}
        footer="enter to add · esc back"
      >
        <Select
          options={options}
          onChange={(name) => {
            addTeammate(detailName, name);
            setNote(`Added ${name}.`);
            refresh();
            setView("detail");
          }}
          onCancel={() => setView("detail")}
        />
      </Dialog>
    );
  }

  if (view === "confirm-delete" && detailName) {
    return (
      <Dialog
        title={`Delete team ${detailName}?`}
        subtitle="Teammates and colors are removed with the team"
        onCancel={() => setView("detail")}
        footer="y to delete · esc back"
      >
        <Box>
          <Text color={resolveColor(theme.error)} bold>y</Text>
          <Text> to confirm deletion</Text>
        </Box>
      </Dialog>
    );
  }

  // A team deleted elsewhere falls back to the list without a render-phase
  // state update.
  const detailTeam = view === "detail" && detailName ? getTeam(detailName) : undefined;
  const effectiveView: View = view === "detail" && detailName && !detailTeam ? "list" : view;

  if (effectiveView === "detail" && detailName && detailTeam) {
    const team = detailTeam;
    return (
      <Dialog
        title={`Team: ${team.name}`}
          subtitle={team.description || `${team.teammates.length} teammate${team.teammates.length === 1 ? "" : "s"}`}
          onCancel={onClose}
          footer={
            <Text>
              <Text bold>a</Text> add · <Text bold>c</Text> color · <Text bold>x</Text> remove · <Text bold>d</Text> delete · <Text bold>←</Text> list
            </Text>
          }
        >
          <Box flexDirection="column">
            {team.teammates.length === 0 ? (
              <Text dimColor>No teammates — press a to add agents.</Text>
            ) : (
              team.teammates.map((name, i) => {
                const focused = i === selectedIndex;
                const color = team.colors[name];
                return (
                  <Box key={name}>
                    <Text color={focused ? resolveColor(theme.claude) : undefined} bold={focused}>
                      {focused ? "❯ " : "  "}
                    </Text>
                    <Text color={color ? resolveColor(theme[agentColorToThemeToken(color)!]) : resolveColor(theme.inactive)}>
                      ●{" "}
                    </Text>
                    <Text color={focused ? resolveColor(theme.claude) : undefined} bold={focused}>
                      {name}
                    </Text>
                    <Text dimColor>{color ? ` · ${color}` : ""}</Text>
                  </Box>
                );
              })
            )}
            {note && (
              <Box marginTop={1}>
                <Text color={resolveColor(theme.warning)}>{note}</Text>
              </Box>
            )}
          </Box>
        </Dialog>
    );
  }

  if (teams.length === 0) {
    return (
      <Dialog
        title="Teams"
        subtitle="Group agents into teams with per-teammate colors"
        onCancel={onClose}
        footer={
          <Text>
            <Text bold>n</Text> new team · <Text bold>esc</Text> close
          </Text>
        }
      >
        <Text dimColor>No teams yet. Create one with n.</Text>
      </Dialog>
    );
  }

  return (
    <Dialog
      title="Teams"
      subtitle={`${teams.length} team${teams.length === 1 ? "" : "s"}`}
      onCancel={onClose}
      footer={
        <Text>
          <Text bold>↑↓</Text> navigate · <Text bold>enter</Text> open · <Text bold>n</Text> new · <Text bold>d</Text> delete · <Text bold>esc</Text> close
        </Text>
      }
    >
      <Box flexDirection="column">
        {teams.map((team, i) => {
          const focused = i === selectedIndex;
          const teammateNames = team.teammates.slice(0, 4).join(", ");
          return (
            <Box key={team.name}>
              <Text color={focused ? resolveColor(theme.claude) : undefined} bold={focused}>
                {focused ? "❯ " : "  "}
                {team.name}
              </Text>
              <Text dimColor>
                {` · ${team.teammates.length} teammate${team.teammates.length === 1 ? "" : "s"}`}
                {teammateNames ? ` · ${teammateNames}` : ""}
              </Text>
            </Box>
          );
        })}
        {note && (
          <Box marginTop={1}>
            <Text color={resolveColor(theme.warning)}>{note}</Text>
          </Box>
        )}
      </Box>
    </Dialog>
  );
}
