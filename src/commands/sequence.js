import fs from "node:fs";
import { z } from "incur";
import {
  clickOptionsShape,
  cpmSchema,
  createCommandError,
  performClick,
  performKeyTap,
  performType,
  resolveClickPoint,
  resolveInputPath,
  resolveWindowPoint,
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
  cpm: cpmSchema.optional()
});

const clickStepSchema = z.object({
  command: z.literal("click"),
  x: z.number().optional().describe("Window-relative horizontal coordinate"),
  y: z.number().optional().describe("Window-relative vertical coordinate"),
  ...clickOptionsShape
});

const sequenceStepsSchema = z.array(
  z.discriminatedUnion("command", [keyTapStepSchema, typeStepSchema, clickStepSchema])
).min(1);

const sequenceResultSchema = z.object({
  index: z.number().int().describe("One-based step index"),
  command: z.enum(["keyTap", "type", "click"]).describe("Executed command"),
  key: z.string().optional().describe("Pressed key"),
  modifiers: z.array(z.string()).optional().describe("Applied modifier keys"),
  text: z.string().optional().describe("Typed text"),
  cpm: z.number().optional().describe("Typing speed in characters per minute"),
  x: z.number().optional().describe("Clicked horizontal screen coordinate"),
  y: z.number().optional().describe("Clicked vertical screen coordinate"),
  button: z.enum(["left", "middle", "right"]).optional().describe("Mouse button used"),
  double: z.boolean().optional().describe("Whether a double-click was used")
});

function readSteps(input) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(input, "utf8"));
  } catch (error) {
    throw createCommandError(`Failed to read sequence steps from ${input}: ${error.message}`, "SEQUENCE_READ_FAILED");
  }

  const validation = sequenceStepsSchema.safeParse(parsed);
  if (!validation.success) {
    const details = validation.error.issues
      .map((issue) => `${issue.path.join(".") || "steps"}: ${issue.message}`)
      .join("; ");
    throw createCommandError(`Invalid sequence steps in ${input}: ${details}`, "INVALID_SEQUENCE");
  }

  for (let index = 0; index < validation.data.length; index += 1) {
    const step = validation.data[index];
    if (step.command === "click" && (step.x === undefined) !== (step.y === undefined)) {
      throw createCommandError(
        `Invalid sequence steps in ${input}: ${index}.click expects neither coordinate or both x and y.`,
        "INVALID_SEQUENCE"
      );
    }
  }

  return validation.data;
}

function executeStep(robot, step, window, index) {
  if (step.command === "keyTap") {
    const modifiers = step.modifiers || [];
    performKeyTap(robot, step.key, modifiers);
    return { index, command: step.command, key: step.key, modifiers };
  }

  if (step.command === "type") {
    const cpm = step.cpm ?? 12000;
    performType(robot, step.text, cpm);
    return { index, command: step.command, text: step.text, cpm };
  }

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

export function registerSequenceCommand(cli) {
  cli.command("sequence", {
    description: "Run keyboard and mouse steps in one focused process.",
    options: z.object({
      window: z.string().describe("Target window ID or title"),
      steps: z.string().describe("JSON file containing an array of steps")
    }),
    output: z.object({
      window: windowSchema.describe("Activated target window"),
      steps: z.string().describe("Resolved sequence file path"),
      completed: z.number().int().describe("Number of completed steps"),
      results: z.array(sequenceResultSchema).describe("Step results in execution order")
    }),
    hint: "Coordinates in click steps are relative to the selected window. Supported commands are keyTap, type, and click.",
    async run(c) {
      const runtime = c.var.runtime;
      const input = resolveInputPath(runtime.cwd, c.options.steps, "steps path");
      const steps = readSteps(input);
      const controller = runtime.getWindowController();
      const target = await controller.resolve(c.options.window);
      const window = await controller.activate(target);
      const robot = runtime.getRobot();
      const results = [];

      for (let offset = 0; offset < steps.length; offset += 1) {
        const step = steps[offset];
        try {
          results.push(executeStep(robot, step, window, offset + 1));
        } catch (error) {
          error.message = `Sequence step ${offset + 1} (${step.command}) failed: ${error.message}`;
          throw error;
        }
      }

      return { window, steps: input, completed: results.length, results };
    }
  });

  return cli;
}
