






import React, { useEffect } from "react";

const ENTER_ALT_SCREEN = "\x1b[?1049h";
const LEAVE_ALT_SCREEN = "\x1b[?1049l";

export default function AlternateScreen({ children }: { children: React.ReactNode }): React.ReactElement {
  useEffect(() => {
    process.stdout.write(ENTER_ALT_SCREEN);
    const leave = () => {
      process.stdout.write(LEAVE_ALT_SCREEN);
    };
    
    
    process.on("exit", leave);
    return () => {
      process.off("exit", leave);
      leave();
    };
  }, []);
  return <>{children}</>;
}
