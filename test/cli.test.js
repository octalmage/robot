import test from "node:test";
import assert from "node:assert/strict";
import { createCli } from "../src/cli.js";
import { createRobot, createStream, run } from "../test-support/cli.js";

test("generated root help lists public commands and integrations", async () => {
  const commands = [
    "windows",
    "activateWindow",
    "permissions",
    "screenshot",
    "click",
    "moveMouse",
    "type",
    "keyTap",
    "scrollMouse",
    "mousePos",
    "screenSize",
    "pixelColor",
    "openApp",
    "activateApp",
    "sequence",
    "findImage",
    "clickImage",
    "waitForImage",
    "text",
    "findText",
    "clickText",
    "waitForText",
    "findWord",
    "clickWord"
  ];

  for (const argv of [[], ["--help"]]) {
    const stdout = createStream();
    const exitCode = await run(argv, { stdout });
    const help = stdout.read();

    assert.equal(exitCode, 0);
    for (const command of commands) {
      assert.match(help, new RegExp(`\\b${command}\\b`));
    }
    for (const integration of ["completions", "mcp", "skills"]) {
      assert.match(help, new RegExp(`\\b${integration}\\b`));
    }
  }
});

test("clickText help exposes its generated query and options", async () => {
  const stdout = createStream();
  const exitCode = await run(["clickText", "--help"], { stdout });
  const help = stdout.read();

  assert.equal(exitCode, 0);
  assert.match(help, /query/);
  for (const option of ["--x", "--y", "--width", "--height", "--window", "--confidence", "--index", "--exact", "--fuzzy", "--ocr", "--rec-langs", "--ocr-model", "--ocr-strategy", "--keep-capture", "--button", "--double"]) {
    assert.match(help, new RegExp(option));
  }
  assert.match(help, /A trailing integer selects the 1-based occurrence/);
});

test("clickText schema exposes argument option and output contracts", async () => {
  const stdout = createStream();
  const exitCode = await run(["clickText", "--schema", "--format", "json"], { stdout });
  const schema = JSON.parse(stdout.read());

  assert.equal(exitCode, 0);
  assert.equal(schema.args.properties.query.type, "array");
  for (const option of ["index", "window", "keepCapture", "recLangs", "ocrModel", "ocrStrategy", "fuzzy", "button"]) {
    assert.ok(schema.options.properties[option]);
  }
  for (const field of ["query", "matches", "capture", "matchType", "editDistance", "similarity", "ambiguous", "button", "double"]) {
    assert.ok(schema.output.properties[field]);
  }
});
test("capture, OCR, input, click, and wait commands expose window scoping", async () => {
  for (const command of ["screenshot", "text", "findText", "click", "type", "keyTap", "waitForText", "waitForImage"]) {
    const stdout = createStream();
    const exitCode = await run([command, "--help"], { stdout });

    assert.equal(exitCode, 0);
    assert.match(stdout.read(), /--window/);
  }
});

test("MCP sequence accepts steps as an actual array", async () => {
  const events = [];
  const window = {
    id: "4242",
    title: "Minecraft",
    process: "javaw",
    processId: 1234,
    bounds: { x: 100, y: 200, width: 800, height: 600 },
    display: "\\\\.\\DISPLAY1",
    scale: 1.5
  };
  const cli = createCli({
    robot: createRobot({
      keyTap(key) {
        events.push(["keyTap", key]);
      }
    }),
    windowController: {
      async resolve(reference) {
        events.push(["resolve", reference]);
        return window;
      },
      async activate(selected) {
        events.push(["activate", selected.id]);
        return selected;
      }
    }
  });
  const request = (body) => cli.fetch(new Request("http://robot.local/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream"
    },
    body: JSON.stringify(body)
  }));

  const initialized = await request({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" }
    }
  });
  assert.equal(initialized.status, 200);

  const response = await request({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "call_write_tool",
      arguments: {
        name: "sequence",
        arguments: {
          window: window.id,
          steps: [{ command: "keyTap", key: "enter" }]
        }
      }
    }
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.result.structuredContent.steps, "inline MCP steps");
  assert.equal(body.result.structuredContent.completed, 1);
  assert.deepEqual(events, [
    ["resolve", window.id],
    ["activate", window.id],
    ["keyTap", "enter"]
  ]);
});

test("sequence schema documents clickText step fields", async () => {
  const stdout = createStream();
  const exitCode = await run(["sequence", "--schema", "--format", "json"], { stdout });
  const schema = JSON.parse(stdout.read());
  const stepsArray = schema.options.properties.steps.anyOf.find(
    (variant) => variant.type === "array"
  );
  const clickText = stepsArray.items.oneOf.find(
    (variant) => variant.properties.command.const === "clickText"
  );

  assert.equal(exitCode, 0);
  assert.ok(clickText.required.includes("query"));
  for (const field of ["index", "confidence", "exact", "fuzzy", "ocrModel", "ocrStrategy", "button", "double"]) {
    assert.ok(clickText.properties[field]);
  }
  assert.ok(schema.output.properties.results.items.properties.command.enum.includes("clickText"));
});

test("full LLM manifest is generated from command definitions", async () => {
  const stdout = createStream();
  const exitCode = await run(["--llms-full"], { stdout });
  const markdown = stdout.read();

  assert.equal(exitCode, 0);
  for (const fragment of ["# robot", "moveMouse", "waitForImage", "clickText", "Arguments", "Options", "`--index`"]) {
    assert.match(markdown, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(markdown, /Usage:\n  robot screenshot/);
});

test("native command output uses TOON", async () => {
  const stdout = createStream();
  const exitCode = await run(["mousePos"], { stdout, robot: createRobot() });

  assert.equal(exitCode, 0);
  assert.equal(stdout.read(), "x: 1\ny: 2\n");
});

