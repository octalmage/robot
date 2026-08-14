import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRobot, createStream, createTextCapture, run } from "../test-support/cli.js";

const TEST_WINDOW = {
  id: "4242",
  title: "Minecraft",
  process: "javaw",
  processId: 1234,
  bounds: { x: 100, y: 200, width: 800, height: 600 },
  display: "display-1",
  scale: 1
};

function createConfigFixture(t, payload) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "robot-config-test-"));
  const configPath = path.join(directory, "config.json");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  if (payload !== undefined) {
    fs.writeFileSync(configPath, `${JSON.stringify(payload, null, 2)}\n`);
  }
  return configPath;
}

test("config reports built-ins and initializes recommended agent defaults without overwriting", async (t) => {
  const configPath = createConfigFixture(t);
  const emptyStdout = createStream();
  assert.equal(await run(["config", "--format", "json"], { stdout: emptyStdout, configPath }), 0);
  assert.deepEqual(JSON.parse(emptyStdout.read()), {
    path: configPath,
    exists: false,
    defaults: {
      cpm: 600,
      ocrModel: "tiny",
      ocrStrategy: "per-box",
      fuzzy: false
    },
    created: false
  });

  const initializedStdout = createStream();
  assert.equal(await run(["config", "--init", "--format", "json"], {
    stdout: initializedStdout,
    configPath
  }), 0);
  const initialized = JSON.parse(initializedStdout.read());
  const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(initialized.created, true);
  assert.deepEqual(saved, {
    defaults: {
      cpm: 600,
      ocrModel: "small",
      ocrStrategy: "per-box",
      fuzzy: true
    }
  });

  const existingStdout = createStream();
  assert.equal(await run(["config", "--init", "--format", "json"], {
    stdout: existingStdout,
    configPath
  }), 0);
  assert.equal(JSON.parse(existingStdout.read()).created, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), saved);
});

test("shared config defaults apply to OCR and per-command then CLI options take precedence", async (t) => {
  const configPath = createConfigFixture(t, {
    defaults: {
      cpm: 900,
      ocrModel: "small",
      ocrStrategy: "per-line",
      fuzzy: true
    },
    commands: {
      type: { options: { cpm: 750 } }
    }
  });
  const robot = createRobot({
    screen: {
      capture() {
        return createTextCapture({ width: 200, height: 100 });
      }
    }
  });
  const ocrBackend = {
    async recognize() {
      return [{
        text: "Gane",
        confidence: 0.9,
        bounds: { x: 20, y: 10, width: 40, height: 20 }
      }];
    }
  };
  const configuredStdout = createStream();
  assert.equal(await run(["findText", "Game", "--format", "json"], {
    stdout: configuredStdout,
    configPath,
    robot,
    ocrBackend
  }), 0);
  const configured = JSON.parse(configuredStdout.read());
  assert.equal(configured.found, true);
  assert.equal(configured.matchType, "fuzzy");
  assert.equal(configured.fuzzy, true);
  assert.equal(configured.ocrModel, "small");
  assert.equal(configured.ocrStrategy, "per-line");

  const explicitStdout = createStream();
  assert.equal(await run([
    "findText", "Game", "--no-fuzzy", "--ocr-model", "tiny", "--ocr-strategy", "per-box", "--format", "json"
  ], {
    stdout: explicitStdout,
    configPath,
    robot,
    ocrBackend
  }), 0);
  const explicit = JSON.parse(explicitStdout.read());
  assert.equal(explicit.found, false);
  assert.equal(explicit.fuzzy, false);
  assert.equal(explicit.ocrModel, "tiny");
  assert.equal(explicit.ocrStrategy, "per-box");

  const typeCalls = [];
  const typingRobot = createRobot({
    typeStringDelayed(text, cpm) {
      typeCalls.push({ text, cpm });
    }
  });
  assert.equal(await run(["type", "configured"], { configPath, robot: typingRobot }), 0);
  assert.equal(await run(["type", "explicit", "--cpm", "300"], { configPath, robot: typingRobot }), 0);
  assert.deepEqual(typeCalls, [
    { text: "configured", cpm: 750 },
    { text: "explicit", cpm: 300 }
  ]);
});

