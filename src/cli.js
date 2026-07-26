const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { createApplicationController } = require("./applications");
const { loadRobot } = require("./load-robot");
const { createExternalBackend, createPaddleBackend, toArrayBuffer } = require("./ocr");

const HELP_TEXT = `Usage:
  robot screenshot --output <path> [x y width height]
  robot click [x y] [--button left|middle|right] [--double]
  robot moveMouse <x> <y>
  robot type <text...> [--cpm <chars-per-minute>]
  robot keyTap <key> [modifier...]
  robot scrollMouse <x> <y>
  robot mousePos
  robot screenSize
  robot pixelColor <x> <y>
  robot openApp <application>
  robot activateApp <application>
  robot findImage <path> [--x <n> --y <n> --width <n> --height <n>] [--tolerance <n>]
  robot clickImage <path> [--x <n> --y <n> --width <n> --height <n>] [--tolerance <n>] [--button <name>] [--double]
  robot waitForImage <path> [--timeout <ms>] [--x <n> --y <n> --width <n> --height <n>] [--tolerance <n>]
  robot text [--ocr <external-command>]
  robot findText <query...> [--x <n> --y <n> --width <n> --height <n>] [--confidence <n>] [--index <n>] [--exact] [--ocr <external-command>]
  robot clickText <query...> [occurrence] [--x <n> --y <n> --width <n> --height <n>] [--confidence <n>] [--index <n>] [--exact] [--ocr <external-command>] [--button <name>] [--double]
  robot waitForText <query...> [--timeout <ms>] [--x <n> --y <n> --width <n> --height <n>] [--confidence <n>] [--index <n>] [--exact] [--ocr <external-command>]
  robot findWord <query...> ...
  robot clickWord <query...> [occurrence] ...

Notes:
  - Commands print JSON to stdout on success.
  - Errors print JSON to stderr and exit non-zero.
  - moveMouse always uses smooth movement so the pointer visibly travels.
  - Text commands use bundled PP-OCRv6 Tiny models unless --ocr or ROBOT_OCR_PATH selects an external backend.
  - Text search results include every match with a stable 1-based index for that observation.
  - clickText/clickWord accept a trailing occurrence number; --index works for every text command.
`;

const BOOLEAN_OPTIONS = new Set(["double", "help", "pretty", "exact", "keep-capture"]);

function createCliError(message, code, exitCode) {
  const error = new Error(message);
  error.code = code || "CLI_ERROR";
  error.exitCode = typeof exitCode === "number" ? exitCode : 1;
  return error;
}

function parseArgv(argv) {
  const options = {};
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (token === "-h") {
      options.help = true;
      continue;
    }

    if (token.startsWith("--")) {
      const option = token.slice(2);
      const equalsIndex = option.indexOf("=");

      if (equalsIndex !== -1) {
        options[option.slice(0, equalsIndex)] = option.slice(equalsIndex + 1);
        continue;
      }

      if (BOOLEAN_OPTIONS.has(option)) {
        options[option] = true;
        continue;
      }

      if (index + 1 >= argv.length) {
        throw createCliError(`Missing value for option --${option}.`, "INVALID_ARGUMENT");
      }

      options[option] = argv[index + 1];
      index += 1;
      continue;
    }

    positionals.push(token);
  }

  return { options, positionals };
}

function toNumber(value, label) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    throw createCliError(`${label} must be a finite number.`, "INVALID_ARGUMENT");
  }

  return parsed;
}

function toInteger(value, label) {
  const parsed = toNumber(value, label);

  if (!Number.isInteger(parsed)) {
    throw createCliError(`${label} must be an integer.`, "INVALID_ARGUMENT");
  }

  return parsed;
}

