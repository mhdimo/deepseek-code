// OrderedListItem — ported from claude-code-main/src/components/ui/OrderedListItem.tsx.
// Renders one numbered row of an OrderedList; the marker ("1.", "2.", …) is
// provided by OrderedList through context and drawn dim on the left.

import React, { createContext, type ReactNode, useContext } from "react";
import { Box, Text } from "ink";

export const OrderedListItemContext = createContext({
  marker: "",
});

type OrderedListItemProps = {
  children: ReactNode;
};

export function OrderedListItem({ children }: OrderedListItemProps): React.ReactNode {
  const { marker } = useContext(OrderedListItemContext);

  return (
    <Box gap={1}>
      <Text dimColor>{marker}</Text>
      <Box flexDirection="column">{children}</Box>
    </Box>
  );
}
