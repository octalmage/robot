import path from "node:path";
import { z } from "incur";

export const pointSchema = z.object({
  x: z.number().describe("Horizontal coordinate"),
  y: z.number().describe("Vertical coordinate")
}).describe("Screen point");

export const rectSchema = z.object({
  x: z.number().describe("Rectangle left coordinate"),
  y: z.number().describe("Rectangle top coordinate"),
  width: z.number().describe("Rectangle width"),
  height: z.number().describe("Rectangle height")
}).describe("Screen rectangle");

export const captureSchema = z.object({
  width: z.number().describe("Capture width in pixels"),
  height: z.number().describe("Capture height in pixels"),
  byteWidth: z.number().describe("Capture row width in bytes"),
  bitsPerPixel: z.number().describe("Capture color depth in bits"),
  bytesPerPixel: z.number().describe("Capture color depth in bytes"),
  screenX: z.number().optional().describe("Capture left screen coordinate"),
  screenY: z.number().optional().describe("Capture top screen coordinate"),
  scaleX: z.number().optional().describe("Horizontal display scale"),
  scaleY: z.number().optional().describe("Vertical display scale")
}).describe("Robotjs image metadata");

export const waitMetadataShape = {
  attempts: z.number().int().describe("Observation attempts"),
  elapsedMs: z.number().describe("Elapsed wait time in milliseconds"),
  timedOut: z.boolean().describe("Whether the wait timed out")
};

export const clickOptionsShape = {
  button: z.enum(["left", "middle", "right"]).optional().describe("Mouse button to click"),
  double: z.boolean().optional().describe("Double-click instead of single-click")
};

export const rectangleOptionsShape = {
  x: z.number().optional().describe("Rectangle left coordinate"),
  y: z.number().optional().describe("Rectangle top coordinate"),
  width: z.number().optional().describe("Rectangle width"),
  height: z.number().optional().describe("Rectangle height")
};

export const rectangleArgsShape = {
  x: z.coerce.number().optional().describe("Rectangle left coordinate"),
  y: z.coerce.number().optional().describe("Rectangle top coordinate"),
  width: z.coerce.number().optional().describe("Rectangle width"),
  height: z.coerce.number().optional().describe("Rectangle height")
};

export const timeoutSchema = z.number().min(0).default(30000).describe("Wait timeout in milliseconds");
export const indexSchema = z.number().int().min(1).optional().describe("One-based match occurrence");
export const cpmSchema = z.number().default(12000).describe("Typing speed in characters per minute");

export function createCommandError(message, code = "CLI_ERROR", exitCode = 1) {
  const error = new Error(message);
  error.code = code;
  error.exitCode = exitCode;
  return error;
}

export function resolveInputPath(cwd, value, label) {
  if (!value) {
    throw createCommandError(`${label} is required.`, "INVALID_ARGUMENT");
  }

  return path.resolve(cwd, value);
}

export function resolveExecutablePath(cwd, value) {
  if (value.includes(path.sep) || value.startsWith(".")) {
    return path.resolve(cwd, value);
  }

  return value;
}

export function resolveRectangle(args = {}, options = {}) {
  const keys = ["x", "y", "width", "height"];
  const positionalCount = keys.filter((key) => args[key] !== undefined).length;
  const optionCount = keys.filter((key) => options[key] !== undefined).length;

  if (positionalCount > 0 && optionCount > 0) {
    throw createCommandError(
      "Use either four positional rectangle values or all four named rectangle options, not both.",
      "INVALID_ARGUMENT"
    );
  }

  if (positionalCount === 0 && optionCount === 0) {
    return null;
  }

  const source = positionalCount > 0 ? args : options;
  const count = positionalCount > 0 ? positionalCount : optionCount;

  if (count !== 4) {
    throw createCommandError(
      "Expected either no rectangle or exactly four rectangle values.",
      "INVALID_ARGUMENT"
    );
  }

  return {
    x: source.x,
    y: source.y,
    width: source.width,
    height: source.height
  };
}

export function resolveClickPoint(args = {}) {
  const hasX = args.x !== undefined;
  const hasY = args.y !== undefined;

  if (hasX !== hasY) {
    throw createCommandError("click expects neither coordinate or both x and y.", "INVALID_ARGUMENT");
  }

  return hasX ? { x: args.x, y: args.y } : null;
}

export function captureWithRect(robot, rect) {
  if (!rect) {
    return robot.screen.capture();
  }

  return robot.screen.capture(rect.x, rect.y, rect.width, rect.height);
}

export function getCaptureMetadata(capture) {
  const metadata = {
    width: capture.width,
    height: capture.height,
    byteWidth: capture.byteWidth,
    bitsPerPixel: capture.bitsPerPixel,
    bytesPerPixel: capture.bytesPerPixel
  };

  for (const key of ["screenX", "screenY", "scaleX", "scaleY"]) {
    if (typeof capture[key] === "number") {
      metadata[key] = capture[key];
    }
  }

  return metadata;
}

export function performClick(robot, point, options = {}) {
  if (point) {
    robot.moveMouseSmooth(point.x, point.y);
  }

  if (options.button === undefined) {
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

export async function waitForObservation(observe, isFound, options, runtime, disposeOnRetry) {
  const timeout = options.timeout;
  const startedAt = runtime.now();
  let attempts = 0;

  while (true) {
    attempts += 1;
    const value = await observe();
    const elapsedMs = Math.max(runtime.now() - startedAt, 0);

    if (isFound(value)) {
      return { value, attempts, elapsedMs, timedOut: false };
    }

    if (elapsedMs >= timeout) {
      return { value, attempts, elapsedMs, timedOut: true };
    }

    if (disposeOnRetry) {
      disposeOnRetry(value);
    }

    await runtime.sleep(Math.min(100, timeout - elapsedMs));
  }
}
