import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createApplicationController } from "./applications.js";
import { createExternalBackend, createPaddleBackend, createRapidOcrBackend } from "./ocr.js";
import { createWindowController, createWindowsWindowHost } from "./windows.js";
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
  const readStdin = typeof overrides.readStdin === "function"
    ? overrides.readStdin
    : () => fs.readFileSync(0, "utf8");
  let robotLoaded = false;
  let robot;
  const ocrBackends = new Map();
  const ownedOcrBackends = new Set();
  let applicationController;
  let windowController;
  let ownsWindowController = false;

  function getRobot() {
    if (!robotLoaded) {
      robot = overrides.robot || requireRobot("robotjs");
      robotLoaded = true;
    }

    return robot;
  }

  function getOcrBackend(options = {}) {
    if (overrides.ocrBackend) {
      if (typeof overrides.ocrBackend.recognize !== "function") {
        throw createCommandError("OCR backend must provide a recognize method.", "OCR_BACKEND_INVALID");
      }
      return overrides.ocrBackend;
    }

    const externalPath = options.ocr || environment.ROBOT_OCR_PATH || overrides.ocrPath;
    const binary = externalPath ? resolveExecutablePath(cwd, externalPath) : null;
    const backendName = options.ocrBackend || environment.ROBOT_OCR_BACKEND || "paddle";
    const model = options.ocrModel || "tiny";
    const rapidOcrCommand = resolveExecutablePath(
      cwd,
      environment.ROBOT_RAPIDOCR_COMMAND || overrides.rapidOcrCommand || "uv"
    );
    if (!binary && !["paddle", "rapidocr"].includes(backendName)) {
      throw createCommandError(`Unsupported OCR backend: ${backendName}.`, "OCR_BACKEND_UNSUPPORTED");
    }
    const key = binary
      ? `external:${binary}`
      : backendName === "rapidocr"
        ? `rapidocr:${rapidOcrCommand}`
        : `paddle:${model}`;
    let backend = ocrBackends.get(key);

    if (!backend) {
      if (binary) {
        backend = createExternalBackend(binary, processRunner);
      } else if (backendName === "rapidocr") {
        backend = createRapidOcrBackend(
          {
            command: rapidOcrCommand,
            workerPath: overrides.rapidOcrWorkerPath
          },
          { spawnProcess: overrides.spawnProcess }
        );
      } else {
        backend = createPaddleBackend({
          model,
          strategy: options.ocrStrategy
        });
      }
      if (!backend || typeof backend.recognize !== "function") {
        throw createCommandError("OCR backend must provide a recognize method.", "OCR_BACKEND_INVALID");
      }
      ocrBackends.set(key, backend);
      ownedOcrBackends.add(backend);
    }

    return backend;
  }

  function getWindowController() {
    if (!windowController) {
      if (overrides.windowController) {
        windowController = overrides.windowController;
      } else {
        const windowsHost = overrides.windowsHost || (
          platform === "win32" && process.platform === "win32" && !overrides.runProcess
            ? createWindowsWindowHost()
            : null
        );
        windowController = createWindowController(platform, processRunner, { windowsHost });
        ownsWindowController = true;
      }
    }

    return windowController;
  }

  function getApplicationController() {
    if (!applicationController) {
      applicationController = overrides.applicationController || createApplicationController(
        platform,
        processRunner,
        getWindowController()
      );
    }

    return applicationController;
  }

  async function dispose() {
    const backends = Array.from(ownedOcrBackends)
      .filter((backend) => typeof backend.destroy === "function");
    const controller = windowController;
    const shouldDisposeController = ownsWindowController && controller && typeof controller.dispose === "function";

    ocrBackends.clear();
    ownedOcrBackends.clear();
    applicationController = undefined;
    windowController = undefined;
    ownsWindowController = false;

    try {
      await Promise.all(backends.map((backend) => backend.destroy()));
    } finally {
      if (shouldDisposeController) {
        await controller.dispose();
      }
    }
  }

  return {
    cwd,
    platform,
    now,
    sleep,
    readStdin,
    captureRoot: overrides.captureRoot,
    getRobot,
    getOcrBackend,
    getApplicationController,
    getWindowController,
    dispose
  };
}