function takeRect(positionals, options) {
  if (positionals.length === 0) {
    if (
      typeof options.x === "undefined" &&
      typeof options.y === "undefined" &&
      typeof options.width === "undefined" &&
      typeof options.height === "undefined"
    ) {
      return null;
    }

    return {
      x: toNumber(options.x, "x"),
      y: toNumber(options.y, "y"),
      width: toNumber(options.width, "width"),
      height: toNumber(options.height, "height")
    };
  }

  if (positionals.length !== 4) {
    throw createCliError("Expected either no rectangle or exactly four rectangle values.", "INVALID_ARGUMENT");
  }

  return {
    x: toNumber(positionals[0], "x"),
    y: toNumber(positionals[1], "y"),
    width: toNumber(positionals[2], "width"),
    height: toNumber(positionals[3], "height")
  };
}

function captureWithRect(robot, rect) {
  if (!rect) {
    return robot.screen.capture();
  }

  return robot.screen.capture(rect.x, rect.y, rect.width, rect.height);
}

function getTextSearchRects(robot, rect) {
  if (rect) {
    return [rect];
  }

  if (typeof robot.getDisplays !== "function") {
    return [null];
  }

  const displays = robot.getDisplays();

  if (!Array.isArray(displays) || displays.length <= 1) {
    return [null];
  }

  return displays.map((display) => ({
    x: display.x,
    y: display.y,
    width: display.width,
    height: display.height
  }));
}

function getCaptureMetadata(capture) {
  return {
    width: capture.width,
    height: capture.height,
    byteWidth: capture.byteWidth,
    bitsPerPixel: capture.bitsPerPixel,
    bytesPerPixel: capture.bytesPerPixel,
    screenX: capture.screenX,
    screenY: capture.screenY,
    scaleX: capture.scaleX,
    scaleY: capture.scaleY
  };
}

function getSearchOptions(options) {
  const searchOptions = {};

  if (typeof options.tolerance !== "undefined") {
    searchOptions.tolerance = toNumber(options.tolerance, "tolerance");
  }

  return searchOptions;
}

function resolveInputPath(cwd, value, label) {
  if (!value) {
    throw createCliError(`${label} is required.`, "INVALID_ARGUMENT");
  }

  return path.resolve(cwd, value);
}

function resolveExecutablePath(cwd, value) {
  if (value.indexOf(path.sep) !== -1 || value.startsWith(".")) {
    return path.resolve(cwd, value);
  }

  return value;
}