test("sequence inherits configured window, typing, and OCR defaults while step options remain explicit", async (t) => {
  const configPath = createConfigFixture(t, {
    defaults: {
      window: "Minecraft",
      cpm: 700,
      ocrModel: "small",
      ocrStrategy: "per-line",
      fuzzy: true
    }
  });
  const events = [];
  const robot = createRobot({
    screen: {
      capture() {
        return createTextCapture({
          width: TEST_WINDOW.bounds.width,
          height: TEST_WINDOW.bounds.height,
          screenX: TEST_WINDOW.bounds.x,
          screenY: TEST_WINDOW.bounds.y
        });
      }
    },
    typeStringDelayed(...args) {
      events.push(["type", ...args]);
    }
  });
  const windowController = {
    async resolve(reference) {
      events.push(["resolve", reference]);
      return TEST_WINDOW;
    },
    async activate(window) {
      events.push(["activate", window.id]);
      return window;
    }
  };
  const steps = JSON.stringify([
    { command: "type", text: "hello" },
    { command: "assertText", query: "Game" },
    { command: "type", text: "fast", cpm: 1200 }
  ]);
  const stdout = createStream();

  assert.equal(await run(["sequence", "--steps-json", steps, "--format", "json"], {
    stdout,
    configPath,
    robot,
    windowController,
    ocrBackend: {
      async recognize() {
        return [{
          text: "Gane",
          confidence: 0.95,
          bounds: { x: 10, y: 10, width: 40, height: 20 }
        }];
      }
    }
  }), 0);
  const result = JSON.parse(stdout.read());

  assert.deepEqual(events, [
    ["resolve", "Minecraft"],
    ["activate", TEST_WINDOW.id],
    ["type", "hello", 700],
    ["type", "fast", 1200]
  ]);
  assert.equal(result.results[1].found, true);
  assert.equal(result.results[1].matchType, "fuzzy");
  assert.equal(result.results[1].fuzzy, true);
  assert.equal(result.results[1].ocrModel, "small");
  assert.equal(result.results[1].ocrStrategy, "per-line");
});

test("text inventories recognized labels with bounds and screen points", async () => {
  const stdout = createStream();
  const robot = createRobot({
    screen: {
      capture() {
        return createTextCapture({ width: 200, height: 100, screenX: 50, screenY: 75 });
      }
    }
  });

  assert.equal(await run(["text", "--format", "json"], {
    stdout,
    robot,
    ocrBackend: {
      async recognize() {
        return [{
          text: "Settings",
          confidence: 0.98,
          bounds: { x: 10, y: 5, width: 40, height: 20 }
        }];
      }
    }
  }), 0);
  const result = JSON.parse(stdout.read());

  assert.equal(result.ocrModel, "tiny");
  assert.equal(result.ocrStrategy, "per-box");
  assert.deepEqual(result.displays[0].items, [{
    text: "Settings",
    confidence: 0.98,
    bounds: { x: 10, y: 5, width: 40, height: 20 },
    screenPoint: { x: 80, y: 90 }
  }]);
  assert.deepEqual(result.allItems, [{
    text: "Settings",
    confidence: 0.98,
    bounds: { x: 10, y: 5, width: 40, height: 20 },
    screenPoint: { x: 80, y: 90 },
    displayId: 1
  }]);
});

test("invalid shared defaults fail before desktop automation starts", async (t) => {
  const configPath = createConfigFixture(t, {
    defaults: { ocrModel: "huge" }
  });
  const stdout = createStream();
  const exitCode = await run(["text", "--format", "json"], { stdout, configPath });
  const result = JSON.parse(stdout.read());

  assert.equal(exitCode, 1);
  assert.equal(result.code, "CONFIG_INVALID");
  assert.match(result.message, /ocrModel/);
});
