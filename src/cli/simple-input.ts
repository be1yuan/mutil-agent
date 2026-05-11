/**
 * Simple stdin line reader — bypasses readline entirely.
 *
 * Used for interactive wizards where repeated readline question() calls
 * break on Windows due to \r\n split in raw mode leaving stray \n characters
 * that cause subsequent question() to resolve immediately with empty input.
 */

/** Sentinel returned when the user presses Escape on an empty buffer. */
export const ESC = "__ESC__";

/**
 * Read a single line from stdin in raw mode.
 *
 * - Enter / Return: resolves with the accumulated input.
 * - Escape on empty buffer: resolves with ESC sentinel.
 * - Escape with content: resolves with the buffer so far (treated as submit).
 * - Backspace: erases last character with terminal echo.
 */
export function readLine(prompt: string): Promise<string> {
  return new Promise<string>((resolve) => {
    process.stdout.write(prompt);

    // Set raw mode so we receive each character immediately
    let wasRaw = false;
    try {
      wasRaw = process.stdin.isRaw;
      if (process.stdin.setRawMode && !wasRaw) {
        process.stdin.setRawMode(true);
      }
    } catch {
      // stdin doesn't support raw mode (e.g. piped input) — fail gracefully
    }

    let buf = "";
    let resolved = false;

    function finish() {
      if (resolved) return;
      resolved = true;
      process.stdin.removeListener("data", onData);
      process.stdin.pause();
      try {
        if (process.stdin.setRawMode && !wasRaw) {
          process.stdin.setRawMode(false);
        }
      } catch {
        // ignore
      }
    }

    function onData(chunk: Buffer) {
      try {
        // Array.from to iterate Unicode code points, not UTF-16 surrogates
        for (const ch of Array.from(chunk.toString())) {
          if (ch === "\r") {
            finish();
            resolve(buf);
            return;
          }
          if (ch === "\n") {
            finish();
            resolve(buf);
            return;
          }
          if (ch === "\x1b") {
            finish();
            resolve(buf.length === 0 ? ESC : buf);
            return;
          }
          if (ch === "\x7f" || ch === "\b") {
            if (buf.length > 0) {
              // Remove last Unicode code point (not last UTF-16 unit)
              const chars = Array.from(buf);
              chars.pop();
              buf = chars.join("");
              process.stdout.write("\b \b");
            }
            continue;
          }
          buf += ch;
          process.stdout.write(ch);
        }
      } catch {
        finish();
        resolve(buf);
      }
    }

    process.stdin.on("data", onData);
    process.stdin.resume();
  });
}