function performClick(robot, point, options) {
  if (point) {
    robot.moveMouseSmooth(point.x, point.y);
  }

  if (typeof options.button === "undefined") {
    if (options.double) {
      robot.mouseClick("left", true);
    } else {
      robot.mouseClick();
    }
  } else if (options.double) {
    robot.mouseClick(options.button, true);
  } else {
    robot.mouseClick(options.button);
  }
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function takeTextQuery(command, positionals, options) {
  const queryParts = positionals.slice();
  const supportsPositionalIndex = command === "clickText" || command === "clickWord";
  const lastPart = queryParts[queryParts.length - 1];

  if (
    supportsPositionalIndex &&
    typeof options.index === "undefined" &&
    queryParts.length > 1 &&
    /^-?\d+$/.test(lastPart)
  ) {
    options.index = lastPart;
    queryParts.pop();
  }

  return queryParts.join(" ");
}


function projectSubstringBounds(bounds, observationText, queryText, startIndex) {
  if (startIndex <= 0 || observationText.length === 0 || observationText.length === queryText.length) {
    return bounds;
  }

  const startRatio = startIndex / observationText.length;
  const endRatio = (startIndex + queryText.length) / observationText.length;

  return {
    x: bounds.x + (bounds.width * startRatio),
    y: bounds.y,
    width: Math.max(bounds.width * (endRatio - startRatio), 1),
    height: bounds.height
  };
}

function getScreenPointForBounds(capture, bounds) {
  return capture.toScreenPoint(
    { x: bounds.x, y: bounds.y },
    { width: bounds.width, height: bounds.height }
  );
}

function rankTextMatches(query, ocrItems, options) {
  const observations = Array.isArray(ocrItems) ? ocrItems : [];
  const normalizedQuery = normalizeText(query);
  const exact = !!options.exact;
  const minConfidence = typeof options.confidence === "undefined" ? 0 : toNumber(options.confidence, "confidence");
  const matches = [];

  if (!normalizedQuery) {
    throw createCliError("Text query cannot be empty.", "INVALID_ARGUMENT");
  }

  observations.forEach((observation) => {
    const normalizedObservation = normalizeText(observation.text);
    const confidence = typeof observation.confidence === "number" ? observation.confidence : 0;
    let matchKind;
    let startIndex = -1;

    if (!normalizedObservation || confidence < minConfidence) {
      return;
    }

    if (normalizedObservation === normalizedQuery) {
      matchKind = "exact";
      startIndex = 0;
    } else if (!exact) {
      startIndex = normalizedObservation.indexOf(normalizedQuery);
      if (startIndex === -1) {
        return;
      }

      matchKind = normalizedObservation.startsWith(normalizedQuery) ? "startsWith" : "contains";
    } else {
      return;
    }

    const rawBounds = observation.bounds;

    matches.push({
      text: observation.text,
      confidence: confidence,
      rawBounds: rawBounds,
      bounds: matchKind === "exact"
        ? rawBounds
        : projectSubstringBounds(rawBounds, normalizedObservation, normalizedQuery, startIndex),
      matchType: matchKind,
      textLength: normalizedObservation.length
    });
  });

  matches.sort((left, right) => {
    const rank = { exact: 0, startsWith: 1, contains: 2 };

    if (rank[left.matchType] !== rank[right.matchType]) {
      return rank[left.matchType] - rank[right.matchType];
    }

    if (left.textLength !== right.textLength) {
      return left.textLength - right.textLength;
    }

    return right.confidence - left.confidence;
  });

  return matches;
}

function resolveExternalOcrBinary(cwd, options, context) {
  const explicit = options.ocr || process.env.ROBOT_OCR_PATH || context.ocrPath;
  return explicit ? resolveExecutablePath(cwd, explicit) : null;
}

function getOcrBackend(options, context) {
  if (context.activeOcrBackend) {
    return context.activeOcrBackend;
  }

  const binary = resolveExternalOcrBinary(context.cwd, options, context);
  const backend = context.ocrBackend || (binary
    ? createExternalBackend(binary, context.runProcess || runProcess)
    : createPaddleBackend());

  if (!backend || typeof backend.recognize !== "function") {
    throw createCliError("OCR backend must provide a recognize method.", "OCR_BACKEND_INVALID");
  }

  context.activeOcrBackend = backend;
  context.ownsOcrBackend = !context.ocrBackend;
  return backend;
}

async function disposeOcrBackend(context) {
  if (
    context &&
    context.ownsOcrBackend &&
    context.activeOcrBackend &&
    typeof context.activeOcrBackend.destroy === "function"
  ) {
    await context.activeOcrBackend.destroy();
  }
}

function runProcess(command, args, label) {
  const result = spawnSync(command, args, { encoding: "utf8" });

  if (result.error) {
    throw createCliError(`${label} failed: ${result.error.message}`, "PROCESS_ERROR");
  }

  if (result.status !== 0) {
    const details = (result.stderr || result.stdout || "").trim();
    throw createCliError(
      `${label} exited with code ${result.status}: ${details}`,
      "PROCESS_ERROR"
    );
  }

  return result.stdout;
}

function saveCaptureForOCR(capture, tempDir) {
  const bmpPath = path.join(tempDir, "capture.bmp");

  if (!capture.save(bmpPath)) {
    throw createCliError("Failed to save capture for OCR.", "OCR_ERROR");
  }

  const buffer = fs.readFileSync(bmpPath);
  return {
    image: toArrayBuffer(buffer),
    imagePath: bmpPath
  };
}

async function performOCR(captureInput, options, context) {
  const backend = getOcrBackend(options, context);

  try {
    return await backend.recognize(captureInput.image, {
      imagePath: captureInput.imagePath,
      recLangs: options["rec-langs"]
    });
  } catch (error) {
    if (error && !error.code) {
      error.code = "OCR_ERROR";
    }

    throw error;
  }
}

async function scanTextCapture(capture, query, options, context) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "robot-ocr-"));
  let captureInput = null;

  try {
    captureInput = saveCaptureForOCR(capture, tempDir);
    const ocrItems = await performOCR(captureInput, options, context);
    return {
      capture: capture,
      captureImagePath: captureInput.imagePath,
      captureTempDir: tempDir,
      matches: rankTextMatches(query, ocrItems, options)
    };
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

function disposeTextCapture(result) {
  if (result && result.captureTempDir) {
    fs.rmSync(result.captureTempDir, { recursive: true, force: true });
  }
}

async function collectTextMatch(robot, query, rect, options, context) {
  const requestedIndex = typeof options.index === "undefined" ? 1 : toInteger(options.index, "index");

  if (requestedIndex < 1) {
    throw createCliError("index must be greater than or equal to 1.", "INVALID_ARGUMENT");
  }

  const searchRects = getTextSearchRects(robot, rect);
  const instances = [];
  let retainedResult = null;
  let selected = null;
  let selectedInstance = null;

  for (let displayIndex = 0; displayIndex < searchRects.length; displayIndex += 1) {
    const capture = captureWithRect(robot, searchRects[displayIndex]);
    const result = await scanTextCapture(capture, query, options, context);
    const firstInstanceIndex = instances.length;

    result.matches.forEach((match) => {
      instances.push({
        index: instances.length + 1,
        displayIndex: displayIndex + 1,
        text: match.text,
        confidence: match.confidence,
        matchType: match.matchType,
        bounds: match.bounds,
        rawBounds: match.rawBounds,
        screenPoint: getScreenPointForBounds(result.capture, match.bounds)
      });
    });

    const localIndex = requestedIndex - firstInstanceIndex - 1;

    if (!selected && localIndex >= 0 && localIndex < result.matches.length) {
      selected = result.matches[localIndex];
      selectedInstance = instances[firstInstanceIndex + localIndex];

      if (retainedResult) {
        disposeTextCapture(retainedResult);
      }

      retainedResult = result;
    } else if (selected) {
      disposeTextCapture(result);
    } else {
      if (retainedResult) {
        disposeTextCapture(retainedResult);
      }

      retainedResult = result;
    }
  }

  return {
    capture: retainedResult.capture,
    captureImagePath: retainedResult.captureImagePath,
    captureTempDir: retainedResult.captureTempDir,
    matches: retainedResult.matches,
    instances: instances,
    requestedIndex: requestedIndex,
    selected: selected,
    screenPoint: selectedInstance ? selectedInstance.screenPoint : null,
    candidateCount: instances.length
  };
}

function finalizeCaptureTempDir(result, options) {
  if (!options["keep-capture"] && result.captureTempDir) {
    fs.rmSync(result.captureTempDir, { recursive: true, force: true });
  }
}

function buildTextResult(command, query, result, options) {
  return {
    ok: true,
    command: command,
    query: query,
    found: !!result.selected,
    text: result.selected ? result.selected.text : null,
    confidence: result.selected ? result.selected.confidence : null,
    matchType: result.selected ? result.selected.matchType : null,
    bounds: result.selected ? result.selected.bounds : null,
    rawBounds: result.selected ? result.selected.rawBounds : null,
    screenPoint: result.screenPoint,
    candidateCount: result.candidateCount,
    matches: result.instances,
    selectedIndex: result.selected ? result.requestedIndex : null,
    capture: getCaptureMetadata(result.capture),
    captureImagePath: options["keep-capture"] ? result.captureImagePath : undefined,
    button: command === "clickText" || command === "clickWord" ? options.button || "left" : undefined,
    double: command === "clickText" || command === "clickWord" ? !!options.double : undefined
  };
}

const DEFAULT_WAIT_TIMEOUT_MS = 30000;
const WAIT_RETRY_INTERVAL_MS = 100;

function getWaitTimeout(options) {
  const timeout = typeof options.timeout === "undefined"
    ? DEFAULT_WAIT_TIMEOUT_MS
    : toNumber(options.timeout, "timeout");

  if (timeout < 0) {
    throw createCliError("timeout must be greater than or equal to 0.", "INVALID_ARGUMENT");
  }

  return timeout;
}

async function waitForObservation(observe, isFound, options, context, disposeOnRetry) {
  const timeout = getWaitTimeout(options);
  const now = typeof context.now === "function" ? context.now : Date.now;
  const sleep = typeof context.sleep === "function"
    ? context.sleep
    : (duration) => new Promise((resolve) => setTimeout(resolve, duration));
  const startedAt = now();
  let attempts = 0;

  while (true) {
    attempts += 1;
    const value = await observe();
    const elapsedMs = Math.max(now() - startedAt, 0);

    if (isFound(value)) {
      return { value, attempts, elapsedMs, timedOut: false };
    }

    if (elapsedMs >= timeout) {
      return { value, attempts, elapsedMs, timedOut: true };
    }

    if (disposeOnRetry) {
      disposeOnRetry(value);
    }

    await sleep(Math.min(WAIT_RETRY_INTERVAL_MS, timeout - elapsedMs));
  }
}

function collectImageMatch(robot, needle, rect, searchOptions) {
  const capture = captureWithRect(robot, rect);
  const match = capture.findImage(needle, searchOptions);

  return {
    capture,
    match,
    screenPoint: match ? capture.toScreenPoint(match, needle) : null
  };
}

function buildImageResult(command, targetPath, result, searchOptions, options) {
  return {
    ok: true,
    command: command,
    image: targetPath,
    found: !!result.match,
    match: result.match,
    screenPoint: result.screenPoint,
    capture: getCaptureMetadata(result.capture),
    tolerance: typeof searchOptions.tolerance === "number" ? searchOptions.tolerance : null,
    button: command === "clickImage" ? options.button || "left" : undefined,
    double: command === "clickImage" ? !!options.double : undefined
  };
}

function getApplicationController(context) {
  return context.applicationController || createApplicationController(
    context.platform || process.platform,
    context.runProcess || runProcess
  );
}

async function execute(command, argv, context) {
  const parsed = parseArgv(argv);
  const options = parsed.options;
  const positionals = parsed.positionals;
  const robot = context.robot;
  const cwd = context.cwd;

  if (options.help) {
    return { help: true };
  }

  switch (command) {
    case "openApp":
    case "activateApp": {
      const application = positionals.join(" ").trim();

      if (!application) {
        throw createCliError(`${command} expects an application name.`, "INVALID_ARGUMENT");
      }

      const controller = getApplicationController(context);
      const resolved = command === "openApp"
        ? await controller.open(application)
        : await controller.activate(application);

      return {
        ok: true,
        command: command,
        application: resolved.requested,
        target: resolved.target
      };
    }

    case "screenshot": {
      const rect = takeRect(positionals, options);
      const outputPath = resolveInputPath(cwd, options.output, "output path");
      const capture = captureWithRect(robot, rect);

      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      capture.save(outputPath);

      return {
        ok: true,
        command: "screenshot",
        output: outputPath,
        capture: getCaptureMetadata(capture)
      };
    }

    case "moveMouse": {
      if (positionals.length !== 2) {
        throw createCliError("moveMouse expects x and y.", "INVALID_ARGUMENT");
      }

      const x = toNumber(positionals[0], "x");
      const y = toNumber(positionals[1], "y");
      robot.moveMouseSmooth(x, y);

      return {
        ok: true,
        command: "moveMouse",
        x: x,
        y: y
      };
    }

    case "click": {
      if (positionals.length !== 0 && positionals.length !== 2) {
        throw createCliError("click expects zero arguments or x and y.", "INVALID_ARGUMENT");
      }

      let point = null;

      if (positionals.length === 2) {
        point = {
          x: toNumber(positionals[0], "x"),
          y: toNumber(positionals[1], "y")
        };
      }

      performClick(robot, point, options);

      return {
        ok: true,
        command: "click",
        x: point ? point.x : undefined,
        y: point ? point.y : undefined,
        button: options.button || "left",
        double: !!options.double
      };
    }

    case "type": {
      const text = positionals.join(" ");

      if (!text) {
        throw createCliError("type expects text to type.", "INVALID_ARGUMENT");
      }

      if (typeof options.cpm === "undefined") {
        robot.typeString(text);
      } else {
        robot.typeStringDelayed(text, toNumber(options.cpm, "cpm"));
      }

      return {
        ok: true,
        command: "type",
        text: text,
        cpm: typeof options.cpm === "undefined" ? null : toNumber(options.cpm, "cpm")
      };
    }

    case "keyTap": {
      if (positionals.length < 1) {
        throw createCliError("keyTap expects a key and optional modifiers.", "INVALID_ARGUMENT");
      }

      const key = positionals[0];
      const modifiers = positionals.slice(1);

      if (modifiers.length === 0) {
        robot.keyTap(key);
      } else if (modifiers.length === 1) {
        robot.keyTap(key, modifiers[0]);
      } else {
        robot.keyTap(key, modifiers);
      }

      return {
        ok: true,
        command: "keyTap",
        key: key,
        modifiers: modifiers
      };
    }

    case "scrollMouse": {
      if (positionals.length !== 2) {
        throw createCliError("scrollMouse expects x and y deltas.", "INVALID_ARGUMENT");
      }

      const x = toNumber(positionals[0], "x");
      const y = toNumber(positionals[1], "y");
      robot.scrollMouse(x, y);

      return {
        ok: true,
        command: "scrollMouse",
        x: x,
        y: y
      };
    }

    case "mousePos": {
      const mouse = robot.getMousePos();

      return {
        ok: true,
        command: "mousePos",
        x: mouse.x,
        y: mouse.y
      };
    }

    case "screenSize": {
      return {
        ok: true,
        command: "screenSize",
        size: robot.getScreenSize()
      };
    }

    case "pixelColor": {
      if (positionals.length !== 2) {
        throw createCliError("pixelColor expects x and y.", "INVALID_ARGUMENT");
      }

      const x = toNumber(positionals[0], "x");
      const y = toNumber(positionals[1], "y");

      return {
        ok: true,
        command: "pixelColor",
        x: x,
        y: y,
        color: robot.getPixelColor(x, y)
      };
    }

    case "findImage":
    case "clickImage":
    case "waitForImage": {
      if (positionals.length !== 1) {
        throw createCliError(`${command} expects exactly one image path.`, "INVALID_ARGUMENT");
      }

      const targetPath = resolveInputPath(cwd, positionals[0], "image path");
      const rect = takeRect([], options);
      const needle = robot.image.load(targetPath);
      const searchOptions = getSearchOptions(options);
      let result;
      let waitResult = null;

      if (command === "waitForImage") {
        waitResult = await waitForObservation(
          () => collectImageMatch(robot, needle, rect, searchOptions),
          (observation) => !!observation.match,
          options,
          context
        );
        result = waitResult.value;
      } else {
        result = collectImageMatch(robot, needle, rect, searchOptions);
      }

      if (command === "clickImage" && result.screenPoint) {
        performClick(robot, result.screenPoint, options);
      }

      const output = buildImageResult(command, targetPath, result, searchOptions, options);

      if (waitResult) {
        output.attempts = waitResult.attempts;
        output.elapsedMs = waitResult.elapsedMs;
        output.timedOut = waitResult.timedOut;
      }

      return output;
    }

    case "text": {
      const searchRects = getTextSearchRects(robot, null);
      const displays = [];
      const allText = [];

      for (let i = 0; i < searchRects.length; i += 1) {
        const capture = captureWithRect(robot, searchRects[i]);
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "robot-ocr-"));

        try {
          const captureInput = saveCaptureForOCR(capture, tempDir);
          const ocrItems = await performOCR(captureInput, options, context);
          const texts = ocrItems
            .map(function (item) { return item.text; })
            .filter(function (text) { return typeof text === "string" && text.length > 0; });

          displays.push({
            displayId: i + 1,
            screenX: capture.screenX || 0,
            screenY: capture.screenY || 0,
            width: capture.width,
            height: capture.height,
            text: texts
          });

          for (let j = 0; j < texts.length; j += 1) {
            allText.push(texts[j]);
          }
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }

      return {
        ok: true,
        command: "text",
        displays: displays,
        allText: allText
      };
    }

    case "findText":
    case "clickText":
    case "findWord":
    case "clickWord":
    case "waitForText": {
      const query = takeTextQuery(command, positionals, options);

      if (!query) {
        throw createCliError(`${command} expects text to search for.`, "INVALID_ARGUMENT");
      }

      const rect = takeRect([], options);
      let textResult;
      let waitResult = null;

      if (command === "waitForText") {
        waitResult = await waitForObservation(
          () => collectTextMatch(robot, query, rect, options, context),
          (observation) => !!observation.selected,
          options,
          context,
          disposeTextCapture
        );
        textResult = waitResult.value;
      } else {
        textResult = await collectTextMatch(robot, query, rect, options, context);
      }

      try {
        if ((command === "clickText" || command === "clickWord") && textResult.screenPoint) {
          performClick(robot, textResult.screenPoint, options);
        }

        const output = buildTextResult(command, query, textResult, options);

        if (waitResult) {
          output.attempts = waitResult.attempts;
          output.elapsedMs = waitResult.elapsedMs;
          output.timedOut = waitResult.timedOut;
        }

        return output;
      } finally {
        finalizeCaptureTempDir(textResult, options);
      }
    }

    default:
      throw createCliError(`Unknown command: ${command}`, "UNKNOWN_COMMAND", 1);
  }
}

