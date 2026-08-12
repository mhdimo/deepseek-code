// First-time setup — ported from claude-code-main/src/components/Onboarding.tsx.
//
// Same step-based flow and structure as the reference (welcome logo on top,
// steps[] array, goToNextStep, Enter/Esc handling per step), adapted to
// DeepSeek: there is no OAuth/preflight, so the flow is
//
//   theme → api-key (only when no key is configured) → security notes
//
// The theme step uses the same Select options as the reference ThemePicker
// (Auto / Dark / Light); the api-key step replaces their ConsoleOAuthFlow
// with a masked paste-in input; the security step is the reference's
// OrderedList + PressEnterToContinue, with DeepSeek-adapted wording.

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { theme, resolveColor, type ThemeSetting } from "../utils/theme.js";
import { usePreviewTheme } from "../ui/design-system/ThemeProvider.js";
import { MASCOT_FRAMES } from "./WelcomeScreen.js";
import { OrderedList } from "./ui/OrderedList.js";
import { PressEnterToContinue } from "./PressEnterToContinue.js";
import ThemePicker from "./ThemePicker.js";

type StepId = "theme" | "api-key" | "security";

interface OnboardingStep {
  id: StepId;
  component: React.ReactNode;
}

export type ThemeChoice = ThemeSetting;

interface OnboardingProps {
  /** Whether an API key is already configured (skips the api-key step). */
  hasApiKey: boolean;
  /** The currently active theme (pre-selected in the theme step). */
  initialTheme: ThemeChoice;
  version: string;
  onDone(result: { theme: ThemeChoice; apiKey?: string }): void;
}

export default function Onboarding({ hasApiKey, initialTheme, version, onDone }: OnboardingProps) {
  const color = (token: keyof typeof theme): string =>
    resolveColor((theme as unknown as Record<string, string>)[token] ?? theme.text);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [selectedTheme, setSelectedTheme] = useState<ThemeChoice>(initialTheme);
  const [apiKey, setApiKey] = useState("");

  // Esc cancels the live preview (ThemePicker handles preview/save itself).
  const { cancelPreview } = usePreviewTheme();

  function goToNextStep() {
    if (currentStepIndex < steps.length - 1) {
      setCurrentStepIndex(currentStepIndex + 1);
    } else {
      onDone({ theme: selectedTheme, apiKey: apiKey.trim() || undefined });
    }
  }

  function handleThemeSelection(newTheme: ThemeSetting) {
    setSelectedTheme(newTheme);
    goToNextStep();
  }

  // ── Steps (built each render, like the reference) ────────────────────

  // The theme step is the ported ThemePicker (reference
  // components/ThemePicker.tsx) — shared with the /theme command.
  const themeStep = (
    <Box marginX={1}>
      <ThemePicker
        showIntroText
        helpText="To change this later, run /settings"
        onThemeSelect={handleThemeSelection}
        onCancel={cancelPreview}
        initialTheme={initialTheme}
      />
    </Box>
  );

  const apiKeyStep = (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      <Text bold>Enter your DeepSeek API key</Text>
      <Box flexDirection="column" width={70} gap={1}>
        <Text dimColor wrap="wrap">
          Get a key at <Text color={color("claude")}>https://platform.deepseek.com/api_keys</Text>
          {"\n"}Paste it below. It is stored locally in ~/.deepseek-code/settings.json.
        </Text>
        <ApiKeyInput value={apiKey} onChange={setApiKey} onSubmit={goToNextStep} />
        <Text dimColor>Enter to continue · Esc to skip</Text>
      </Box>
    </Box>
  );

  const securityStep = (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      <Text bold>Security notes:</Text>
      <Box flexDirection="column" width={70}>
        <OrderedList>
          <OrderedList.Item>
            <Text>DeepSeek Code can make mistakes</Text>
            <Text dimColor wrap="wrap">
              You should always review its responses, especially when{"\n"}
              running code.{"\n"}
            </Text>
          </OrderedList.Item>
          <OrderedList.Item>
            <Text>Due to prompt injection risks, only use it with code you trust</Text>
            <Text dimColor wrap="wrap">
              Be careful with untrusted files, and review tool calls before{"\n"}
              approving them.{"\n"}
            </Text>
          </OrderedList.Item>
        </OrderedList>
      </Box>
      <PressEnterToContinue />
    </Box>
  );

  // Determine which steps to include based on whether a key is configured.
  const steps: OnboardingStep[] = [];
  steps.push({ id: "theme", component: themeStep });
  if (!hasApiKey) {
    steps.push({ id: "api-key", component: apiKeyStep });
  }
  steps.push({ id: "security", component: securityStep });

  const currentStep = steps[currentStepIndex];

  // Enter continues on the security step (the reference binds 'confirm:yes'
  // to it); Enter is handled by Select / ApiKeyInput on the other steps.
  useInput((_input, key) => {
    if (currentStep?.id === "security" && key.return) {
      goToNextStep();
    }
  });

  // Welcome header: the whale + wordmark (the reference shows WelcomeV2
  // here; we reuse the welcome screen's mascot).
  const whale = MASCOT_FRAMES[0];
  return (
    <Box flexDirection="column">
      <Box>
        <Box flexDirection="column">
          <Text color={color("claude")}>{whale.top}</Text>
          <Text color={color("claude")}>{whale.mid}</Text>
          <Text color={color("claude")}>{whale.bot}</Text>
        </Box>
        <Box flexDirection="column" marginLeft={2}>
          <Text>
            <Text color={color("claude")} bold>
              Welcome to DeepSeek Code{" "}
            </Text>
            <Text dimColor>v{version} </Text>
          </Text>
          <Text dimColor>First-time setup</Text>
        </Box>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {currentStep?.component}
      </Box>
    </Box>
  );
}

/** Masked API key input: typed characters are hidden as •, backspace
 *  deletes, Enter submits, Esc skips (leaves the key empty). */
function ApiKeyInput({
  value,
  onChange,
  onSubmit,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
}): React.ReactElement {
  useInput((input, key) => {
    if (key.return) {
      onSubmit();
    } else if (key.escape) {
      onSubmit();
    } else if (key.backspace || key.delete) {
      onChange(value.slice(0, -1));
    } else if (input && !key.ctrl && !key.meta && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow) {
      onChange(value + input);
    }
  });

  return (
    <Box>
      <Text dimColor>API key: </Text>
      <Text color={resolveColor(theme.claude)}>{"•".repeat(value.length) || "…"}</Text>
      <Text dimColor>▊</Text>
    </Box>
  );
}
