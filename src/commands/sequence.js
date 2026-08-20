import fs from "node:fs";
import { z } from "incur";
import { saveManagedCapture } from "../captures.js";
import { observeText, ocrBackendOutputSchema, textBackendOptionsShape } from "./text.js";
import {
  clickOptionsShape,
  cpmSchema,
  cpmValueSchema,
  DEFAULT_CPM,
  createCommandError,
  indexSchema,
  performClick,
  performKeyTap,
  performType,
  resolveClickPoint,
  resolveInputPath,
  resolveWindowPoint,
  timeoutSchema,
  waitForObservation,
  windowSchema
} from "./shared.js";

const keyTapStepSchema = z.object({
  command: z.literal("keyTap"),
  key: z.string().min(1).describe("Key to press"),
  modifiers: z.array(z.string()).optional().describe("Modifier keys")
});

const typeStepSchema = z.object({
  command: z.literal("type"),
  text: z.string().min(1).describe("Text to type"),
  cpm: cpmValueSchema.optional()
});

const clickStepSchema = z.object({
  command: z.literal("click"),
  x: z.number().optional().describe("Window-relative horizontal coordinate"),
  y: z.number().optional().describe("Window-relative vertical coordinate"),
  ...clickOptionsShape
});

const textStepOptionsShape = {
  query: z.string().min(1).describe("Text to find"),
  confidence: z.number().default(0).describe("Minimum OCR confidence"),
  exact: z.boolean().optional().describe("Require an exact text match and disable fuzzy fallback"),
  fuzzy: z.boolean().optional().describe("Allow one OCR character error in queries of four or more characters"),
  ...textBackendOptionsShape
};

const assertTextStepSchema = z.object({
  command: z.literal("assertText"),
  ...textStepOptionsShape
});

const waitForTextStepSchema = z.object({
  command: z.literal("waitForText"),
  ...textStepOptionsShape,
  timeout: timeoutSchema
});

const clickTextStepSchema = z.object({
  command: z.literal("clickText"),
  ...textStepOptionsShape,
  index: indexSchema,
  ...clickOptionsShape
});

export const sequenceStepsSchema = z.array(
  z.discriminatedUnion("command", [
    keyTapStepSchema,
    typeStepSchema,
    clickStepSchema,
    assertTextStepSchema,
    waitForTextStepSchema,
    clickTextStepSchema
  ])
).min(1);

const sequenceResultSchema = z.object({
  index: z.number().int().describe("One-based step index"),
  command: z.enum(["keyTap", "type", "click", "assertText", "waitForText", "clickText"]).describe("Executed command"),
  key: z.string().optional().describe("Pressed key"),
  modifiers: z.array(z.string()).optional().describe("Applied modifier keys"),
  text: z.string().optional().describe("Typed text"),
  cpm: z.number().optional().describe("Typing speed in characters per minute"),
  x: z.number().optional().describe("Clicked horizontal screen coordinate"),
  y: z.number().optional().describe("Clicked vertical screen coordinate"),
  button: z.enum(["left", "middle", "right"]).optional().describe("Mouse button used"),
  double: z.boolean().optional().describe("Whether a double-click was used"),
  query: z.string().optional().describe("Text query"),
  found: z.boolean().optional().describe("Whether matching text was found"),
  matchedText: z.string().nullable().optional().describe("Matched OCR text"),
  confidence: z.number().nullable().optional().describe("Matched OCR confidence"),
  matchType: z.enum(["exact", "startsWith", "contains", "fuzzy"]).nullable().optional().describe("Selected text match type"),
  editDistance: z.number().int().nullable().optional().describe("Selected fuzzy edit distance"),
  similarity: z.number().nullable().optional().describe("Selected fuzzy similarity"),
  ambiguous: z.boolean().optional().describe("Whether fuzzy matches were ambiguous"),
  ocrBackend: ocrBackendOutputSchema.optional().describe("Applied OCR backend"),
  ocrModel: z.enum(["tiny", "small"]).optional().describe("Applied OCR model"),
  ocrStrategy: z.enum(["per-box", "per-line", "cross-line"]).optional().describe("Applied OCR strategy"),
  fuzzy: z.boolean().optional().describe("Whether fuzzy fallback was enabled"),
  candidateCount: z.number().int().optional().describe("Number of matching OCR candidates"),
  attempts: z.number().int().optional().describe("Number of wait observations"),
  elapsedMs: z.number().optional().describe("Elapsed wait time")
});

