/**
 * Reusable readline question with Escape key detection.
 * Does NOT close the readline interface — caller manages lifecycle.
 */

import type { Interface as ReadlineInterface } from "node:readline";

/** Sentinel value returned when the user presses Escape */
export const ESC = "__ESC__";

/**
 * Wraps readline question with Escape key detection.
 * Returns the user's trimmed answer, or ESC if Escape was pressed.
 * Does NOT close the readline interface — call rl.close() separately.
 */
export function questionWithEsc(rl: ReadlineInterface, prompt: string): Promise<string> {
  return new Promise<string>((resolve) => {
    let resolved = false;

    const onKeypress = (_str: string, key: { name?: string }) => {
      if (key?.name === "escape" && !resolved) {
        resolved = true;
        process.stdin.removeListener("keypress", onKeypress);
        resolve(ESC);
      }
    };

    process.stdin.on("keypress", onKeypress);

    rl.question(prompt, (ans) => {
      if (!resolved) {
        resolved = true;
        process.stdin.removeListener("keypress", onKeypress);
        resolve(ans.trim());
      }
    });
  });
}
