import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createApplicationController } from "./applications.js";
import { createExternalBackend, createPaddleBackend } from "./ocr.js";
import { createCommandError, resolveExecutablePath } from "./commands/shared.js";

const requireRobot = createRequire(import.meta.url);

function runProcess(command, args, label) {
  const result = spawnSync(command, args, { encoding: "utf8" });

  if (result.error) {
    throw createCommandError(`${label} failed: ${result.error.message}`, "PROCESS_ERROR");
  }

  if (result.status !== 0) {
    const details = (result.stderr || result.stdout || "").trim();
    throw createCommandError(
      `${label} exited with code ${result.status}: ${details}`,
      "PROCESS_ERROR"
    );
  }

  return result.stdout;
}

export function createRuntime(overrides = {}, environment = {}) {
  const cwd = overrides.cwd || process.cwd();
  const platform = overrides.platform || process.platform;
  const processRunner = overrides.runProcess || runProcess;
  const now = typeof overrides.now === "function" ? overrides.now : Date.now;
  const sleep = typeof overrides.sleep === "function"
    ? overrides.sleep
    : (duration) => new Promise((resolve) => setTimeout(resolve, duration));
  let robotLoaded = false;
  let robot;
  let activeOcrBackend;
  let ownsOcrBackend = false;
  let applicationController;

  function getRobot() {
    if (!robotLoaded) {
      robot = overrides.robot || requireRobot("robotjs");
      robotLoaded = true;
    }

    return robot;
  }

  function getOcrBackend(options = {}) {
    if (activeOcrBackend) {
      return activeOcrBackend;
    }

    const externalPath = options.ocr || environment.ROBOT_OCR_PATH || overrides.ocrPath;
    const binary = externalPath ? resolveExecutablePath(cwd, externalPath) : null;
    activeOcrBackend = overrides.ocrBackend || (binary
      ? createExternalBackend(binary, processRunner)
      : createPaddleBackend({
        strategy: options.ocrStrategy,
        minimumConfidence: options.confidence
      }));

    if (!activeOcrBackend || typeof activeOcrBackend.recognize !== "function") {
      throw createCommandError("OCR backend must provide a recognize method.", "OCR_BACKEND_INVALID");
    }

    ownsOcrBackend = !overrides.ocrBackend;
    return activeOcrBackend;
  }

  function getApplicationController() {
    if (!applicationController) {
      applicationController = overrides.applicationController || createApplicationController(
        platform,
        processRunner
      );
    }

    return applicationController;
  }

  async function dispose() {
    const backend = activeOcrBackend;
    const shouldDestroy = ownsOcrBackend && backend && typeof backend.destroy === "function";

    activeOcrBackend = undefined;
    ownsOcrBackend = false;

    if (shouldDestroy) {
      await backend.destroy();
    }
  }

  return {
    cwd,
    platform,
    now,
    sleep,
    getRobot,
    getOcrBackend,
    getApplicationController,
    dispose
  };
}
