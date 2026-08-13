













import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { Box, Text, useInput, useStdout } from "ink";
import stringWidth from "string-width";
import { getTheme, resolveColor, type Theme } from "../../utils/theme.js";
import { useTheme } from "./ThemeProvider.js";

export type TabsProps = {
  children: Array<React.ReactElement<TabProps>>;
  title?: string;
  color?: keyof Theme;
  defaultTab?: string;
  hidden?: boolean;
  useFullWidth?: boolean;
  
  selectedTab?: string;
  
  onTabChange?: (tabId: string) => void;
  
  banner?: React.ReactNode;
  
  disableNavigation?: boolean;
  
  initialHeaderFocused?: boolean;
  
  contentHeight?: number;
  
  navFromContent?: boolean;
};

type TabsContextValue = {
  selectedTab: string | undefined;
  width: number | undefined;
  headerFocused: boolean;
  focusHeader: () => void;
  blurHeader: () => void;
  registerOptIn: () => () => void;
};

const TabsContext = createContext<TabsContextValue>({
  selectedTab: undefined,
  width: undefined,
  
  
  headerFocused: false,
  focusHeader: () => {},
  blurHeader: () => {},
  registerOptIn: () => () => {},
});

export function Tabs({
  title,
  color,
  defaultTab,
  children,
  hidden,
  useFullWidth,
  selectedTab: controlledSelectedTab,
  onTabChange,
  banner,
  disableNavigation,
  initialHeaderFocused = true,
  contentHeight,
  navFromContent = false,
}: TabsProps): React.ReactNode {
  const { stdout } = useStdout();
  const terminalWidth = stdout.columns ?? 80;

  
  
  const childrenArray = React.Children.toArray(
    children,
  ) as Array<React.ReactElement<TabProps>>;

  const tabs: Array<[string | undefined, string | undefined]> =
    childrenArray.map((child) => [
      child.props.id ?? child.props.title,
      child.props.title,
    ]);
  const defaultTabIndex = defaultTab
    ? tabs.findIndex((tab) => defaultTab === tab[0])
    : 0;

  
  const isControlled = controlledSelectedTab !== undefined;
  const [internalSelectedTab, setInternalSelectedTab] = useState(
    defaultTabIndex !== -1 ? defaultTabIndex : 0,
  );

  
  const controlledTabIndex = isControlled
    ? tabs.findIndex((tab) => tab[0] === controlledSelectedTab)
    : -1;
  const selectedTabIndex = isControlled
    ? controlledTabIndex !== -1
      ? controlledTabIndex
      : 0
    : internalSelectedTab;

  
  
  
  
  
  const [headerFocused, setHeaderFocused] = useState(initialHeaderFocused);
  const focusHeader = useCallback(() => setHeaderFocused(true), []);
  const blurHeader = useCallback(() => setHeaderFocused(false), []);
  
  
  
  
  const [optInCount, setOptInCount] = useState(0);
  const registerOptIn = useCallback(() => {
    setOptInCount((n) => n + 1);
    return () => setOptInCount((n) => n - 1);
  }, []);
  const optedIn = optInCount > 0;

  const handleTabChange = (offset: number) => {
    const newIndex =
      (selectedTabIndex + tabs.length + offset) % tabs.length;
    const newTabId = tabs[newIndex]?.[0];

    if (isControlled && onTabChange && newTabId) {
      onTabChange(newTabId);
    } else {
      setInternalSelectedTab(newIndex);
    }
    
    
    setHeaderFocused(true);
  };

  
  
  
  useInput(
    (_input, key) => {
      if (key.rightArrow || key.tab) {
        handleTabChange(1);
      } else if (key.leftArrow || (key.tab && key.shift)) {
        handleTabChange(-1);
      } else if (key.downArrow && optedIn) {
        setHeaderFocused(false);
      }
    },
    { isActive: !hidden && !disableNavigation && headerFocused },
  );

  
  
  useInput(
    (_input, key) => {
      if (key.rightArrow || key.tab) {
        handleTabChange(1);
        setHeaderFocused(true);
      } else if (key.leftArrow || (key.tab && key.shift)) {
        handleTabChange(-1);
        setHeaderFocused(true);
      }
    },
    {
      isActive:
        navFromContent &&
        !headerFocused &&
        optedIn &&
        !hidden &&
        !disableNavigation,
    },
  );

  
  
  const titleWidth = title ? stringWidth(title) + 1 : 0; 
  const tabsWidth = tabs.reduce(
    (sum, [, tabTitle]) =>
      sum + (tabTitle ? stringWidth(tabTitle) : 0) + 2 + 1, 
    0,
  );
  const usedWidth = titleWidth + tabsWidth;
  const spacerWidth = useFullWidth
    ? Math.max(0, terminalWidth - usedWidth)
    : 0;
  const contentWidth = useFullWidth ? terminalWidth : undefined;

  
  const [themeName] = useTheme();
  const theme = getTheme(themeName);
  const resolvedColor = color ? resolveColor(theme[color]) : undefined;
  const resolvedInverseText = resolveColor(theme.inverseText);

  return (
    <TabsContext.Provider
      value={{
        selectedTab: tabs[selectedTabIndex]?.[0],
        width: contentWidth,
        headerFocused,
        focusHeader,
        blurHeader,
        registerOptIn,
      }}
    >
      <Box flexDirection="column">
        {!hidden && (
          <Box flexDirection="row" gap={1}>
            {title !== undefined && (
              <Text bold color={resolvedColor}>
                {title}
              </Text>
            )}
            {tabs.map(([id, tabTitle], i) => {
              const isCurrent = selectedTabIndex === i;
              const hasColorCursor = color && isCurrent && headerFocused;
              return (
                <Text
                  key={id}
                  backgroundColor={hasColorCursor ? resolvedColor : undefined}
                  color={hasColorCursor ? resolvedInverseText : undefined}
                  inverse={isCurrent && !hasColorCursor}
                  bold={isCurrent}
                >
                  {" "}
                  {tabTitle}
                  {" "}
                </Text>
              );
            })}
            {spacerWidth > 0 && <Text>{" ".repeat(spacerWidth)}</Text>}
          </Box>
        )}
        {banner}
        <Box
          flexDirection="column"
          width={contentWidth}
          marginTop={hidden ? 0 : 1}
          height={contentHeight}
          overflowY={contentHeight !== undefined ? "hidden" : undefined}
          
          
          
          
          flexShrink={0}
        >
          {childrenArray}
        </Box>
      </Box>
    </TabsContext.Provider>
  );
}

export type TabProps = {
  title: string;
  id?: string;
  children: React.ReactNode;
};

export function Tab({ title, id, children }: TabProps): React.ReactNode {
  const { selectedTab, width } = useContext(TabsContext);

  if (selectedTab !== (id ?? title)) {
    return null;
  }

  
  
  return (
    <Box width={width} flexShrink={0}>
      {children}
    </Box>
  );
}

export function useTabsWidth(): number | undefined {
  const { width } = useContext(TabsContext);
  return width;
}


export function useTabHeaderFocus(): {
  headerFocused: boolean;
  focusHeader: () => void;
  blurHeader: () => void;
} {
  const { headerFocused, focusHeader, blurHeader, registerOptIn } =
    useContext(TabsContext);
  useEffect(registerOptIn, [registerOptIn]);
  return { headerFocused, focusHeader, blurHeader };
}
