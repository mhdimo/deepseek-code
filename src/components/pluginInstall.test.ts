/**
 * Installing a plugin asks first — and so does turning one back on.
 *
 * What it is guarding: a marketplace entry installed and activated on a single
 * Enter. Installed plugins are enabled unless something explicitly says
 * otherwise (`loadInstalledPlugins` reads `enabledMap[name] !== false`), so
 * that keystroke — one you might have hit on the way through the list —
 * spawned the plugin's MCP servers, turned its skills into slash commands and
 * added its agents to the pool. The list it was picked from says none of that,
 * and the manifest is written by whoever published the repo.
 *
 * The Installed tab was the same hole with a shorter reach: Space or Enter on a
 * disabled plugin enabled it outright. Enabling and installing grant the same
 * three things, so both ask, through the same keys and the same render.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ENABLE_FOOTER_HINT,
  INSTALL_FOOTER_HINT,
  confirmFooterHint,
  enableWarning,
  installWarning,
  resolveInstallKey,
} from "./pluginInstall.js";

describe("resolveInstallKey", () => {
  test("y installs", () => {
    expect(resolveInstallKey("y", {})).toBe("confirm");
    expect(resolveInstallKey("Y", {})).toBe("confirm");
  });

  test("n and Escape cancel", () => {
    expect(resolveInstallKey("n", {})).toBe("cancel");
    expect(resolveInstallKey("N", {})).toBe("cancel");
    expect(resolveInstallKey("", { escape: true })).toBe("cancel");
  });

  test("Enter does not install", () => {
    // The key that opened the prompt must not also answer it: a held key, a
    // fast double-tap, or a terminal resending the byte would otherwise
    // install on the same gesture that asked. This is the whole point.
    expect(resolveInstallKey("", { return: true })).toBe("ignore");
    expect(resolveInstallKey("\r", { return: true })).toBe("ignore");
  });

  test("anything else is ignored, so a stray key cannot decide it", () => {
    for (const input of ["", " ", "d", "q", ""]) {
      // Escape is the exception and is checked above; a bare ESC byte arrives
      // as `input` only when ink did not read it as the key — either way it is
      // not a yes.
      expect(resolveInstallKey(input, {})).not.toBe("confirm");
    }
  });
});

describe("installWarning", () => {
  test("names the plugin it is asking about", () => {
    expect(installWarning("acme-tools").heading).toContain("acme-tools");
    expect(installWarning("acme-tools").heading.endsWith("?")).toBe(true);
  });

  test("says what the yes actually grants", () => {
    // A confirmation that does not say what it confirms is theatre. These are
    // the three activation paths a plugin manifest can reach.
    const body = installWarning("acme-tools").body.join(" ");
    expect(body).toContain("MCP servers");
    expect(body).toContain("slash commands");
    expect(body).toContain("agents");
    expect(body.toLowerCase()).toContain("trust");
  });
});

describe("enableWarning", () => {
  test("names the plugin it is asking about", () => {
    expect(enableWarning("acme-tools").heading).toContain("acme-tools");
    expect(enableWarning("acme-tools").heading.endsWith("?")).toBe(true);
  });

  test("says the yes starts commands from the publisher", () => {
    // Enabling is not a UI state change — it spawns the plugin's MCP servers.
    // A prompt that said only "enable this?" would be theatre.
    const body = enableWarning("acme-tools").body.join(" ");
    expect(body).toContain("MCP servers");
    expect(body.toLowerCase()).toContain("trust");
  });
});

/** The tokens a hint offers: `y install · n/Esc cancel` → y, n, Esc. */
function advertisedKeys(hint: string): string[] {
  return hint
    .split("·")
    .map((part) => part.trim().split(/\s+/)[0] ?? "")
    .flatMap((keys) => keys.split("/"))
    .filter(Boolean);
}

describe("the footer hint", () => {
  test("both confirmations offer the same keys", () => {
    // One helper builds them, so install and enable cannot disagree about how
    // a question is answered — only about the verb in the middle.
    expect(advertisedKeys(INSTALL_FOOTER_HINT)).toEqual(advertisedKeys(ENABLE_FOOTER_HINT));
    expect(ENABLE_FOOTER_HINT).toBe(confirmFooterHint("enable"));
  });

  for (const [label, hint] of [
    ["install", INSTALL_FOOTER_HINT],
    ["enable", ENABLE_FOOTER_HINT],
  ] as const) {
    test(`the ${label} hint advertises only keys the prompt honours`, () => {
      // Derived from the hint rather than written out beside it, because a
      // second hand-kept list is how this drifted the first time: the panel
      // offered "y/Enter install" for a handler that ignored Enter.
      const keys = advertisedKeys(hint);
      expect(keys.length).toBeGreaterThan(0);

      for (const key of keys) {
        const action =
          key === "Esc"
            ? resolveInstallKey("", { escape: true })
            : resolveInstallKey(key.toLowerCase(), {});
        expect(action, `the hint offers "${key}" but the prompt ignores it`).not.toBe("ignore");
      }
    });
  }

  test("does not offer Enter while Enter is ignored", () => {
    // Named separately because Enter is not a character in the hint — it is a
    // word, and it is the one key that would be pressed by reflex.
    for (const hint of [INSTALL_FOOTER_HINT, ENABLE_FOOTER_HINT]) {
      if (hint.includes("Enter")) {
        expect(resolveInstallKey("", { return: true })).not.toBe("ignore");
      }
    }
    expect(resolveInstallKey("", { return: true })).toBe("ignore");
  });
});