function validateSteps(parsed, source) {
  const validation = sequenceStepsSchema.safeParse(parsed);
  if (!validation.success) {
    const details = validation.error.issues
      .map((issue) => `${issue.path.join(".") || "steps"}: ${issue.message}`)
      .join("; ");
    throw createCommandError(`Invalid sequence steps in ${source}: ${details}`, "INVALID_SEQUENCE");
  }

  for (let index = 0; index < validation.data.length; index += 1) {
    const step = validation.data[index];
    if (step.command === "click" && (step.x === undefined) !== (step.y === undefined)) {
      throw createCommandError(
        `Invalid sequence steps in ${source}: ${index}.click expects neither coordinate or both x and y.`,
        "INVALID_SEQUENCE"
      );
    }
  }

  return validation.data;
}

function parseSteps(serialized, source) {
  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw createCommandError(`Failed to parse sequence steps from ${source}: ${error.message}`, "SEQUENCE_READ_FAILED");
  }

  return validateSteps(parsed, source);
}

function resolveSteps(runtime, options) {
  const sources = Number(options.steps !== undefined) + Number(options.stepsJson !== undefined);
  if (sources !== 1) {
    throw createCommandError("Choose exactly one of --steps or --steps-json.", "INVALID_ARGUMENT");
  }

  if (Array.isArray(options.steps)) {
    return { source: "inline MCP steps", steps: validateSteps(options.steps, "inline MCP steps") };
  }

  if (options.stepsJson !== undefined) {
    return { source: "--steps-json", steps: parseSteps(options.stepsJson, "--steps-json") };
  }

  if (options.steps === "-") {
    let serialized;
    try {
      serialized = runtime.readStdin();
    } catch (error) {
      throw createCommandError(`Failed to read sequence steps from stdin: ${error.message}`, "SEQUENCE_READ_FAILED");
    }
    return { source: "stdin", steps: parseSteps(serialized, "stdin") };
  }

  const input = resolveInputPath(runtime.cwd, options.steps, "steps path");
  let serialized;
  try {
    serialized = fs.readFileSync(input, "utf8");
  } catch (error) {
    throw createCommandError(`Failed to read sequence steps from ${input}: ${error.message}`, "SEQUENCE_READ_FAILED");
  }
  return { source: input, steps: parseSteps(serialized, input) };
}
function applySequenceDefaults(step, options) {
  if (step.command === "type") {
    return {
      ...step,
      cpm: step.cpm ?? options.cpm ?? DEFAULT_CPM
    };
  }

  if (!["assertText", "waitForText", "clickText"].includes(step.command)) {
    return step;
  }

  const resolved = { ...step };
  for (const name of ["ocrBackend", "ocr", "recLangs", "ocrModel", "ocrStrategy"]) {
    if (resolved[name] === undefined && options[name] !== undefined) {
      resolved[name] = options[name];
    }
  }
  if (resolved.fuzzy === undefined && !resolved.exact && options.fuzzy !== undefined) {
    resolved.fuzzy = options.fuzzy;
  }
  if (resolved.exact) {
    resolved.fuzzy = false;
  }
  return resolved;
}


function summarizeTextStep(index, command, query, result, waitResult) {
  return {
    index,
    command,
    query,
    found: result.found,
    matchedText: result.text,
    confidence: result.confidence,
    ocrBackend: result.ocrBackend,
    ocrModel: result.ocrModel,
    ocrStrategy: result.ocrStrategy,
    fuzzy: result.fuzzy,
    matchType: result.matchType,
    editDistance: result.editDistance,
    similarity: result.similarity,
    ambiguous: result.ambiguous,
    candidateCount: result.candidateCount,
    ...(waitResult ? {
      attempts: waitResult.attempts,
      elapsedMs: waitResult.elapsedMs
    } : {})
  };
}

