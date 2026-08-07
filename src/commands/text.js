import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "incur";
import { toArrayBuffer } from "../ocr.js";
import {
  captureSchema,
  captureWithRect,
  clickOptionsShape,
  createCommandError,
  getCaptureMetadata,
  indexSchema,
  performClick,
  pointSchema,
  rectangleOptionsShape,
  rectSchema,
  resolveWindowScope,
  timeoutSchema,
  waitForObservation,
  waitMetadataShape,
  windowOptionShape
} from "./shared.js";

const matchTypeSchema = z.enum(["exact", "startsWith", "contains"]);
const TEXT_MATCH_RANK = { exact: 0, startsWith: 1, contains: 2 };

const textBackendOptionsShape = {
  ocr: z.string().optional().describe("External OCR executable path or command"),
  recLangs: z.string().optional().describe("OCR recognition languages"),
  ocrStrategy: z.enum(["per-box", "per-line", "cross-line"])
    .default("per-box")
    .describe("Paddle OCR recognition strategy")
};

const textMatchOptions = z.object({
  ...rectangleOptionsShape,
  ...windowOptionShape,
  confidence: z.number().default(0).describe("Minimum OCR confidence"),
  index: indexSchema,
  exact: z.boolean().optional().describe("Require an exact text match"),
  ...textBackendOptionsShape,
  keepCapture: z.boolean().optional().describe("Keep the selected OCR capture")
});

const textQueryArgs = z.object({
  query: z.array(z.string()).describe("Text query words")
});

const matchEntrySchema = z.object({
  index: z.number().int().describe("One-based global match index"),
  displayIndex: z.number().int().describe("One-based display index"),
  text: z.string().describe("Recognized text"),
  confidence: z.number().describe("OCR confidence"),
  matchType: matchTypeSchema.describe("Text match ranking type"),
  bounds: rectSchema.describe("Matched substring bounds"),
  rawBounds: rectSchema.describe("Original OCR bounds"),
  screenPoint: pointSchema.describe("Screen point for the match")
});

