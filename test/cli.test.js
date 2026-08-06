import test from "node:test";
import assert from "node:assert/strict";
import { createRobot, createStream, run } from "../test-support/cli.js";

test("generated root help lists public commands and integrations", async () => {
  const commands = [
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
  for (const option of ["--x", "--y", "--width", "--height", "--confidence", "--index", "--exact", "--ocr", "--rec-langs", "--ocr-strategy", "--keep-capture", "--button", "--double"]) {
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
  for (const option of ["index", "keepCapture", "recLangs", "ocrStrategy", "button"]) {
    assert.ok(schema.options.properties[option]);
  }
  for (const field of ["query", "matches", "capture", "button", "double"]) {
    assert.ok(schema.output.properties[field]);
  }
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

