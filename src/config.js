import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Errors, z } from "incur";

export const BUILTIN_AUTOMATION_DEFAULTS = Object.freeze({
  cpm: 600,
  ocrBackend: "paddle",
  ocrModel: "tiny",
  ocrStrategy: "per-box",
  fuzzy: false
});

export const RECOMMENDED_AGENT_DEFAULTS = Object.freeze({
  cpm: 600,
  ocrBackend: "paddle",
  ocrModel: "small",
  ocrStrategy: "per-box",
  fuzzy: true
});

const userDefaultsSchema = z.object({
  cpm: z.number().positive().optional(),
  ocrBackend: z.enum(["paddle", "rapidocr"]).optional(),
  ocrModel: z.enum(["tiny", "small"]).optional(),
  ocrStrategy: z.enum(["per-box", "per-line", "cross-line"]).optional(),
  fuzzy: z.boolean().optional(),
  window: z.string().min(1).optional()
}).strict();

const resolvedDefaultsSchema = z.object({
  cpm: z.number().positive(),
  ocrBackend: z.enum(["paddle", "rapidocr"]),
  ocrModel: z.enum(["tiny", "small"]),
  ocrStrategy: z.enum(["per-box", "per-line", "cross-line"]),
  fuzzy: z.boolean(),
  window: z.string().optional()
});

const TEXT_COMMANDS = ["text", "findText", "findWord", "clickText", "clickWord", "waitForText"];
const TEXT_MATCH_COMMANDS = ["findText", "findWord", "clickText", "clickWord", "waitForText"];
const WINDOW_COMMANDS = [
  "screenshot",
  "click",
  "type",
  "keyTap",
  "text",
  ...TEXT_MATCH_COMMANDS,
  "findImage",
  "clickImage",
  "waitForImage",
  "sequence"
];
const DEFAULT_TARGETS = {
  ocrBackend: [...TEXT_COMMANDS, "sequence"],
  cpm: ["type", "sequence"],
  ocrModel: [...TEXT_COMMANDS, "sequence"],
  ocrStrategy: [...TEXT_COMMANDS, "sequence"],
  fuzzy: [...TEXT_MATCH_COMMANDS, "sequence"],
  window: WINDOW_COMMANDS
};

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function createConfigError(message, cause) {
  return new Errors.IncurError({
    code: "CONFIG_INVALID",
    message,
    exitCode: 1,
    cause
  });
}

function validatePayload(payload, configPath) {
  if (!isRecord(payload)) {
    throw createConfigError(`Invalid robot config: expected an object in ${configPath}.`);
  }
  if (payload.commands !== undefined && !isRecord(payload.commands)) {
    throw createConfigError(`Invalid robot config: commands must be an object in ${configPath}.`);
  }

  const parsed = userDefaultsSchema.safeParse(payload.defaults ?? {});
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "defaults"}: ${issue.message}`)
      .join("; ");
    throw createConfigError(`Invalid robot defaults in ${configPath}: ${details}`);
  }
  return parsed.data;
}

function expandDefaults(payload, defaults, configPath) {
  const commands = { ...(payload.commands ?? {}) };
  const generatedOptions = new Map();

  for (const [name, value] of Object.entries(defaults)) {
    for (const command of DEFAULT_TARGETS[name] ?? []) {
      const options = generatedOptions.get(command) ?? {};
      options[name] = value;
      generatedOptions.set(command, options);
    }
  }

  for (const [command, defaultsForCommand] of generatedOptions) {
    const existing = commands[command] ?? {};
    if (!isRecord(existing)) {
      throw createConfigError(`Invalid robot config: commands.${command} must be an object in ${configPath}.`);
    }
    if (existing.options !== undefined && !isRecord(existing.options)) {
      throw createConfigError(`Invalid robot config: commands.${command}.options must be an object in ${configPath}.`);
    }
    commands[command] = {
      ...existing,
      options: {
        ...defaultsForCommand,
        ...(existing.options ?? {})
      }
    };
  }

  return { ...payload, commands };
}

export function defaultRobotConfigPath() {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configHome, "robot", "config.json");
}

export function createRobotConfigSupport(options = {}) {
  const configPath = options.path || defaultRobotConfigPath();
  const state = {
    path: configPath,
    exists: fs.existsSync(configPath),
    defaults: {}
  };

  function loader(resolvedPath) {
    state.path = resolvedPath || configPath;
    state.exists = !!resolvedPath;
    state.defaults = {};
    if (!resolvedPath) {
      return undefined;
    }

    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
    } catch (error) {
      throw createConfigError(`Could not read robot config ${resolvedPath}: ${error.message}`, error);
    }

    const defaults = validatePayload(payload, resolvedPath);
    state.defaults = defaults;
    return expandDefaults(payload, defaults, resolvedPath);
  }

  function initialize() {
    if (fs.existsSync(configPath)) {
      state.path = configPath;
      state.exists = true;
      return false;
    }

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      `${JSON.stringify({ defaults: RECOMMENDED_AGENT_DEFAULTS }, null, 2)}\n`,
      { flag: "wx" }
    );
    state.path = configPath;
    state.exists = true;
    state.defaults = { ...RECOMMENDED_AGENT_DEFAULTS };
    return true;
  }

  function inspect() {
    return {
      path: state.path,
      exists: state.exists,
      defaults: {
        ...BUILTIN_AUTOMATION_DEFAULTS,
        ...state.defaults
      }
    };
  }

  return {
    files: [configPath],
    loader,
    initialize,
    inspect
  };
}

export function registerConfigCommand(cli, support) {
  cli.command("config", {
    description: "Show or initialize user-wide automation defaults.",
    options: z.object({
      init: z.boolean().optional().describe("Create the recommended agent config without overwriting an existing file")
    }),
    output: z.object({
      path: z.string().describe("Resolved user config path"),
      exists: z.boolean().describe("Whether the config file exists"),
      created: z.boolean().describe("Whether this command created the config file"),
      defaults: resolvedDefaultsSchema.describe("Effective shared automation defaults")
    }),
    hint: "The recommended config uses Small OCR and strict-first fuzzy fallback. Explicit command options still win.",
    run(c) {
      const created = c.options.init ? support.initialize() : false;
      return { ...support.inspect(), created };
    }
  });
}
