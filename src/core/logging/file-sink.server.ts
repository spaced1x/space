import { createLogger, addLogSink, type LogRecord } from "./logger";

// Size-based rotation: space.log -> space.log.1 -> ... -> space.log.N.
// Node-only; on runtimes without a real filesystem the console sink stands alone.
let installed = false;

export async function installFileSink(options: {
  dir: string;
  maxBytes: number;
  maxFiles: number;
}): Promise<boolean> {
  if (installed) return true;
  const log = createLogger("logging");
  try {
    const fs = await import("node:fs");
    const path = await import("node:path");
    fs.mkdirSync(options.dir, { recursive: true });
    const file = path.join(options.dir, "space.log");

    const rotate = () => {
      for (let index = options.maxFiles - 1; index >= 1; index--) {
        const from = index === 1 ? file : `${file}.${index - 1}`;
        const to = `${file}.${index}`;
        if (fs.existsSync(from)) fs.renameSync(from, to);
      }
    };

    addLogSink((record: LogRecord) => {
      const line = `${JSON.stringify(record)}\n`;
      const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
      if (size + line.length > options.maxBytes) rotate();
      fs.appendFileSync(file, line);
    });
    installed = true;
    log.info("file sink installed", { dir: options.dir, maxFiles: options.maxFiles });
    return true;
  } catch (error) {
    log.warn("file sink unavailable, console logging only", {
      reason: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
