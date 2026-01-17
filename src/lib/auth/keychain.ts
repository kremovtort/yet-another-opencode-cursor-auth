/**
 * macOS Keychain helpers
 *
 * Cursor CLI stores an access token in macOS Keychain under the service name
 * "cursor-access-token". We read it via the built-in `security` CLI.
 *
 * IMPORTANT: Never log the token value.
 */

import { execFile } from "node:child_process";
import { platform } from "node:os";

const CURSOR_KEYCHAIN_SERVICE = "cursor-access-token";

function execFileAsync(
  file: string,
  args: string[]
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      // Node puts the exit code on the error object for non-zero exits.
      const code =
        typeof (error as { code?: unknown } | null)?.code === "number"
          ? ((error as { code: number }).code ?? 1)
          : 0;
      resolve({
        stdout: stdout ?? "",
        stderr: stderr ?? "",
        code,
      });
    });
  });
}

/**
 * Read Cursor access token from macOS Keychain (Cursor CLI).
 *
 * Returns null when:
 * - not on macOS
 * - Keychain entry is missing/unreadable
 * - the entry is empty
 */
export async function readCursorCliAccessTokenFromKeychain(): Promise<string | null> {
  if (platform() !== "darwin") return null;

  // `-w` prints only the password (token) to stdout.
  const { stdout, code } = await execFileAsync("security", [
    "find-generic-password",
    "-s",
    CURSOR_KEYCHAIN_SERVICE,
    "-w",
  ]);

  if (code !== 0) return null;

  const token = stdout.trim();
  return token.length > 0 ? token : null;
}

