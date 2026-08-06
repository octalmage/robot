import fs from "node:fs";
import path from "node:path";
import { z } from "incur";
import {
  captureSchema,
  captureWithRect,
  clickOptionsShape,
  cpmSchema,
  createCommandError,
  getCaptureMetadata,
  performClick,
  rectangleArgsShape,
  rectangleOptionsShape,
  resolveClickPoint,
  resolveInputPath,
  resolveRectangle
} from "./shared.js";

const applicationArgs = z.object({
  application: z.array(z.string()).describe("Application name words")
});

const applicationOutput = z.object({
  application: z.string().describe("Requested application name"),
  target: z.string().describe("Resolved application target")
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
    output: z.string().describe("Destination image path"),
    ...rectangleOptionsShape
  });

  cli.command("screenshot", {
    description: "Capture the screen or a rectangular region to an image file.",
    args: screenshotArgs,
    options: screenshotOptions,
    output: z.object({
      output: z.string().describe("Resolved destination image path"),
      capture: captureSchema.describe("Saved capture metadata")
    }),
    usage: [
      { options: { output: true } },
      {
        args: { x: true, y: true, width: true, height: true },
        options: { output: true }
      }
    ],
    hint: "Use either four positional rectangle values or all four named rectangle options, not both.",
    run(c) {
      const runtime = c.var.runtime;
      const rect = resolveRectangle(c.args, c.options);
      const output = resolveInputPath(runtime.cwd, c.options.output, "output path");
      const capture = captureWithRect(runtime.getRobot(), rect);

      fs.mkdirSync(path.dirname(output), { recursive: true });
      if (!capture.save(output)) {
        throw createCommandError(`Failed to save screenshot to ${output}.`, "SCREENSHOT_SAVE_FAILED");
      }

      return { output, capture: getCaptureMetadata(capture) };
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
      x: z.coerce.number().optional().describe("Horizontal screen coordinate"),
      y: z.coerce.number().optional().describe("Vertical screen coordinate")
    }),
    options: z.object(clickOptionsShape),
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
    run(c) {
      const point = resolveClickPoint(c.args);
      const result = {
        button: c.options.button || "left",
        double: !!c.options.double
      };

      performClick(c.var.runtime.getRobot(), point, c.options);

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
    options: z.object({ cpm: cpmSchema }),
    output: z.object({
      text: z.string().describe("Typed text"),
      cpm: z.number().describe("Typing speed in characters per minute")
    }),
    run(c) {
      const text = c.args.text.join(" ");

      if (!text) {
        throw createCommandError("Text to type cannot be empty.", "INVALID_ARGUMENT");
      }

      c.var.runtime.getRobot().typeStringDelayed(text, c.options.cpm);
      return { text, cpm: c.options.cpm };
    }
  });

  cli.command("keyTap", {
    description: "Press a key with optional modifiers.",
    args: z.object({
      key: z.string().describe("Key to press"),
      modifiers: z.array(z.string()).optional().describe("Modifier keys")
    }),
    output: z.object({
      key: z.string().describe("Pressed key"),
      modifiers: z.array(z.string()).describe("Applied modifier keys")
    }),
    run(c) {
      const robot = c.var.runtime.getRobot();
      const modifiers = c.args.modifiers || [];

      if (modifiers.length === 0) {
        robot.keyTap(c.args.key);
      } else if (modifiers.length === 1) {
        robot.keyTap(c.args.key, modifiers[0]);
      } else {
        robot.keyTap(c.args.key, modifiers);
      }

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
