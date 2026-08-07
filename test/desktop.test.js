import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRobot, createStream, createTextCapture, run } from "../test-support/cli.js";
import { createWindowController } from "../src/windows.js";

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
test("type and keyTap activate a selected window before sending input", async () => {
  const events = [];
  const robot = createRobot({
    typeStringDelayed(...args) {
      events.push(["type", ...args]);
    },
    keyTap(...args) {
      events.push(["keyTap", ...args]);
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

  assert.equal(await run(["type", "stick", "--window", TEST_WINDOW.id, "--json"], {
    robot,
    windowController
  }), 0);
  assert.equal(await run(["keyTap", "enter", "--window", TEST_WINDOW.id, "--json"], {
    robot,
    windowController
  }), 0);
  assert.deepEqual(events, [
    ["resolve", TEST_WINDOW.id],
    ["activate", TEST_WINDOW.id],
    ["type", "stick", 12000],
    ["resolve", TEST_WINDOW.id],
    ["activate", TEST_WINDOW.id],
    ["keyTap", "enter"]
  ]);
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
test("screenshot manages temporary captures and cleans them only with an explicit TTL", async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "robot-managed-capture-test-"));
  const captureRoot = path.join(cwd, "captures");
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const robot = createRobot({
    screen: {
      capture() {
        return createTextCapture();
      }
    }
  });

  const firstStdout = createStream();
  assert.equal(await run(["screenshot", "--temp", "--json"], {
    stdout: firstStdout,
    cwd,
    captureRoot,
    robot,
    now: () => 10000
  }), 0);
  const first = JSON.parse(firstStdout.read());
  assert.equal(first.managed, true);
  assert.ok(fs.existsSync(first.output));
  assert.equal(fs.readFileSync(first.latest, "utf8"), "raw");
  assert.ok(first.imageUri.startsWith("file://"));

  const stale = path.join(path.dirname(first.output), "capture-stale.png");
  fs.writeFileSync(stale, "stale");
  fs.utimesSync(stale, new Date(0), new Date(0));
  const secondStdout = createStream();
  assert.equal(await run(["screenshot", "--temp", "--temp-ttl", "1000", "--json"], {
    stdout: secondStdout,
    cwd,
    captureRoot,
    robot,
    now: () => 10000
  }), 0);
  assert.equal(fs.existsSync(stale), false);
  assert.ok(fs.existsSync(first.output), "a capture without an expired timestamp must remain");
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

test("windows returns metadata and filters minimized entries", async () => {
  const stdout = createStream();
  const calls = [];
  const exitCode = await run(["windows", "--json"], {
    stdout,
    platform: "win32",
    runProcess(command, args, label) {
      calls.push({ command, args, label });
      return JSON.stringify([
        TEST_WINDOW,
        {
          ...TEST_WINDOW,
          id: "99",
          title: "Snipping Tool",
          bounds: { x: -31993, y: -32000, width: 300, height: 200 },
          minimized: true
        }
      ]);
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
  assert.deepEqual(calls[1].args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
  assert.equal(calls[1].args.length, 4);
  assert.match(calls[1].args[3], /\$handle = \[long\]::Parse\('4242'/);
  assert.doesNotMatch(calls[1].args[3], /\$args\[0\]/);
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
test("sequence accepts inline JSON and stdin without step files", async () => {
  const events = [];
  const robot = createRobot({
    keyTap(...args) {
      events.push(["keyTap", ...args]);
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
  const inline = JSON.stringify([{ command: "keyTap", key: "backspace" }]);
  const inlineStdout = createStream();
  assert.equal(await run(["sequence", "--window", TEST_WINDOW.id, "--steps-json", inline, "--json"], {
    stdout: inlineStdout,
    robot,
    windowController
  }), 0);
  assert.equal(JSON.parse(inlineStdout.read()).steps, "--steps-json");

  const stdinStdout = createStream();
  assert.equal(await run(["sequence", "--window", TEST_WINDOW.id, "--steps", "-", "--json"], {
    stdout: stdinStdout,
    robot,
    windowController,
    readStdin: () => JSON.stringify([{ command: "type", text: "32" }])
  }), 0);
  assert.equal(JSON.parse(stdinStdout.read()).steps, "stdin");
  assert.deepEqual(events, [
    ["resolve", TEST_WINDOW.id],
    ["activate", TEST_WINDOW.id],
    ["keyTap", "backspace"],
    ["resolve", TEST_WINDOW.id],
    ["activate", TEST_WINDOW.id],
    ["type", "32", 12000]
  ]);
});

test("sequence verifies text in the selected window before continuing", async () => {
  const stdout = createStream();
  const captures = [];
  let clock = 0;
  let ocrCall = 0;
  const robot = createRobot({
    screen: {
      capture(...args) {
        captures.push(args);
        return createTextCapture({
          width: TEST_WINDOW.bounds.width,
          height: TEST_WINDOW.bounds.height,
          screenX: TEST_WINDOW.bounds.x,
          screenY: TEST_WINDOW.bounds.y
        });
      }
    }
  });
  const ocrBackend = {
    async recognize() {
      ocrCall += 1;
      if (ocrCall === 1) {
        return [{ text: "Stick", confidence: 0.99, bounds: { x: 5, y: 5, width: 40, height: 20 } }];
      }
      if (ocrCall === 2) {
        return [];
      }
      return [{ text: "Ready", confidence: 0.95, bounds: { x: 10, y: 10, width: 50, height: 20 } }];
    }
  };
  const steps = JSON.stringify([
    { command: "assertText", query: "Stick", exact: true },
    { command: "waitForText", query: "Ready", exact: true, timeout: 500 }
  ]);

  assert.equal(await run(["sequence", "--window", TEST_WINDOW.id, "--steps-json", steps, "--json"], {
    stdout,
    robot,
    ocrBackend,
    now: () => clock,
    sleep: async (duration) => {
      clock += duration;
    },
    windowController: {
      async resolve() {
        return TEST_WINDOW;
      },
      async activate(window) {
        return window;
      }
    }
  }), 0);
  const result = JSON.parse(stdout.read());
  assert.equal(result.completed, 2);
  assert.deepEqual(result.results.map((entry) => entry.command), ["assertText", "waitForText"]);
  assert.equal(result.results[0].matchedText, "Stick");
  assert.equal(result.results[1].matchedText, "Ready");
  assert.equal(result.results[1].attempts, 2);
  assert.deepEqual(captures, [
    [100, 200, 800, 600],
    [100, 200, 800, 600],
    [100, 200, 800, 600]
  ]);
});

test("sequence captures its selected window when an assertion fails", async (t) => {
  const stdout = createStream();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "robot-sequence-failure-test-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const steps = JSON.stringify([{ command: "assertText", query: "Committed", exact: true }]);
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
    }
  });

  const exitCode = await run([
    "sequence",
    "--window",
    TEST_WINDOW.id,
    "--steps-json",
    steps,
    "--capture-on-failure",
    "--json"
  ], {
    stdout,
    cwd,
    captureRoot: path.join(cwd, "captures"),
    robot,
    ocrBackend: { async recognize() { return []; } },
    windowController: {
      async resolve() {
        return TEST_WINDOW;
      },
      async activate(window) {
        return window;
      }
    }
  });
  const result = JSON.parse(stdout.read());
  const captures = result.message.match(/Failure capture: (.+?\.png)\. Latest capture: (.+?\.png)\./s);

  assert.equal(exitCode, 1);
  assert.equal(result.code, "SEQUENCE_ASSERTION_FAILED");
  assert.ok(captures);
  assert.ok(fs.existsSync(captures[1]));
  assert.ok(fs.existsSync(captures[2]));
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

test("Windows activation script resolves its native thread APIs", {
  skip: process.platform !== "win32"
}, async () => {
  const controller = createWindowController("win32", (command, args, label) => {
    const result = spawnSync(command, args, { encoding: "utf8" });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(`${label}: ${(result.stderr || result.stdout || "").trim()}`);
    }
    return result.stdout;
  });

  await assert.rejects(
    controller.activate({ ...TEST_WINDOW, id: "0" }),
    (error) => {
      assert.equal(error.code, "WINDOW_ACTIVATION_FAILED");
      assert.doesNotMatch(error.message, /EntryPointNotFoundException|GetCurrentThreadId.*entry point/i);
      assert.match(error.message, /Windows rejected the foreground-window request/);
      return true;
    }
  );
});