const textMatchOutput = z.object({
  query: z.string().describe("Normalized command query"),
  found: z.boolean().describe("Whether a matching occurrence was found"),
  text: z.string().nullable().describe("Selected recognized text"),
  confidence: z.number().nullable().describe("Selected OCR confidence"),
  matchType: matchTypeSchema.nullable().describe("Selected text match type"),
  bounds: rectSchema.nullable().describe("Selected substring bounds"),
  rawBounds: rectSchema.nullable().describe("Selected original OCR bounds"),
  screenPoint: pointSchema.nullable().describe("Selected screen point"),
  candidateCount: z.number().int().describe("Total matching occurrences"),
  matches: z.array(matchEntrySchema).describe("Ranked matching occurrences"),
  selectedIndex: z.number().int().nullable().describe("Selected one-based occurrence"),
  capture: captureSchema.describe("Selected capture metadata"),
  captureImagePath: z.string().optional().describe("Retained OCR capture path")
});

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function projectSubstringBounds(bounds, observationText, queryText, startIndex) {
  if (startIndex < 0 || observationText.length === 0 || observationText.length === queryText.length) {
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

function rankTextMatches(query, ocrItems, options) {
  const observations = Array.isArray(ocrItems) ? ocrItems : [];
  const normalizedQuery = normalizeText(query);
  const matches = [];

  if (!normalizedQuery) {
    throw createCommandError("Text query cannot be empty.", "INVALID_ARGUMENT");
  }

  for (const observation of observations) {
    const normalizedObservation = normalizeText(observation.text);
    const confidence = typeof observation.confidence === "number" ? observation.confidence : 0;
    let matchType;
    let startIndex = -1;

    if (!normalizedObservation || confidence < options.confidence) {
      continue;
    }

    if (normalizedObservation === normalizedQuery) {
      matchType = "exact";
      startIndex = 0;
    } else if (!options.exact) {
      startIndex = normalizedObservation.indexOf(normalizedQuery);
      if (startIndex === -1) {
        continue;
      }
      matchType = normalizedObservation.startsWith(normalizedQuery) ? "startsWith" : "contains";
    } else {
      continue;
    }

    const rawBounds = observation.bounds;
    matches.push({
      text: observation.text,
      confidence,
      rawBounds,
      bounds: matchType === "exact"
        ? rawBounds
        : projectSubstringBounds(rawBounds, normalizedObservation, normalizedQuery, startIndex),
      matchType,
      textLength: normalizedObservation.length
    });
  }

  matches.sort((left, right) => {
    if (TEXT_MATCH_RANK[left.matchType] !== TEXT_MATCH_RANK[right.matchType]) {
      return TEXT_MATCH_RANK[left.matchType] - TEXT_MATCH_RANK[right.matchType];
    }

    if (left.textLength !== right.textLength) {
      return left.textLength - right.textLength;
    }

    return right.confidence - left.confidence;
  });

  return matches;
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

function saveCaptureForOcr(capture, tempDir) {
  const imagePath = path.join(tempDir, "capture.bmp");

  if (!capture.save(imagePath)) {
    throw createCommandError("Failed to save capture for OCR.", "OCR_ERROR");
  }

  return {
    image: toArrayBuffer(fs.readFileSync(imagePath)),
    imagePath
  };
}

async function performOcr(captureInput, options, runtime) {
  const backend = runtime.getOcrBackend(options);

  try {
    return await backend.recognize(captureInput.image, {
      imagePath: captureInput.imagePath,
      recLangs: options.recLangs,
      strategy: options.ocrStrategy
    });
  } catch (error) {
    if (error && !error.code) {
      error.code = "OCR_ERROR";
    }
    throw error;
  }
}

async function scanTextCapture(capture, query, options, runtime) {
  const captureTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "robot-ocr-"));

  try {
    const captureInput = saveCaptureForOcr(capture, captureTempDir);
    const ocrItems = await performOcr(captureInput, options, runtime);
    return {
      capture,
      captureImagePath: captureInput.imagePath,
      captureTempDir,
      matches: rankTextMatches(query, ocrItems, options)
    };
  } catch (error) {
    fs.rmSync(captureTempDir, { recursive: true, force: true });
    throw error;
  }
}

function disposeTextCapture(result) {
  if (result?.captureTempDir) {
    fs.rmSync(result.captureTempDir, { recursive: true, force: true });
  }
}

function getScreenPointForBounds(capture, bounds) {
  return capture.toScreenPoint(
    { x: bounds.x, y: bounds.y },
    { width: bounds.width, height: bounds.height }
  );
}

async function collectTextMatch(robot, query, rect, options, runtime) {
  const requestedIndex = options.index === undefined ? 1 : options.index;

  if (!Number.isInteger(requestedIndex) || requestedIndex < 1) {
    throw createCommandError("index must be an integer greater than or equal to 1.", "INVALID_ARGUMENT");
  }

  const searchRects = getTextSearchRects(robot, rect);
  const instances = [];
  let retainedResult = null;
  let selected = null;
  let selectedInstance = null;

  try {
    for (let displayIndex = 0; displayIndex < searchRects.length; displayIndex += 1) {
      const capture = captureWithRect(robot, searchRects[displayIndex]);
      const result = await scanTextCapture(capture, query, options, runtime);
      const firstInstanceIndex = instances.length;

      for (const match of result.matches) {
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
      }

      const localIndex = requestedIndex - firstInstanceIndex - 1;
      if (!selected && localIndex >= 0 && localIndex < result.matches.length) {
        selected = result.matches[localIndex];
        selectedInstance = instances[firstInstanceIndex + localIndex];
        disposeTextCapture(retainedResult);
        retainedResult = result;
      } else if (selected) {
        disposeTextCapture(result);
      } else {
        disposeTextCapture(retainedResult);
        retainedResult = result;
      }
    }
  } catch (error) {
    disposeTextCapture(retainedResult);
    throw error;
  }

  return {
    capture: retainedResult.capture,
    captureImagePath: retainedResult.captureImagePath,
    captureTempDir: retainedResult.captureTempDir,
    instances,
    requestedIndex,
    selected,
    screenPoint: selectedInstance ? selectedInstance.screenPoint : null,
    candidateCount: instances.length
  };
}

function resolveTextQuery(parts, index, supportsTrailingIndex) {
  const queryParts = [...parts];
  let selectedIndex = index;
  const finalPart = queryParts[queryParts.length - 1];

  if (
    supportsTrailingIndex &&
    selectedIndex === undefined &&
    queryParts.length > 1 &&
    /^-?\d+$/.test(finalPart)
  ) {
    selectedIndex = Number(finalPart);
    queryParts.pop();
  }

  const query = queryParts.join(" ");
  if (!query) {
    throw createCommandError("Text query cannot be empty.", "INVALID_ARGUMENT");
  }

  return { query, index: selectedIndex };
}

function buildTextResult(query, result, options) {
  const output = {
    query,
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
    capture: getCaptureMetadata(result.capture)
  };

  if (options.keepCapture) {
    output.captureImagePath = result.captureImagePath;
  }

  return output;
}

function createTextMatchCommand({ description, click = false, wait = false }) {
  let options = textMatchOptions;
  let output = textMatchOutput;

  if (click) {
    options = options.extend(clickOptionsShape);
    output = output.extend({
      button: z.enum(["left", "middle", "right"]).describe("Mouse button used"),
      double: z.boolean().describe("Whether a double-click was used")
    });
  }

  if (wait) {
    options = options.extend({ timeout: timeoutSchema });
    output = output.extend(waitMetadataShape);
  }

  return {
    description,
    args: textQueryArgs,
    options,
    output,
    ...(click ? {
      hint: "A trailing integer selects the 1-based occurrence; quote a query ending in a number to keep it as text. --index takes precedence."
    } : {}),
    async run(c) {
      const runtime = c.var.runtime;
      const robot = runtime.getRobot();
      const resolved = resolveTextQuery(c.args.query, c.options.index, click);
      const searchOptions = { ...c.options, index: resolved.index };
      const { rect } = await resolveWindowScope(runtime, {}, searchOptions, { activate: true });
      let textResult;
      let waitResult;

      if (wait) {
        waitResult = await waitForObservation(
          () => collectTextMatch(robot, resolved.query, rect, searchOptions, runtime),
          (value) => !!value.selected,
          searchOptions,
          runtime,
          disposeTextCapture
        );
        textResult = waitResult.value;
      } else {
        textResult = await collectTextMatch(robot, resolved.query, rect, searchOptions, runtime);
      }

      try {
        if (click && textResult.screenPoint) {
          performClick(robot, textResult.screenPoint, searchOptions);
        }

        const result = buildTextResult(resolved.query, textResult, searchOptions);
        if (click) {
          result.button = searchOptions.button || "left";
          result.double = !!searchOptions.double;
        }
        if (waitResult) {
          result.attempts = waitResult.attempts;
          result.elapsedMs = waitResult.elapsedMs;
          result.timedOut = waitResult.timedOut;
        }
        return result;
      } finally {
        if (!searchOptions.keepCapture) {
          disposeTextCapture(textResult);
        }
      }
    }
  };
}

export function registerTextCommands(cli) {
  cli.command("text", {
    description: "Recognize text across the current displays.",
    options: z.object({ ...textBackendOptionsShape, ...windowOptionShape }),
    output: z.object({
      displays: z.array(z.object({
        displayId: z.number().int().describe("One-based display index"),
        screenX: z.number().describe("Display left screen coordinate"),
        screenY: z.number().describe("Display top screen coordinate"),
        width: z.number().describe("Display capture width"),
        height: z.number().describe("Display capture height"),
        text: z.array(z.string()).describe("Recognized display text")
      })).describe("Per-display OCR results"),
      allText: z.array(z.string()).describe("Recognized text across all displays")
    }),
    async run(c) {
      const runtime = c.var.runtime;
      const robot = runtime.getRobot();
      const { rect } = await resolveWindowScope(runtime, {}, c.options, { activate: true });
      const searchRects = getTextSearchRects(robot, rect);
      const displays = [];
      const allText = [];

      for (let displayIndex = 0; displayIndex < searchRects.length; displayIndex += 1) {
        const capture = captureWithRect(robot, searchRects[displayIndex]);
        const captureTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "robot-ocr-"));

        try {
          const captureInput = saveCaptureForOcr(capture, captureTempDir);
          const ocrItems = await performOcr(captureInput, c.options, runtime);
          const text = ocrItems
            .map((item) => item.text)
            .filter((value) => typeof value === "string" && value.length > 0);

          displays.push({
            displayId: displayIndex + 1,
            screenX: capture.screenX || 0,
            screenY: capture.screenY || 0,
            width: capture.width,
            height: capture.height,
            text
          });
          allText.push(...text);
        } finally {
          fs.rmSync(captureTempDir, { recursive: true, force: true });
        }
      }

      return { displays, allText };
    }
  });

  cli.command("findText", createTextMatchCommand({
    description: "Find matching OCR text on the current screen."
  }));
  cli.command("findWord", createTextMatchCommand({
    description: "Find a matching OCR word on the current screen."
  }));
  cli.command("clickText", createTextMatchCommand({
    description: "Find and click matching OCR text on the current screen.",
    click: true
  }));
  cli.command("clickWord", createTextMatchCommand({
    description: "Find and click a matching OCR word on the current screen.",
    click: true
  }));
  cli.command("waitForText", createTextMatchCommand({
    description: "Wait for matching OCR text to appear on the current screen.",
    wait: true
  }));

  return cli;
}
