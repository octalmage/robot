import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRobot, createStream, run } from "../test-support/cli.js";

const TEST_WINDOW = {
  id: "4242",
  title: "Minecraft 1.21",
  process: "javaw",
  processId: 1234,
  bounds: { x: 100, y: 200, width: 800, height: 600 },
  display: "\\\\.\\DISPLAY1",
  scale: 1.5
};

test("permissions requests only missing macOS grants", async () => {
  const stdout = createStream();
  const calls = [];
  const robot = createRobot({
    getAccessibilityPermission() {
      calls.push("getAccessibility");
      return false;
    },
    requestAccessibilityPermission() {
      calls.push("requestAccessibility");
      return false;
    },
    getScreenCapturePermission() {
      calls.push("getScreenCapture");
      return false;
    },
    requestScreenCapturePermission() {
      calls.push("requestScreenCapture");
      return true;
    }
  });

  const exitCode = await run(["permissions", "--request", "--json"], {
    stdout,
    robot,
    platform: "darwin"
  });
  const result = JSON.parse(stdout.read());

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [
    "getAccessibility",
    "getScreenCapture",
    "requestScreenCapture",
    "requestAccessibility"
  ]);
  assert.deepEqual(result, {
    platform: "darwin",
    supported: true,
    requested: true,
    accessibility: false,
    screenRecording: true
  });
});

test("permissions reports unavailable controls without claiming a request", async () => {
  const stdout = createStream();

  const exitCode = await run(["permissions", "--request", "--json"], {
    stdout,
    robot: createRobot(),
    platform: "darwin"
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(JSON.parse(stdout.read()), {
    platform: "darwin",
    supported: false,
    requested: false,
    accessibility: null,
    screenRecording: null
  });
});

test("moveMouse uses smooth movement internally", async () => {
  const stdout = createStream();
  const calls = [];
  const robot = createRobot({
    moveMouseSmooth(x, y) {
      calls.push({ x, y });
    }
  });

  const exitCode = await run(["moveMouse", "450", "890", "--json"], { stdout, robot });
  const result = JSON.parse(stdout.read());

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [{ x: 450, y: 890 }]);
  assert.deepEqual(result, {
    x: 450,
    y: 890
  });
});

test("click uses the native default signature when no button is supplied", async () => {
  const stdout = createStream();
  const calls = [];
  const robot = createRobot({
    mouseClick(...args) {
      calls.push(args);
    }
  });

  const exitCode = await run(["click", "--json"], { stdout, robot });
  const result = JSON.parse(stdout.read());

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [[]]);
  assert.equal(result.button, "left");
  assert.equal(result.double, false);
});

test("click with coordinates moves smoothly before clicking", async () => {
  const stdout = createStream();
  const mouseMoves = [];
  const clickCalls = [];
  const robot = createRobot({
    moveMouseSmooth(x, y) {
      mouseMoves.push({ x, y });
    },
    mouseClick(...args) {
      clickCalls.push(args);
    }
  });

  const exitCode = await run(["click", "10", "20", "--json"], { stdout, robot });
  const result = JSON.parse(stdout.read());

  assert.equal(exitCode, 0);
  assert.deepEqual(mouseMoves, [{ x: 10, y: 20 }]);
  assert.deepEqual(clickCalls, [[]]);
  assert.equal(result.x, 10);
  assert.equal(result.y, 20);
});

test("types joined text with an optional typing speed", async () => {
  const stdout = createStream();
  const calls = [];
  const robot = createRobot({
    typeStringDelayed(text, cpm) {
      calls.push({ text, cpm });
    }
  });

  const exitCode = await run(["type", "hello", "world", "--cpm", "300", "--json"], { stdout, robot });
  const result = JSON.parse(stdout.read());

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [{ text: "hello world", cpm: 300 }]);
  assert.equal(result.text, "hello world");
  assert.equal(result.cpm, 300);
});

test("types with a reliable default speed", async () => {
  const stdout = createStream();
  const calls = [];
  const robot = createRobot({
    typeStringDelayed(text, cpm) {
      calls.push({ text, cpm });
    }
  });

  const exitCode = await run(["type", "hello", "--json"], { stdout, robot });
  const result = JSON.parse(stdout.read());

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [{ text: "hello", cpm: 12000 }]);
  assert.equal(result.text, "hello");
  assert.equal(result.cpm, 12000);
});

