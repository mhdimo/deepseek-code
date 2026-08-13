




import React from "react";
import { Text } from "ink";
import { getTheme, resolveColor } from "../../utils/theme.js";
import { useTheme } from "./ThemeProvider.js";

type Status = "success" | "error" | "warning" | "info" | "pending" | "loading";

export type StatusIconProps = {
  
  status: Status;
  
  withSpace?: boolean;
};

const STATUS_CONFIG: Record<
  Status,
  { icon: string; color: "success" | "error" | "warning" | "suggestion" | undefined }
> = {
  success: { icon: "✔", color: "success" },
  error: { icon: "✖", color: "error" },
  warning: { icon: "⚠", color: "warning" },
  info: { icon: "ℹ", color: "suggestion" },
  pending: { icon: "○", color: undefined },
  loading: { icon: "…", color: undefined },
};


export function StatusIcon({ status, withSpace = false }: StatusIconProps): React.ReactNode {
  const config = STATUS_CONFIG[status];
  const [themeName] = useTheme();
  const theme = getTheme(themeName);

  
  
  const resolvedColor = config.color ? resolveColor(theme[config.color]) : undefined;

  return (
    <Text color={resolvedColor} dimColor={!config.color}>
      {config.icon}
      {withSpace && " "}
    </Text>
  );
}
