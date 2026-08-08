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

export const windowSchema = z.object({
  id: z.string().describe("Operating-system window ID"),
  title: z.string().describe("Window title"),
  process: z.string().nullable().describe("Owning process or application-class name"),
  processId: z.number().int().nullable().describe("Owning process ID"),
  bounds: rectSchema.describe("Window bounds in screen coordinates"),
  display: z.string().nullable().describe("Containing display identifier"),
  scale: z.number().nullable().describe("Containing display scale")
}).describe("Desktop window");

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

export const windowOptionShape = {
  window: z.string().optional().describe("Scope the command to a window ID, title, process, or application class")
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

export async function resolveWindowScope(runtime, args = {}, options = {}, settings = {}) {
  const requestedRect = resolveRectangle(args, options);
  if (!options.window) {
    return { rect: requestedRect, window: null };
  }

  const controller = runtime.getWindowController();
  const resolved = await controller.resolve(options.window);
  const window = settings.activate ? await controller.activate(resolved) : resolved;
  if (!requestedRect) {
    return { rect: { ...window.bounds }, window };
  }

  if (
    requestedRect.x < 0
    || requestedRect.y < 0
    || requestedRect.width <= 0
    || requestedRect.height <= 0
    || requestedRect.x + requestedRect.width > window.bounds.width
    || requestedRect.y + requestedRect.height > window.bounds.height
  ) {
    throw createCommandError(
      `Rectangle ${requestedRect.x},${requestedRect.y},${requestedRect.width}x${requestedRect.height} is outside window ${window.id} (${window.bounds.width}x${window.bounds.height}).`,
      "WINDOW_RECT_OUT_OF_BOUNDS"
    );
  }

  return {
    rect: {
      x: window.bounds.x + requestedRect.x,
      y: window.bounds.y + requestedRect.y,
      width: requestedRect.width,
      height: requestedRect.height
    },
    window
  };
}

export function resolveWindowPoint(point, window, relative = true) {
  const bounds = window.bounds;
  const resolved = relative
    ? { x: bounds.x + point.x, y: bounds.y + point.y }
    : { x: point.x, y: point.y };

  if (
    resolved.x < bounds.x
    || resolved.y < bounds.y
    || resolved.x >= bounds.x + bounds.width
    || resolved.y >= bounds.y + bounds.height
  ) {
    throw createCommandError(
      `Point ${point.x},${point.y} is outside window ${window.id} (${bounds.width}x${bounds.height}).`,
      "WINDOW_POINT_OUT_OF_BOUNDS"
    );
  }

  return resolved;
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

export function performType(robot, text, cpm) {
  if (!text) {
    throw createCommandError("Text to type cannot be empty.", "INVALID_ARGUMENT");
  }

  robot.typeStringDelayed(text, cpm);
}

export function performKeyTap(robot, key, modifiers = []) {
  if (modifiers.length === 0) {
    robot.keyTap(key);
  } else if (modifiers.length === 1) {
    robot.keyTap(key, modifiers[0]);
  } else {
    robot.keyTap(key, modifiers);
  }
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
