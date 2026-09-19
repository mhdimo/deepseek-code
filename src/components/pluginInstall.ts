/**
 * Confirming a plugin install.
 *
 * A marketplace entry used to install and activate on one keystroke. An
 * installed plugin is *enabled* immediately — `loadInstalledPlugins` reads
 * anything but an explicit `false` as on (`pluginService.ts`) — so that one
 * keystroke started its MCP servers, added its skills to the slash-command
 * picker, and put its agents in the pool. Nothing in the list the entry was
 * chosen from says any of that, and a plugin's manifest is written by whoever
 * published the repo.
 *
 * The wording lives here with the key handling so both can be tested: a
 * confirmation that does not say what it is confirming is theatre.
 */

export interface InstallWarning {
  heading: string;
  body: string[];
}

/** What the confirmation says. The body names the three things the yes grants. */
export function installWarning(name: string): InstallWarning {
  return {
    heading: `Install "${name}"?`,
    body: [
      "It is enabled as soon as it lands: its MCP servers are started, its skills " +
        "become slash commands, and its agents join the pool.",
      "Only install plugins you trust — that is the whole of the check.",
    ],
  };
}

/**
 * What re-enabling a disabled plugin asks.
 *
 * Enabling is the same grant as installing, and it was the one path that never
 * asked: the Installed tab turned a plugin on from Enter or a stray Space. An
 * enabled plugin's MCP servers are spawned on the next session build, and those
 * commands come from whoever published the repo — so a key pressed on the way
 * past can start third-party code, which is the exact thing the install
 * confirmation exists to stop. Disabling asks nothing, because it takes a
 * capability away.
 */
export function enableWarning(name: string): InstallWarning {
  return {
    heading: `Enable "${name}"?`,
    body: [
      "Enabling starts its MCP servers — commands from the plugin's publisher " +
        "that run on your machine — and makes its skills and agents available again.",
      "Only enable plugins you trust. Installing and enabling are the same grant.",
    ],
  };
}

/**
 * The hint under a confirmation, listing the keys that answer it.
 *
 * It lives next to the keys themselves because it drifted once: the panel
 * advertised "y/Enter install" while `resolveInstallKey` ignored Enter, so the
 * one key the user was most likely to press — the one that opened the prompt —
 * did nothing. A hint is a promise about the handler; keeping them in one file
 * is what makes the test below able to check that promise.
 */
export function confirmFooterHint(verb: string): string {
  return `y ${verb} · n/Esc cancel`;
}

export const INSTALL_FOOTER_HINT = confirmFooterHint("install");
export const ENABLE_FOOTER_HINT = confirmFooterHint("enable");

export type InstallKeyAction = "confirm" | "cancel" | "ignore";

/**
 * What a keystroke means while the confirmation is up.
 *
 * Enter is deliberately *not* confirm. It is the key that opened the prompt,
 * and a repeat — a held key, a fast double-tap, a terminal that resends — would
 * then install on the same gesture that asked the question. The whole point of
 * asking is to break that chain, so confirming costs one deliberate letter.
 * Escape still cancels, because a prompt that traps you is worse than no prompt.
 */
export function resolveInstallKey(
  input: string,
  // `return` is in the shape so a caller can hand over ink's whole key object,
  // and is ignored below on purpose — see above.
  key: { escape?: boolean; return?: boolean },
): InstallKeyAction {
  if (input === "y" || input === "Y") return "confirm";
  if (input === "n" || input === "N" || key.escape) return "cancel";
  return "ignore";
}
