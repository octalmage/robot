import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "incur";
import { saveManagedCapture } from "../captures.js";
import {
  captureSchema,
  captureWithRect,
  clickOptionsShape,
  cpmSchema,
  createCommandError,
  getCaptureMetadata,
  performClick,
  performKeyTap,
  performType,
  rectangleArgsShape,
  rectangleOptionsShape,
  resolveClickPoint,
  resolveInputPath,
  resolveWindowPoint,
  resolveWindowScope,
  windowOptionShape,
  windowSchema
} from "./shared.js";

const applicationArgs = z.object({
  application: z.array(z.string()).describe("Application name words")
});

const applicationOutput = z.object({
  application: z.string().describe("Requested application name"),
  target: z.string().describe("Resolved application target")
});

const windowOutput = z.object({
  window: windowSchema.describe("Selected window")
});

function getPermission(robot, method) {
  if (typeof robot[method] !== "function") {
    return null;
  }

  const value = robot[method]();
  return typeof value === "boolean" ? value : null;
}

function registerApplicationCommand(cli, name, description, method) {
  cli.command(name, {
    description,
    args: applicationArgs,
    output: applicationOutput,
    async run(c) {
      const application = c.args.application.join(" ");
      const resolved = await c.var.runtime.getApplicationController()[method](application);
      return { application: resolved.requested, target: resolved.target };
    }
  });
}

