import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureWithRect, createCommandError } from "./commands/shared.js";

let captureIndex = 0;

function getSessionDirectory(runtime) {
  const root = runtime.captureRoot || path.join(os.tmpdir(), "robot-captures");
  const session = createHash("sha256").update(runtime.cwd).digest("hex").slice(0, 12);
  return path.join(root, session);
}

function cleanupExpiredCaptures(directory, ttlMs, now) {
  if (ttlMs === undefined) {
    return;
  }

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name === "latest.png") {
      continue;
    }

    const capturePath = path.join(directory, entry.name);
    const age = now - fs.statSync(capturePath).mtimeMs;
    if (age >= ttlMs) {
      fs.rmSync(capturePath, { force: true });
    }
  }
}

export function saveManagedCapture(runtime, robot, rect, options = {}) {
  const directory = getSessionDirectory(runtime);
  const now = runtime.now();
  fs.mkdirSync(directory, { recursive: true });
  cleanupExpiredCaptures(directory, options.ttlMs, now);

  captureIndex += 1;
  const timestamp = new Date(now).toISOString().replaceAll(":", "-");
  const prefix = options.prefix || "capture";
  const output = path.join(directory, `${prefix}-${timestamp}-${process.pid}-${captureIndex}.png`);
  const latest = path.join(directory, "latest.png");
  const capture = captureWithRect(robot, rect);

  if (!capture.save(output)) {
    throw createCommandError(`Failed to save screenshot to ${output}.`, "SCREENSHOT_SAVE_FAILED");
  }

  fs.copyFileSync(output, latest);
  return { capture, latest, output };
}
