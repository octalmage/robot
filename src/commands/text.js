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

const matchTypeSchema = z.enum(["exact", "startsWith", "contains", "fuzzy"]);
const TEXT_MATCH_RANK = { exact: 0, startsWith: 1, contains: 2, fuzzy: 3 };
const MIN_FUZZY_QUERY_LENGTH = 4;

export const textBackendOptionsShape = {
  ocr: z.string().optional().describe("External OCR executable path or command"),
  recLangs: z.string().optional().describe("OCR recognition languages"),
  ocrModel: z.enum(["tiny", "small"]).optional().describe("Paddle OCR model size; built-in default: tiny"),
  ocrStrategy: z.enum(["per-box", "per-line", "cross-line"])
    .optional()
    .describe("Paddle OCR recognition strategy; built-in default: per-box")
};

const textMatchOptions = z.object({
  ...rectangleOptionsShape,
  ...windowOptionShape,
  confidence: z.number().default(0).describe("Minimum OCR confidence"),
  index: indexSchema,
  exact: z.boolean().optional().describe("Require an exact text match"),
  fuzzy: z.boolean().optional().describe("Allow one OCR character error in queries of four or more characters"),
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
  editDistance: z.number().int().nullable().describe("Fuzzy edit distance"),
  similarity: z.number().nullable().describe("Fuzzy similarity from zero to one"),
  bounds: rectSchema.describe("Matched substring bounds"),
  rawBounds: rectSchema.describe("Original OCR bounds"),
  screenPoint: pointSchema.describe("Screen point for the match")
});

