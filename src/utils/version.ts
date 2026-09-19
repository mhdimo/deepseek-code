import pkg from "../../package.json";

/**
 * The application version, read from package.json — the one place it is
 * written.
 *
 * This is a build-time constant: the bundler inlines the JSON, so the built
 * binary carries the version it was built from and there is no runtime file
 * read to resolve against `dist/`. Bump package.json and every surface
 * follows — the --version flag, the TUI header, /status, the help frame and
 * the status-line placeholder all read this.
 */
export const APP_VERSION: string = pkg.version;