async function executeStep(runtime, robot, step, window, index) {
  if (step.command === "keyTap") {
    const modifiers = step.modifiers || [];
    performKeyTap(robot, step.key, modifiers);
    return { index, command: step.command, key: step.key, modifiers };
  }

  if (step.command === "type") {
    const cpm = step.cpm ?? DEFAULT_CPM;
    performType(robot, step.text, cpm);
    return { index, command: step.command, text: step.text, cpm };
  }

  if (step.command === "click") {
    const requestedPoint = resolveClickPoint(step);
    const currentPoint = requestedPoint ? null : robot.getMousePos();
    const point = resolveWindowPoint(requestedPoint || currentPoint, window, !!requestedPoint);
    performClick(robot, requestedPoint ? point : null, step);
    return {
      index,
      command: step.command,
      x: point.x,
      y: point.y,
      button: step.button || "left",
      double: !!step.double
    };
  }

  if (step.command === "clickText") {
    const result = await observeText(runtime, step.query, window.bounds, step);
    if (!result.found || !result.screenPoint) {
      throw createCommandError(
        `Text click failed: ${JSON.stringify(step.query)} was not found.`,
        "SEQUENCE_TEXT_NOT_FOUND"
      );
    }
    performClick(robot, result.screenPoint, step);
    return {
      ...summarizeTextStep(index, step.command, step.query, result),
      x: result.screenPoint.x,
      y: result.screenPoint.y,
      button: step.button || "left",
      double: !!step.double
    };
  }

  if (step.command === "assertText") {
    const result = await observeText(runtime, step.query, window.bounds, step);
    if (!result.found) {
      throw createCommandError(`Text assertion failed: ${JSON.stringify(step.query)} was not found.`, "SEQUENCE_ASSERTION_FAILED");
    }
    return summarizeTextStep(index, step.command, step.query, result);
  }

  let activeWindow = window;
  let attempt = 0;
  const waitResult = await waitForObservation(
    async () => {
      if (attempt > 0) {
        activeWindow = await runtime.getWindowController().activate(activeWindow);
      }
      attempt += 1;
      return observeText(runtime, step.query, activeWindow.bounds, step);
    },
    (result) => result.found,
    step,
    runtime
  );
  if (waitResult.timedOut) {
    throw createCommandError(
      `Timed out after ${waitResult.elapsedMs} ms waiting for text ${JSON.stringify(step.query)}.`,
      "SEQUENCE_WAIT_TIMEOUT"
    );
  }
  return summarizeTextStep(index, step.command, step.query, waitResult.value, waitResult);
}

export function registerSequenceCommand(cli) {
  cli.command("sequence", {
    description: "Run input and text-verification steps while reasserting target focus.",
    options: z.object({
      window: z.string().describe("Target window ID, title, or process name"),
      steps: z.union([z.string(), sequenceStepsSchema]).optional()
        .describe("JSON file, '-' for stdin, or an MCP array of steps"),
      stepsJson: z.string().optional().describe("Inline JSON array of steps"),
      captureOnFailure: z.boolean().optional().describe("Save a managed window capture when a step fails"),
      cpm: cpmSchema,
      fuzzy: z.boolean().optional().describe("Default strict-first fuzzy fallback for text steps"),
      ...textBackendOptionsShape
    }),
    output: z.object({
      window: windowSchema.describe("Activated target window"),
      steps: z.string().describe("Resolved sequence source"),
      completed: z.number().int().describe("Number of completed steps"),
      results: z.array(sequenceResultSchema).describe("Step results in execution order")
    }),
    usage: [
      { options: { window: true, steps: true } },
      { options: { window: true, "steps-json": true } }
    ],
    hint: "Target focus is confirmed before every step and polling retry. Click coordinates are window-relative. Steps support keyTap, type, click, clickText, assertText, and waitForText.",
    async run(c) {
      const runtime = c.var.runtime;
      const resolved = resolveSteps(runtime, c.options);
      const controller = runtime.getWindowController();
      const target = await controller.resolve(c.options.window);
      let window = target;
      const robot = runtime.getRobot();
      const results = [];

      for (let offset = 0; offset < resolved.steps.length; offset += 1) {
        const step = applySequenceDefaults(resolved.steps[offset], c.options);
        try {
          window = await controller.activate(window);
          results.push(await executeStep(runtime, robot, step, window, offset + 1));
        } catch (error) {
          let captureMessage = "";
          if (c.options.captureOnFailure) {
            try {
              const capture = saveManagedCapture(runtime, robot, window.bounds, { prefix: "failure" });
              captureMessage = ` Failure capture: ${capture.output}. Latest capture: ${capture.latest}.`;
            } catch (captureError) {
              captureMessage = ` Failure capture also failed: ${captureError.message}.`;
            }
          }

          const wrapped = createCommandError(
            `Sequence step ${offset + 1} (${step.command}) failed: ${error.message}${captureMessage}`,
            error.code || "SEQUENCE_STEP_FAILED",
            error.exitCode || 1
          );
          wrapped.cause = error;
          throw wrapped;
        }
      }

      return {
        window,
        steps: resolved.source,
        completed: results.length,
        results
      };
    }
  });

  return cli;
}