const textMatchOutput = z.object({
  query: z.string().describe("Normalized command query"),
  ocrModel: z.enum(["tiny", "small"]).describe("Applied Paddle OCR model size"),
  ocrStrategy: z.enum(["per-box", "per-line", "cross-line"]).describe("Applied OCR recognition strategy"),
  fuzzy: z.boolean().describe("Whether strict-first fuzzy fallback was enabled"),
  found: z.boolean().describe("Whether a matching occurrence was found"),
  ambiguous: z.boolean().describe("Whether equally ranked fuzzy matches prevented automatic selection"),
  text: z.string().nullable().describe("Selected recognized text"),
  confidence: z.number().nullable().describe("Selected OCR confidence"),
  matchType: matchTypeSchema.nullable().describe("Selected text match type"),
  editDistance: z.number().int().nullable().describe("Selected fuzzy edit distance"),
  similarity: z.number().nullable().describe("Selected fuzzy similarity from zero to one"),
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

function normalizeFuzzyText(value) {
  return normalizeText(value)
    .replace(/([\p{L}\p{N}])[\p{P}\p{S}]+(?=[\p{L}\p{N}])/gu, "$1");
}

function getSingleEditDistance(left, right) {
  if (left === right) {
    return 0;
  }

  const leftCharacters = Array.from(left);
  const rightCharacters = Array.from(right);
  const lengthDifference = leftCharacters.length - rightCharacters.length;
  if (Math.abs(lengthDifference) > 1) {
    return null;
  }

  if (lengthDifference === 0) {
    let differences = 0;
    for (let index = 0; index < leftCharacters.length; index += 1) {
      if (leftCharacters[index] !== rightCharacters[index]) {
        differences += 1;
        if (differences > 1) {
          return null;
        }
      }
    }
    return 1;
  }

  const shorter = lengthDifference < 0 ? leftCharacters : rightCharacters;
  const longer = lengthDifference < 0 ? rightCharacters : leftCharacters;
  let shorterIndex = 0;
  let longerIndex = 0;
  let skipped = false;

  while (shorterIndex < shorter.length && longerIndex < longer.length) {
    if (shorter[shorterIndex] === longer[longerIndex]) {
      shorterIndex += 1;
      longerIndex += 1;
      continue;
    }
    if (skipped) {
      return null;
    }
    skipped = true;
    longerIndex += 1;
  }

  return 1;
}

function compareFuzzyQuality(left, right) {
  if (left.editDistance !== right.editDistance) {
    return left.editDistance - right.editDistance;
  }
  return right.similarity - left.similarity;
}

function findFuzzyCandidates(query, observation) {
  const normalizedQuery = normalizeFuzzyText(query);
  const comparableQueryLength = Array.from(normalizedQuery.replace(/\s/g, "")).length;
  if (comparableQueryLength < MIN_FUZZY_QUERY_LENGTH) {
    return [];
  }

  const normalizedObservation = normalizeText(observation);
  const tokens = Array.from(normalizedObservation.matchAll(/\S+/g), (match) => ({
    start: match.index,
    end: match.index + match[0].length
  }));
  const queryWordCount = normalizedQuery.split(" ").length;
  const minimumWords = Math.max(1, queryWordCount - 1);
  const maximumWords = Math.min(tokens.length, queryWordCount + 1);
  const candidates = [];

  for (let wordCount = minimumWords; wordCount <= maximumWords; wordCount += 1) {
    for (let startToken = 0; startToken + wordCount <= tokens.length; startToken += 1) {
      const startIndex = tokens[startToken].start;
      const endIndex = tokens[startToken + wordCount - 1].end;
      const candidateText = normalizeFuzzyText(normalizedObservation.slice(startIndex, endIndex));
      const editDistance = getSingleEditDistance(normalizedQuery, candidateText);
      if (editDistance === null) {
        continue;
      }

      const candidateLength = Array.from(candidateText).length;
      const queryLength = Array.from(normalizedQuery).length;
      candidates.push({
        startIndex,
        matchedText: normalizedObservation.slice(startIndex, endIndex),
        editDistance,
        similarity: 1 - (editDistance / Math.max(queryLength, candidateLength))
      });
    }
  }

  candidates.sort((left, right) => compareFuzzyQuality(left, right) || left.startIndex - right.startIndex);
  if (candidates.length === 0) {
    return candidates;
  }

  const best = candidates[0];
  return candidates.filter((candidate) => compareFuzzyQuality(candidate, best) === 0);
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

function compareTextMatches(left, right) {
  if (TEXT_MATCH_RANK[left.matchType] !== TEXT_MATCH_RANK[right.matchType]) {
    return TEXT_MATCH_RANK[left.matchType] - TEXT_MATCH_RANK[right.matchType];
  }
  if (left.matchType === "fuzzy") {
    const fuzzyOrder = compareFuzzyQuality(left, right);
    if (fuzzyOrder !== 0) {
      return fuzzyOrder;
    }
  }
  if (left.textLength !== right.textLength) {
    return left.textLength - right.textLength;
  }
  return right.confidence - left.confidence;
}

function rankTextMatches(query, ocrItems, options) {
  const observations = Array.isArray(ocrItems) ? ocrItems : [];
  const normalizedQuery = normalizeText(query);
  const strictMatches = [];
  const fuzzyMatches = [];

  if (!normalizedQuery) {
    throw createCommandError("Text query cannot be empty.", "INVALID_ARGUMENT");
  }
  if (options.exact && options.fuzzy) {
    throw createCommandError("--exact and --fuzzy cannot be combined.", "INVALID_ARGUMENT");
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
      if (startIndex !== -1) {
        matchType = normalizedObservation.startsWith(normalizedQuery) ? "startsWith" : "contains";
      }
    }

    const rawBounds = observation.bounds;
    if (matchType) {
      strictMatches.push({
        text: observation.text,
        confidence,
        rawBounds,
        bounds: matchType === "exact"
          ? rawBounds
          : projectSubstringBounds(rawBounds, normalizedObservation, normalizedQuery, startIndex),
        matchType,
        editDistance: null,
        similarity: null,
        textLength: normalizedObservation.length
      });
      continue;
    }

    if (!options.fuzzy) {
      continue;
    }

    for (const candidate of findFuzzyCandidates(normalizedQuery, normalizedObservation)) {
      fuzzyMatches.push({
        text: observation.text,
        confidence,
        rawBounds,
        bounds: projectSubstringBounds(
          rawBounds,
          normalizedObservation,
          candidate.matchedText,
          candidate.startIndex
        ),
        matchType: "fuzzy",
        editDistance: candidate.editDistance,
        similarity: candidate.similarity,
        textLength: normalizedObservation.length
      });
    }
  }

  const matches = strictMatches.length > 0 ? strictMatches : fuzzyMatches;
  matches.sort(compareTextMatches);
  return matches;
}

function getTextSearchRects(robot, rect, clipToDisplays = false) {
  if (rect && !clipToDisplays) {
    return [rect];
  }
  if (typeof robot.getDisplays !== "function") {
    return rect ? [rect] : [null];
  }

  const displays = robot.getDisplays();
  if (!Array.isArray(displays) || displays.length === 0) {
    return rect ? [rect] : [null];
  }
  if (!rect) {
    return displays.length === 1
      ? [null]
      : displays.map((display) => ({
        x: display.x,
        y: display.y,
        width: display.width,
        height: display.height
      }));
  }

  const intersections = displays.flatMap((display) => {
    const x = Math.max(rect.x, display.x);
    const y = Math.max(rect.y, display.y);
    const right = Math.min(rect.x + rect.width, display.x + display.width);
    const bottom = Math.min(rect.y + rect.height, display.y + display.height);
    return right > x && bottom > y
      ? [{ x, y, width: right - x, height: bottom - y }]
      : [];
  });

  if (intersections.length === 0) {
    throw createCommandError(
      `Capture rectangle ${rect.x},${rect.y},${rect.width}x${rect.height} does not intersect an active display.`,
      "CAPTURE_RECT_OFF_SCREEN"
    );
  }

  return intersections;
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

  const searchRects = getTextSearchRects(robot, rect, options.clipToDisplays);
  const captureResults = [];
  let retainedResult;

  try {
    for (let displayIndex = 0; displayIndex < searchRects.length; displayIndex += 1) {
      const capture = captureWithRect(robot, searchRects[displayIndex]);
      const result = await scanTextCapture(capture, query, options, runtime);
      captureResults.push({ ...result, displayIndex: displayIndex + 1 });
    }

    let candidates = captureResults.flatMap((result) => result.matches.map((match) => ({
      ...match,
      displayIndex: result.displayIndex,
      screenPoint: getScreenPointForBounds(result.capture, match.bounds),
      captureResult: result
    })));
    if (candidates.some((candidate) => candidate.matchType !== "fuzzy")) {
      candidates = candidates.filter((candidate) => candidate.matchType !== "fuzzy");
    }
    candidates.sort(compareTextMatches);

    const ambiguous = !options.selectionExplicit
      && requestedIndex === 1
      && candidates.length > 1
      && candidates[0].matchType === "fuzzy"
      && compareFuzzyQuality(candidates[0], candidates[1]) === 0;
    const selectedCandidate = ambiguous ? null : candidates[requestedIndex - 1] || null;
    retainedResult = selectedCandidate?.captureResult
      || candidates[0]?.captureResult
      || captureResults[captureResults.length - 1];

    for (const result of captureResults) {
      if (result !== retainedResult) {
        disposeTextCapture(result);
      }
    }

    const instances = candidates.map((candidate, index) => ({
      index: index + 1,
      displayIndex: candidate.displayIndex,
      text: candidate.text,
      confidence: candidate.confidence,
      matchType: candidate.matchType,
      editDistance: candidate.editDistance,
      similarity: candidate.similarity,
      bounds: candidate.bounds,
      rawBounds: candidate.rawBounds,
      screenPoint: candidate.screenPoint
    }));
    const selected = selectedCandidate
      ? instances[requestedIndex - 1]
      : null;

    return {
      capture: retainedResult.capture,
      captureImagePath: retainedResult.captureImagePath,
      captureTempDir: retainedResult.captureTempDir,
      instances,
      requestedIndex,
      selected,
      ambiguous,
      screenPoint: selected ? selected.screenPoint : null,
      candidateCount: instances.length
    };
  } catch (error) {
    for (const result of captureResults) {
      disposeTextCapture(result);
    }
    throw error;
  }
}
export async function observeText(runtime, query, rect, options = {}) {
  const searchOptions = {
    ...options,
    confidence: options.confidence ?? 0,
    index: options.index ?? 1,
    selectionExplicit: options.index !== undefined,
    ocrModel: options.ocrModel ?? "tiny",
    ocrStrategy: options.ocrStrategy ?? "per-box",
    clipToDisplays: options.clipToDisplays ?? true,
    keepCapture: false
  };
  const result = await collectTextMatch(runtime.getRobot(), query, rect, searchOptions, runtime);

  try {
    return buildTextResult(query, result, searchOptions);
  } finally {
    disposeTextCapture(result);
  }
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
    ocrModel: options.ocrModel ?? "tiny",
    ocrStrategy: options.ocrStrategy ?? "per-box",
    fuzzy: !!options.fuzzy,
    found: !!result.selected,
    ambiguous: result.ambiguous,
    text: result.selected ? result.selected.text : null,
    confidence: result.selected ? result.selected.confidence : null,
    matchType: result.selected ? result.selected.matchType : null,
    editDistance: result.selected ? result.selected.editDistance : null,
    similarity: result.selected ? result.selected.similarity : null,
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
      const searchOptions = {
        ...c.options,
        index: resolved.index,
        selectionExplicit: resolved.index !== undefined,
        clipToDisplays: !!c.options.window
      };
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
  const inventoryItemSchema = z.object({
    text: z.string().describe("Recognized text"),
    confidence: z.number().describe("OCR confidence"),
    bounds: rectSchema.describe("Capture-relative text bounds"),
    screenPoint: pointSchema.describe("Text center in screen coordinates")
  });

  cli.command("text", {
    description: "Inventory visible text, bounds, and screen points to identify the current UI before acting.",
    options: z.object({ ...textBackendOptionsShape, ...windowOptionShape, keepCapture: z.boolean().optional().describe("Keep each OCR capture") }),
    output: z.object({
      ocrModel: z.enum(["tiny", "small"]).describe("Applied Paddle OCR model size"),
      ocrStrategy: z.enum(["per-box", "per-line", "cross-line"]).describe("Applied OCR recognition strategy"),
      displays: z.array(z.object({
        displayId: z.number().int().describe("One-based display index"),
        screenX: z.number().describe("Display left screen coordinate"),
        screenY: z.number().describe("Display top screen coordinate"),
        width: z.number().describe("Display capture width"),
        height: z.number().describe("Display capture height"),
        text: z.array(z.string()).describe("Recognized display text"),
        items: z.array(inventoryItemSchema).describe("Recognized text with locations"),
        captureImagePath: z.string().optional().describe("Retained OCR capture path")
      })).describe("Per-display OCR results"),
      allText: z.array(z.string()).describe("Recognized text across all displays"),
      allItems: z.array(inventoryItemSchema.extend({
        displayId: z.number().int().describe("One-based display index")
      })).describe("Recognized text and locations across all displays")
    }),
    async run(c) {
      const runtime = c.var.runtime;
      const robot = runtime.getRobot();
      const { rect } = await resolveWindowScope(runtime, {}, c.options, { activate: true });
      const searchRects = getTextSearchRects(robot, rect, !!c.options.window);
      const displays = [];
      const allText = [];
      const allItems = [];

      for (let displayIndex = 0; displayIndex < searchRects.length; displayIndex += 1) {
        const capture = captureWithRect(robot, searchRects[displayIndex]);
        const captureTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "robot-ocr-"));
        let retained = false;

        try {
          const captureInput = saveCaptureForOcr(capture, captureTempDir);
          const ocrItems = await performOcr(captureInput, c.options, runtime);
          const items = ocrItems.map((item) => ({
            text: item.text,
            confidence: item.confidence,
            bounds: item.bounds,
            screenPoint: getScreenPointForBounds(capture, item.bounds)
          }));
          const text = items.map((item) => item.text);
          const display = {
            displayId: displayIndex + 1,
            screenX: capture.screenX || 0,
            screenY: capture.screenY || 0,
            width: capture.width,
            height: capture.height,
            text,
            items
          };

          if (c.options.keepCapture) {
            display.captureImagePath = captureInput.imagePath;
            retained = true;
          }

          displays.push(display);
          allText.push(...text);
          allItems.push(...items.map((item) => ({ ...item, displayId: displayIndex + 1 })));
        } finally {
          if (!retained) {
            fs.rmSync(captureTempDir, { recursive: true, force: true });
          }
        }
      }

      return {
        ocrModel: c.options.ocrModel ?? "tiny",
        ocrStrategy: c.options.ocrStrategy ?? "per-box",
        displays,
        allText,
        allItems
      };
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
