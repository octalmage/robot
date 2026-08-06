import { Cli, Errors, z } from "incur";
import packageJson from "../package.json" with { type: "json" };
import { registerDesktopCommands } from "./commands/desktop.js";
import { registerImageCommands } from "./commands/image.js";
import { registerTextCommands } from "./commands/text.js";
import { createRuntime } from "./runtime.js";

const DESCRIPTION = "Single-shot desktop automation with mouse, keyboard, image matching, and OCR.";
const SYNC_BODY = "macOS requires Accessibility permission for mouse/keyboard control and Screen Recording permission for capture and OCR. ROBOT_OCR_PATH selects an external OCR backend.";

export function createCli(overrides = {}) {
  const cli = Cli.create("robot", {
    description: DESCRIPTION,
    version: packageJson.version,
    update: false,
    env: z.object({
      ROBOT_OCR_PATH: z.string().optional().describe("External OCR executable path or command")
    }),
    vars: z.object({
      runtime: z.custom().optional()
    }),
    sync: {
      depth: 0,
      suggestions: [
        "take a screenshot and click visible text",
        "wait for an image and click it"
      ],
      body: SYNC_BODY
    }
  });

  cli.use(async (c, next) => {
    const runtime = createRuntime(overrides, c.env);
    c.set("runtime", runtime);

    try {
      try {
        await next();
      } finally {
        await runtime.dispose();
      }
    } catch (error) {
      if (error instanceof Errors.IncurError || error instanceof Errors.ValidationError) {
        throw error;
      }

      if (error && typeof error.code === "string") {
        throw new Errors.IncurError({
          code: error.code,
          message: error.message,
          exitCode: error.exitCode,
          cause: error
        });
      }

      throw error;
    }
  });

  registerDesktopCommands(cli);
  registerImageCommands(cli);
  registerTextCommands(cli);
  return cli;
}

export default createCli();