export function registerDesktopCommands(cli) {
  cli.command("windows", {
    description: "List visible desktop windows.",
    output: z.object({
      platform: z.string().describe("Current operating-system platform"),
      windows: z.array(windowSchema).describe("Visible desktop windows")
    }),
    async run(c) {
      const runtime = c.var.runtime;
      return {
        platform: runtime.platform,
        windows: await runtime.getWindowController().list()
      };
    }
  });

  cli.command("activateWindow", {
    description: "Bring a window to the foreground by ID or title.",
    options: z.object({
      id: z.string().optional().describe("Exact operating-system window ID"),
      title: z.string().optional().describe("Window title, with optional * and ? wildcards")
    }),
    output: windowOutput,
    usage: [
      { options: { title: true } },
      { options: { id: true } }
    ],
    hint: "Provide exactly one of --id or --title. Ambiguous titles must be replaced with a window ID from `robot windows`.",
    async run(c) {
      const hasId = !!c.options.id;
      const hasTitle = !!c.options.title;
      if (hasId === hasTitle) {
        throw createCommandError("activateWindow expects exactly one of --id or --title.", "INVALID_ARGUMENT");
      }

      const controller = c.var.runtime.getWindowController();
      const mode = hasId ? "id" : "title";
      return { window: await controller.activate(c.options.id || c.options.title, mode) };
    }
  });

  cli.command("permissions", {
    description: "Check or request macOS desktop automation permissions.",
    options: z.object({
      request: z.boolean().optional().describe("Show prompts for missing permissions")
    }),
    output: z.object({
      platform: z.string().describe("Current operating-system platform"),
      supported: z.boolean().describe("Whether robotjs exposes permission controls on this platform"),
      requested: z.boolean().describe("Whether missing permissions were requested"),
      accessibility: z.boolean().nullable().describe("Accessibility permission status"),
      screenRecording: z.boolean().nullable().describe("Screen Recording permission status")
    }),
    hint: "macOS requires user approval. Rerun this command after approving to refresh the status.",
    run(c) {
      const runtime = c.var.runtime;
      const robot = runtime.getRobot();
      const shouldRequest = !!c.options.request;
      let requested = false;
      let accessibility = getPermission(robot, "getAccessibilityPermission");
      let screenRecording = getPermission(robot, "getScreenCapturePermission");

      if (
        shouldRequest
        && screenRecording === false
        && typeof robot.requestScreenCapturePermission === "function"
      ) {
        requested = true;
        screenRecording = getPermission(robot, "requestScreenCapturePermission");
      }
      if (
        shouldRequest
        && accessibility === false
        && typeof robot.requestAccessibilityPermission === "function"
      ) {
        requested = true;
        accessibility = getPermission(robot, "requestAccessibilityPermission");
      }

      return {
        platform: runtime.platform,
        supported: accessibility !== null && screenRecording !== null,
        requested,
        accessibility,
        screenRecording
      };
    }
  });

  registerApplicationCommand(
    cli,
    "openApp",
    "Open an application by operating-system name.",
    "open"
  );
  registerApplicationCommand(
    cli,
    "activateApp",
    "Bring an application to the foreground by operating-system name.",
    "activate"
  );

  const screenshotArgs = z.object(rectangleArgsShape);
  const screenshotOptions = z.object({
    output: z.string().optional().describe("Destination image path"),
    temp: z.boolean().optional().describe("Save to managed temporary storage"),
    tempTtl: z.number().min(0).optional().describe("Delete older managed captures after this many milliseconds"),
    ...rectangleOptionsShape,
    ...windowOptionShape
  });

  cli.command("screenshot", {
    description: "Capture the screen or a rectangular region to an image file.",
    args: screenshotArgs,
    options: screenshotOptions,
    output: z.object({
      output: z.string().describe("Resolved destination image path"),
      imageUri: z.string().describe("File URI for the saved image"),
      latest: z.string().optional().describe("Session-scoped latest capture path"),
      managed: z.boolean().describe("Whether managed temporary storage was used"),
      capture: captureSchema.describe("Saved capture metadata")
    }),
    usage: [
      { options: { output: true } },
      { options: { temp: true } },
      {
        args: { x: true, y: true, width: true, height: true },
        options: { output: true }
      }
    ],
    hint: "Choose exactly one of --output or --temp. Use either four positional rectangle values or all four named rectangle options, not both.",
    async run(c) {
      const runtime = c.var.runtime;
      const managed = c.options.temp === true;
      if ((c.options.output !== undefined) === managed) {
        throw createCommandError("Choose exactly one of --output or --temp.", "INVALID_ARGUMENT");
      }
      if (!managed && c.options.tempTtl !== undefined) {
        throw createCommandError("--temp-ttl requires --temp.", "INVALID_ARGUMENT");
      }

      const { rect } = await resolveWindowScope(runtime, c.args, c.options, { activate: true });
      let capture;
      let output;
      let latest;

      if (managed) {
        ({ capture, output, latest } = saveManagedCapture(
          runtime,
          runtime.getRobot(),
          rect,
          { ttlMs: c.options.tempTtl }
        ));
      } else {
        output = resolveInputPath(runtime.cwd, c.options.output, "output path");
        capture = captureWithRect(runtime.getRobot(), rect);
        fs.mkdirSync(path.dirname(output), { recursive: true });
        if (!capture.save(output)) {
          throw createCommandError(`Failed to save screenshot to ${output}.`, "SCREENSHOT_SAVE_FAILED");
        }
      }

      return {
        output,
        imageUri: pathToFileURL(output).href,
        latest,
        managed,
        capture: getCaptureMetadata(capture)
      };
    }
  });

  cli.command("moveMouse", {
    description: "Move the pointer smoothly to screen coordinates.",
    args: z.object({
      x: z.coerce.number().describe("Horizontal screen coordinate"),
      y: z.coerce.number().describe("Vertical screen coordinate")
    }),
    output: z.object({
      x: z.number().describe("Horizontal screen coordinate"),
      y: z.number().describe("Vertical screen coordinate")
    }),
    run(c) {
      c.var.runtime.getRobot().moveMouseSmooth(c.args.x, c.args.y);
      return { x: c.args.x, y: c.args.y };
    }
  });

  cli.command("click", {
    description: "Click the current pointer position or the given screen coordinates.",
    args: z.object({
      x: z.coerce.number().optional().describe("Horizontal coordinate, window-relative with --window"),
      y: z.coerce.number().optional().describe("Vertical coordinate, window-relative with --window")
    }),
    options: z.object({ ...clickOptionsShape, ...windowOptionShape }),
    output: z.object({
      x: z.number().optional().describe("Clicked horizontal coordinate"),
      y: z.number().optional().describe("Clicked vertical coordinate"),
      button: z.enum(["left", "middle", "right"]).describe("Mouse button used"),
      double: z.boolean().describe("Whether a double-click was used")
    }),
    usage: [
      {},
      { args: { x: true, y: true } }
    ],
    async run(c) {
      const runtime = c.var.runtime;
      const robot = runtime.getRobot();
      const requestedPoint = resolveClickPoint(c.args);
      let point = requestedPoint;
      const result = {
        button: c.options.button || "left",
        double: !!c.options.double
      };

      if (c.options.window) {
        const scope = await resolveWindowScope(runtime, {}, c.options, { activate: true });
        const currentPoint = requestedPoint ? null : robot.getMousePos();
        point = resolveWindowPoint(requestedPoint || currentPoint, scope.window, !!requestedPoint);
      }

      performClick(robot, requestedPoint ? point : null, c.options);

      if (point) {
        result.x = point.x;
        result.y = point.y;
      }

      return result;
    }
  });

  cli.command("type", {
    description: "Type text at a controlled character rate.",
    args: z.object({
      text: z.array(z.string()).describe("Text words to type")
    }),
    options: z.object({ cpm: cpmSchema, ...windowOptionShape }),
    output: z.object({
      text: z.string().describe("Typed text"),
      cpm: z.number().describe("Typing speed in characters per minute")
    }),
    async run(c) {
      const runtime = c.var.runtime;
      if (c.options.window) {
        await resolveWindowScope(runtime, {}, c.options, { activate: true });
      }
      const text = c.args.text.join(" ");
      performType(runtime.getRobot(), text, c.options.cpm);
      return { text, cpm: c.options.cpm };
    }
  });

  cli.command("keyTap", {
    description: "Press a key with optional modifiers.",
    args: z.object({
      key: z.string().describe("Key to press"),
      modifiers: z.array(z.string()).optional().describe("Modifier keys")
    }),
    options: z.object(windowOptionShape),
    output: z.object({
      key: z.string().describe("Pressed key"),
      modifiers: z.array(z.string()).describe("Applied modifier keys")
    }),
    async run(c) {
      const runtime = c.var.runtime;
      if (c.options.window) {
        await resolveWindowScope(runtime, {}, c.options, { activate: true });
      }
      const modifiers = c.args.modifiers || [];
      performKeyTap(runtime.getRobot(), c.args.key, modifiers);
      return { key: c.args.key, modifiers };
    }
  });

  cli.command("scrollMouse", {
    description: "Scroll by horizontal and vertical deltas.",
    args: z.object({
      x: z.coerce.number().describe("Horizontal scroll delta"),
      y: z.coerce.number().describe("Vertical scroll delta")
    }),
    output: z.object({
      x: z.number().describe("Horizontal scroll delta"),
      y: z.number().describe("Vertical scroll delta")
    }),
    run(c) {
      c.var.runtime.getRobot().scrollMouse(c.args.x, c.args.y);
      return { x: c.args.x, y: c.args.y };
    }
  });

  cli.command("mousePos", {
    description: "Get the current pointer coordinates.",
    output: z.object({
      x: z.number().describe("Horizontal pointer coordinate"),
      y: z.number().describe("Vertical pointer coordinate")
    }),
    run(c) {
      const point = c.var.runtime.getRobot().getMousePos();
      return { x: point.x, y: point.y };
    }
  });

  cli.command("screenSize", {
    description: "Get the primary screen dimensions.",
    output: z.object({
      size: z.object({
        width: z.number().describe("Screen width in pixels"),
        height: z.number().describe("Screen height in pixels")
      }).describe("Primary screen dimensions")
    }),
    run(c) {
      return { size: c.var.runtime.getRobot().getScreenSize() };
    }
  });

  cli.command("pixelColor", {
    description: "Read the pixel color at screen coordinates.",
    args: z.object({
      x: z.coerce.number().describe("Horizontal screen coordinate"),
      y: z.coerce.number().describe("Vertical screen coordinate")
    }),
    output: z.object({
      x: z.number().describe("Horizontal screen coordinate"),
      y: z.number().describe("Vertical screen coordinate"),
      color: z.string().describe("Pixel color value")
    }),
    run(c) {
      const robot = c.var.runtime.getRobot();
      return {
        x: c.args.x,
        y: c.args.y,
        color: robot.getPixelColor(c.args.x, c.args.y)
      };
    }
  });

  return cli;
}
