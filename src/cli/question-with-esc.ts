/**
 * Reusable readline question with Escape key detection.
 * Does NOT close the readline interface — caller manages lifecycle.
 *
 * Uses readline's built-in 'keypress' event (not raw process.stdin listeners)
 * to avoid raw-mode conflicts with subsequent rl.question() calls on Windows.
 */

import type { Interface as ReadlineInterface } from "node:readline";

/** Sentinel value returned when the user presses Escape */
export const ESC = "__ESC__";

/**
 * Wraps readline question with Escape key detection.
 *
 * - On normal Enter: returns the trimmed answer string.
 * - On Escape: immediately returns ESC and closes the readline interface
 *   (since the pending question is cancelled).
 *
 * The caller does NOT need to call rl.close() after receiving ESC.
 * On normal answer, the caller should still call rl.close().
 */
export function questionWithEsc(rl: ReadlineInterface, prompt: string): Promise<string> {
  return new Promise<string>((resolve) => {
    let resolved = false;

    const onKeypress = (_str: string, key: { name?: string }) => {
      if (key?.name === "escape" && !resolved) {
        resolved = true;
        rl.removeListener("keypress", onKeypress);
        rl.close();
        resolve(ESC);
      }
    };

    rl.on("keypress", onKeypress);

    rl.question(prompt, (ans) => {
      if (!resolved) {
        resolved = true;
        rl.removeListener("keypress", onKeypress);
        resolve(ans.trim());
      }
      // If the keypress handler already resolved (Esc case),
      // the rl is already closed and this callback is a no-op.
    });
  });
}