function formatJson(value, pretty) {
  return `${JSON.stringify(value, null, pretty ? 2 : 0)}\n`;
}

async function run(argv, overrides) {
  const context = overrides || {};
  const stdout = context.stdout || process.stdout;
  const stderr = context.stderr || process.stderr;
  const cwd = context.cwd || process.cwd();
  const command = argv[0];

  try {
    if (!command || command === "help" || command === "--help" || command === "-h") {
      stdout.write(HELP_TEXT);
      return 0;
    }

    const needsRobot = command !== "openApp" && command !== "activateApp";
    const executionContext = {
      cwd: cwd,
      robot: context.robot || (needsRobot ? loadRobot() : null),
      ocrBackend: context.ocrBackend,
      ocrPath: context.ocrPath,
      runProcess: context.runProcess,
      applicationController: context.applicationController,
      platform: context.platform,
      now: context.now,
      sleep: context.sleep
    };
    let result;

    try {
      result = await execute(command, argv.slice(1), executionContext);
    } finally {
      await disposeOcrBackend(executionContext);
    }

    if (result.help) {
      stdout.write(HELP_TEXT);
      return 0;
    }

    stdout.write(formatJson(result, !!context.pretty));
    return 0;
  } catch (error) {
    stderr.write(formatJson({
      ok: false,
      code: error.code || "CLI_ERROR",
      error: error.message
    }, !!context.pretty));
    return typeof error.exitCode === "number" ? error.exitCode : 1;
  }
}

module.exports = {
  execute,
  run,
  HELP_TEXT
};
