// SessionPicker — select and resume previous sessions with keyboard navigation
//
// Appears when the user presses ctrl+a.
// Navigate with ↑↓, confirm with Enter, dismiss with Esc.

import React from "react";
import { Box, Text } from "ink";
import { theme } from "../utils/theme.js";
import type { SessionData } from "../state/storage.js";

interface SessionPickerProps {
  sessions: SessionData[];
  selectedIndex: number;
  currentDirectory: string;
}

function formatDate(timestamp: number): string {
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function SessionPicker({
  sessions,
  selectedIndex,
  currentDirectory,
}: SessionPickerProps) {
  if (sessions.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.assistant} paddingX={1} marginY={1}>
        <Text dimColor>No saved sessions found.</Text>
        <Text dimColor>Press Esc to dismiss.</Text>
      </Box>
    );
  }

  // Show up to 10 sessions for clean layout
  const maxVisible = 10;
  const startIdx = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), sessions.length - maxVisible));
  const visibleSessions = sessions.slice(startIdx, startIdx + maxVisible);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.assistant} paddingX={1} marginY={1} width="100%">
      <Box marginBottom={1}>
        <Text bold color={theme.assistant}>Select a past session to resume (ctrl+a):</Text>
      </Box>

      {visibleSessions.map((session, visibleIdx) => {
        const actualIdx = startIdx + visibleIdx;
        const active = actualIdx === selectedIndex;
        const isLocal = session.workingDirectory === currentDirectory;
        
        // Format paths to show home dir symbol ~
        let dirDisplay = session.workingDirectory;
        const home = process.env.HOME;
        if (home && dirDisplay.startsWith(home)) {
          dirDisplay = "~" + dirDisplay.slice(home.length);
        }

        const msgCount = session.messages ? session.messages.length : 0;

        return (
          <Box key={session.hash} flexDirection="row" alignItems="center">
            <Text color={theme.assistant}>{active ? "▸ " : "  "}</Text>
            
            {/* Hash */}
            <Text color={active ? theme.assistant : "cyan"} bold={active}>
              {session.hash.padEnd(12)}
            </Text>

            {/* Date */}
            <Text color="gray" dimColor={!active}>
              {formatDate(session.updatedAt || session.createdAt).padEnd(18)}
            </Text>

            {/* Msg count & Model */}
            <Text color="yellow" dimColor={!active}>
              {`${msgCount} msg${msgCount !== 1 ? "s" : ""}`.padEnd(8)}
            </Text>
            <Text color="magenta" dimColor={!active}>
              {`(${session.agent})`.padEnd(10)}
            </Text>

            {/* Directory (highlight local vs remote) */}
            <Box flexGrow={1} marginLeft={1}>
              <Text color={isLocal ? "green" : "gray"} bold={isLocal && active}>
                {isLocal ? "[local] " : "[remote] "}
                <Text dimColor={!active}>{dirDisplay}</Text>
              </Text>
            </Box>
          </Box>
        );
      })}

      <Box marginTop={1} borderStyle="single" borderTop={true} borderBottom={false} borderLeft={false} borderRight={false} borderDimColor paddingTop={0}>
        <Text dimColor>
          ↑↓ navigate · ↵ select · Esc dismiss · total {sessions.length} session{sessions.length !== 1 ? "s" : ""}
        </Text>
      </Box>
    </Box>
  );
}
