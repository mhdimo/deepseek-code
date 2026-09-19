import { homedir } from "os";
import { join } from "path";

/**
 * Root of this app's on-disk state — settings, sessions, snapshots, plugins.
 *
 * Resolved per call rather than at module load. A module-level constant is
 * fixed by whichever module happened to be imported first, which leaves a test
 * that redirects the store (or a user pointing DEEPSEEK_CODE_DATA_DIR at
 * another volume) racing the import order. With no override — the normal case —
 * this is exactly ~/.deepseek-code.
 */
export function dataDir(): string {
  const override = process.env.DEEPSEEK_CODE_DATA_DIR?.trim();
  return override ? override : join(homedir(), ".deepseek-code");
}