test("captures a screenshot and saves it to the requested output path", async (t) => {
  const stdout = createStream();
  const saveCalls = [];
  const robot = createRobot({
    screen: {
      capture(x, y, width, height) {
        assert.equal(x, 10);
        assert.equal(y, 20);
        assert.equal(width, 30);
        assert.equal(height, 40);

        return {
          width: 60,
          height: 80,
          byteWidth: 240,
          bitsPerPixel: 32,
          bytesPerPixel: 4,
          screenX: 10,
          screenY: 20,
          scaleX: 2,
          scaleY: 2,
          save(outputPath) {
            saveCalls.push(outputPath);
            fs.writeFileSync(outputPath, "raw");
            return true;
          }
        };
      }
    }
  });

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "robot-cli-test-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const exitCode = await run(["screenshot", "10", "20", "30", "40", "--output", "screen.bmp", "--json"], { stdout, robot, cwd });
  const result = JSON.parse(stdout.read());

  assert.equal(exitCode, 0);
  assert.deepEqual(saveCalls, [path.join(cwd, "screen.bmp")]);
  assert.equal(fs.readFileSync(path.join(cwd, "screen.bmp"), "utf8"), "raw");
  assert.equal(result.output, path.join(cwd, "screen.bmp"));
  assert.equal(result.capture.scaleX, 2);
});

test("screenshot fails when robotjs cannot save the capture", async () => {
  const stdout = createStream();
  const robot = createRobot({
    screen: {
      capture() {
        return { save: () => false };
      }
    }
  });

  const exitCode = await run(["screenshot", "--output", "failed.bmp", "--json"], {
    stdout,
    robot,
    cwd: path.join(path.sep, "tmp")
  });
  const result = JSON.parse(stdout.read());

  assert.equal(exitCode, 1);
  assert.equal(result.code, "SCREENSHOT_SAVE_FAILED");
  assert.match(result.message, /failed\.bmp/);
});

test("openApp delegates an arbitrary application name to the platform", async () => {
  const stdout = createStream();
  const processCalls = [];

  const exitCode = await run(["openApp", "Example", "App", "--json"], {
    stdout,
    platform: "darwin",
    runProcess(command, args, label) {
      processCalls.push({ command, args, label });
      return "";
    }
  });
  const result = JSON.parse(stdout.read());

  assert.equal(exitCode, 0);
  assert.deepEqual(processCalls, [
    {
      command: "/usr/bin/open",
      args: ["-a", "Example App"],
      label: "Open application"
    }
  ]);
  assert.equal(result.application, "Example App");
  assert.equal(result.target, "Example App");
});

test("activateApp delegates an arbitrary application name to the platform", async () => {
  const stdout = createStream();
  const processCalls = [];

  const exitCode = await run(["activateApp", "Example", "App", "--json"], {
    stdout,
    platform: "darwin",
    runProcess(command, args, label) {
      processCalls.push({ command, args, label });
      return "";
    }
  });
  const result = JSON.parse(stdout.read());

  assert.equal(exitCode, 0);
  assert.deepEqual(processCalls, [
    {
      command: "/usr/bin/open",
      args: ["-a", "Example App"],
      label: "Activate application"
    }
  ]);
  assert.equal(result.application, "Example App");
  assert.equal(result.target, "Example App");
});

test("windows returns IDs, ownership, bounds, display, and scale", async () => {
  const stdout = createStream();
  const calls = [];
  const exitCode = await run(["windows", "--json"], {
    stdout,
    platform: "win32",
    runProcess(command, args, label) {
      calls.push({ command, args, label });
      return JSON.stringify([TEST_WINDOW]);
    }
  });
  const result = JSON.parse(stdout.read());

  assert.equal(exitCode, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "powershell.exe");
  assert.equal(calls[0].label, "List windows");
  assert.deepEqual(result, { platform: "win32", windows: [TEST_WINDOW] });
});

test("activateWindow resolves a title wildcard and activates its window ID", async () => {
  const stdout = createStream();
  const calls = [];
  const exitCode = await run(["activateWindow", "--title", "Minecraft*", "--json"], {
    stdout,
    platform: "win32",
    runProcess(command, args, label) {
      calls.push({ command, args, label });
      return label === "List windows" ? JSON.stringify([TEST_WINDOW]) : "";
    }
  });
  const result = JSON.parse(stdout.read());

  assert.equal(exitCode, 0);
  assert.deepEqual(calls.map((call) => call.label), ["List windows", "Activate window"]);
  assert.equal(calls[1].args.at(-1), TEST_WINDOW.id);
  assert.deepEqual(result.window, TEST_WINDOW);
});