describe("the panel asks through this", () => {
  const panel = readFileSync(join(import.meta.dir, "PluginPanel.tsx"), "utf-8");

  test("Enter in the marketplace opens the question, not the install", () => {
    expect(panel).toContain("setPendingInstall(selected)");
    expect(panel).toContain("resolveInstallKey(input, key)");
    expect(panel).toContain('action === "confirm"');
    expect(panel).toContain("await runInstall(entry)");
  });

  test("there is exactly one way to reach installPlugin", () => {
    // If a second call site appears — a shortcut, a batch install, an "and
    // don't ask again" — it is a path that skipped the question. The lookbehind
    // matters: `uninstallPlugin(` contains `installPlugin(`.
    const calls = panel.match(/(?<!un)installPlugin\(/g) ?? [];
    expect(calls.length).toBe(1);
    // …and the one caller is entered only past the confirm check. `runInstall`
    // is defined above the handler, so this is a proximity test on the call
    // rather than an order test on the text.
    const guard = panel.indexOf('action === "confirm"');
    const call = panel.indexOf("await runInstall(entry)");
    expect(guard).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(guard);
    expect(call - guard).toBeLessThan(200);
  });

  test("the question is rendered, not just asked in the handler", () => {
    // Both questions render through one block — the shape of the confirmation
    // and the keys under it are shared, so neither can drift from the handler.
    expect(panel).toContain("installWarning(pendingInstall.name)");
    expect(panel).toContain("enableWarning(pendingEnable)");
    expect(panel).toContain("{pendingWarning && (");
  });

  test("the footer is the hint that was tested, not a second copy of it", () => {
    expect(panel).toContain("INSTALL_FOOTER_HINT");
    expect(panel).toContain("ENABLE_FOOTER_HINT");
    expect(panel).toContain("{pendingHint}");
  });
});

/**
 * The Installed tab enabled a plugin from a bare Space or Enter. That is the
 * same grant as installing one — the MCP servers start on the next session
 * build — so it has to pass the same question, and the keys that answer it are
 * the ones `resolveInstallKey` defines.
 */
describe("enabling asks too", () => {
  const panel = readFileSync(join(import.meta.dir, "PluginPanel.tsx"), "utf-8");

  test("toggling a disabled plugin on opens the question", () => {
    expect(panel).toContain("setPendingEnable(selected.name)");
    // …and the handler that did it outright is gone: no call site flips the
    // plugin to whatever `selected.enabled` was not.
    expect(panel).not.toContain("togglePlugin(selected.name, nextState)");
  });

  test("disabling is still immediate, because it takes nothing away", () => {
    // A prompt here would train the user to answer yes to the one that matters.
    expect(panel).toContain("togglePlugin(selected.name, false)");
  });

  test("the only way to turn a plugin on is past the confirm check", () => {
    // Two call sites, and they are the two obvious ones: off, and on-through-
    // the-question. A third — a shortcut, an "enable all", a bulk action —
    // would be a path that skipped the question.
    const calls = panel.match(/togglePlugin\(/g) ?? [];
    expect(calls.length).toBe(2);
    expect(panel).toContain("togglePlugin(name, true)");

    // `runEnable` is defined above the handler and called once. The call is in
    // the confirm branch — delimited here by the cancel branch that follows it,
    // so this is the branch's body and not a window around it.
    expect(panel).toContain("const runEnable = (");
    expect((panel.match(/runEnable\(name\)/g) ?? []).length).toBe(1);
    const confirm = panel.indexOf('action === "confirm"');
    const cancel = panel.indexOf('action === "cancel"', confirm);
    expect(confirm).toBeGreaterThan(0);
    expect(cancel).toBeGreaterThan(confirm);

    const confirmed = panel.slice(confirm, cancel);
    expect(confirmed).toContain("runEnable(name)");
    expect(confirmed).toContain("await runInstall(entry)");
    expect(panel).toContain("togglePlugin(name, true)");
  });

  test("a cancelled enable leaves the plugin disabled", () => {
    expect(panel).toContain("was left disabled");
  });
});