test("screenshot scopes captures to the activated window", async (t) => {
  const stdout = createStream();
  const events = [];
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "robot-window-test-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const robot = createRobot({
    screen: {
      capture(...args) {
        events.push(["capture", ...args]);
        return {
          width: 800,
          height: 600,
          byteWidth: 3200,
          bitsPerPixel: 32,
          bytesPerPixel: 4,
          screenX: 100,
          screenY: 200,
          scaleX: 1,
          scaleY: 1,
          save(output) {
            fs.writeFileSync(output, "raw");
            return true;
          }
        };
      }
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

  const exitCode = await run(["screenshot", "--window", "Minecraft", "--output", "window.bmp", "--json"], {
    stdout,
    cwd,
    robot,
    windowController
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(events, [
    ["resolve", "Minecraft"],
    ["activate", TEST_WINDOW.id],
    ["capture", 100, 200, 800, 600]
  ]);
});

test("click translates window-relative coordinates after activation", async () => {
  const stdout = createStream();
  const events = [];
  const robot = createRobot({
    moveMouseSmooth(x, y) {
      events.push(["move", x, y]);
    },
    mouseClick(...args) {
      events.push(["click", ...args]);
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

  const exitCode = await run(["click", "10", "20", "--window", "Minecraft", "--button", "right", "--json"], {
    stdout,
    robot,
    windowController
  });
  const result = JSON.parse(stdout.read());

  assert.equal(exitCode, 0);
  assert.deepEqual(events, [
    ["resolve", "Minecraft"],
    ["activate", TEST_WINDOW.id],
    ["move", 110, 220],
    ["click", "right"]
  ]);
  assert.deepEqual(result, { x: 110, y: 220, button: "right", double: false });
});

test("sequence keeps focus and input steps in one runtime", async (t) => {
  const stdout = createStream();
  const events = [];
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "robot-sequence-test-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, "steps.json"), JSON.stringify([
    { command: "keyTap", key: "a", modifiers: ["control", "shift"] },
    { command: "type", text: "cycle complete", cpm: 6000 },
    { command: "click", x: 10, y: 20, button: "right", double: true }
  ]));
  const robot = createRobot({
    keyTap(...args) {
      events.push(["keyTap", ...args]);
    },
    typeStringDelayed(...args) {
      events.push(["type", ...args]);
    },
    moveMouseSmooth(...args) {
      events.push(["move", ...args]);
    },
    mouseClick(...args) {
      events.push(["click", ...args]);
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

  const exitCode = await run(["sequence", "--window", "Minecraft", "--steps", "steps.json", "--json"], {
    stdout,
    cwd,
    robot,
    windowController
  });
  const result = JSON.parse(stdout.read());

  assert.equal(exitCode, 0);
  assert.deepEqual(events, [
    ["resolve", "Minecraft"],
    ["activate", TEST_WINDOW.id],
    ["keyTap", "a", ["control", "shift"]],
    ["type", "cycle complete", 6000],
    ["move", 110, 220],
    ["click", "right", true]
  ]);
  assert.equal(result.completed, 3);
  assert.deepEqual(result.results[2], {
    index: 3,
    command: "click",
    x: 110,
    y: 220,
    button: "right",
    double: true
  });
});

test("activateApp failure reports matching window diagnostics", async () => {
  const stdout = createStream();
  const exitCode = await run(["activateApp", "Minecraft", "--json"], {
    stdout,
    platform: "win32",
    runProcess(command, args, label) {
      if (label === "Activate application") {
        throw new Error("AppActivate returned false");
      }
      assert.equal(label, "List windows");
      return JSON.stringify([TEST_WINDOW]);
    }
  });
  const result = JSON.parse(stdout.read());

  assert.equal(exitCode, 1);
  assert.equal(result.code, "APPLICATION_ACTIVATION_FAILED");
  for (const detail of ["Minecraft 1.21", "id=4242", "process=javaw", "bounds=100,200,800x600", `display=${TEST_WINDOW.display}`, "scale=1.5"]) {
    assert.ok(result.message.includes(detail), `Missing diagnostic: ${detail}`);
  }
});

