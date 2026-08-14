import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createRobot, createStream, createTextCapture, run } from "../test-support/cli.js";
import { createWindowController, createWindowsWindowHost } from "../src/windows.js";

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
  assert.deepEqual(calls, [{ text: "hello", cpm: 600 }]);
  assert.equal(result.text, "hello");
  assert.equal(result.cpm, 600);
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
    ["type", "stick", 600],
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
    cwd: path.resolve(path.sep, "tmp")
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

test("Windows and Linux application adapters preserve the requested target", async () => {
  const cases = [
    {
      platform: "win32",
      command: "openApp",
      executable: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", "Start-Process -FilePath $args[0]", "Example App"]
    },
    {
      platform: "win32",
      command: "activateApp",
      executable: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$shell = New-Object -ComObject WScript.Shell; if (-not $shell.AppActivate($args[0])) { exit 1 }",
        "Example App"
      ]
    },
    {
      platform: "linux",
      command: "openApp",
      executable: "gtk-launch",
      args: ["Example App"]
    },
    {
      platform: "linux",
      command: "activateApp",
      executable: "wmctrl",
      args: ["-xa", "Example App"]
    }
  ];

  for (const expectation of cases) {
    const stdout = createStream();
    const calls = [];
    const exitCode = await run([expectation.command, "Example", "App", "--json"], {
      stdout,
      platform: expectation.platform,
      runProcess(command, args, label) {
        calls.push({ command, args, label });
        return "";
      }
    });

    assert.equal(exitCode, 0, `${expectation.platform} ${expectation.command}`);
    assert.deepEqual(calls, [{
      command: expectation.executable,
      args: expectation.args,
      label: expectation.command === "openApp" ? "Open application" : "Activate application"
    }]);
    assert.deepEqual(JSON.parse(stdout.read()), {
      application: "Example App",
      target: "Example App"
    });
  }
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

test("Windows scoped commands reuse one PowerShell window host", async () => {
  const stdout = createStream();
  const child = new EventEmitter();
  const spawnCalls = [];
  const operations = [];
  let inputBuffer = "";

  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.exitCode = 0;
    queueMicrotask(() => child.emit("exit", 0, null));
    return true;
  };
  child.stdin.on("data", (chunk) => {
    inputBuffer += chunk.toString();
    let newlineIndex = inputBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const request = JSON.parse(inputBuffer.slice(0, newlineIndex));
      operations.push(request.operation);
      const data = request.operation === "list" ? [TEST_WINDOW] : true;
      child.stdout.write(`${JSON.stringify({ id: request.id, ok: true, data })}\n`);
      inputBuffer = inputBuffer.slice(newlineIndex + 1);
      newlineIndex = inputBuffer.indexOf("\n");
    }
  });

  const windowsHost = createWindowsWindowHost({
    spawnProcess(command, args, options) {
      spawnCalls.push({ command, args, options });
      return child;
    }
  });
  const exitCode = await run(["activateWindow", "--id", TEST_WINDOW.id, "--json"], {
    stdout,
    platform: "win32",
    windowsHost,
    runProcess() {
      assert.fail("Persistent Windows host should replace one-shot PowerShell calls");
    }
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(JSON.parse(stdout.read()).window, TEST_WINDOW);
  assert.deepEqual(operations, ["list", "activate", "list"]);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, "powershell.exe");
  assert.deepEqual(spawnCalls[0].args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
  assert.deepEqual(spawnCalls[0].options, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  assert.equal(child.killed, true);
});


test("Linux windows use WM_CLASS as their process identifier and omit untitled entries", async () => {
  const output = [
    "0x03e00007  0 1234 100 200 800 600 workstation example.ExampleApp Example Window",
    "0x03e00008  0 2345 10 20 300 200 workstation hidden.HiddenApp"
  ].join("\n");
  const calls = [];
  const controller = createWindowController("linux", (command, args, label) => {
    calls.push({ command, args, label });
    return output;
  });

  const windows = await controller.list();

  assert.deepEqual(calls, [{ command: "wmctrl", args: ["-lpGx"], label: "List windows" }]);
  assert.deepEqual(windows, [{
    id: "0x03e00007",
    title: "Example Window",
    process: "example.ExampleApp",
    processId: 1234,
    bounds: { x: 100, y: 200, width: 800, height: 600 },
    display: null,
    scale: null
  }]);
});

test("window adapters share resolution and activation-refresh behavior", async () => {
  const staleBounds = { x: -20, y: 30, width: 300, height: 200 };
  const refreshedBounds = { x: 40, y: 50, width: 800, height: 600 };
  const cases = [
    {
      platform: "win32",
      id: "4242",
      process: "ExampleApp",
      activationCommand: "powershell.exe"
    },
    {
      platform: "darwin",
      id: "4242",
      process: "ExampleApp",
      activationCommand: "/usr/bin/osascript"
    },
    {
      platform: "linux",
      id: "0x03e00007",
      process: "example.ExampleApp",
      activationCommand: "wmctrl"
    }
  ];

  for (const entry of cases) {
    let listCount = 0;
    const calls = [];
    const controller = createWindowController(entry.platform, (command, args, label) => {
      calls.push({ command, args, label });
      if (label !== "List windows") {
        return "";
      }

      listCount += 1;
      const bounds = listCount === 1 ? staleBounds : refreshedBounds;
      if (entry.platform === "linux") {
        return `${entry.id}  0 1234 ${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height} workstation ${entry.process} Example Window`;
      }
      return JSON.stringify([{
        id: entry.id,
        title: "Example Window",
        process: entry.process,
        processId: 1234,
        bounds,
        display: "1",
        scale: 1
      }]);
    });

    const resolved = await controller.resolve(entry.process);
    const activated = await controller.activate(resolved);

    assert.deepEqual(resolved.bounds, staleBounds, entry.platform);
    assert.deepEqual(activated.bounds, refreshedBounds, entry.platform);
    assert.deepEqual(
      calls.map((call) => call.label),
      ["List windows", "Activate window", "List windows"],
      entry.platform
    );
    assert.equal(calls[1].command, entry.activationCommand, entry.platform);
  }
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
  assert.deepEqual(calls.map((call) => call.label), ["List windows", "Activate window", "List windows"]);
  assert.deepEqual(calls[1].args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
  assert.equal(calls[1].args.length, 4);
  assert.match(calls[1].args[3], /\$handle = \[long\]::Parse\('4242'/);
  assert.doesNotMatch(calls[1].args[3], /\$args\[0\]/);
  assert.deepEqual(result.window, TEST_WINDOW);
});

test("activation refreshes window bounds before scoped capture", async () => {
  const staleWindow = {
    ...TEST_WINDOW,
    bounds: { x: -290, y: 803, width: 107, height: 96 }
  };
  const refreshedWindow = {
    ...TEST_WINDOW,
    bounds: { x: 85, y: 213, width: 1096, height: 697 }
  };
  const calls = [];
  const controller = createWindowController("darwin", (command, args, label) => {
    calls.push(label);
    return label === "List windows" ? JSON.stringify([refreshedWindow]) : "";
  });

  assert.deepEqual(await controller.activate(staleWindow), refreshedWindow);
  assert.deepEqual(calls, ["Activate window", "List windows"]);
});

test("window references prefer exact process names over title substrings", async () => {
  const notesWindow = {
    ...TEST_WINDOW,
    id: "9001",
    title: "All iCloud",
    process: "Notes"
  };
  const unrelatedWindow = {
    ...TEST_WINDOW,
    id: "9002",
    title: "Fix Notes window capture error",
    process: "iTerm"
  };
  const controller = createWindowController("darwin", (command, args, label) => {
    assert.equal(label, "List windows");
    return JSON.stringify([unrelatedWindow, notesWindow]);
  });

  assert.deepEqual(await controller.resolve("Notes"), notesWindow);
});

test("window references reject ambiguous process matches before capture", async () => {
  const notesWindows = [
    { ...TEST_WINDOW, id: "9001", title: "All iCloud", process: "Notes" },
    { ...TEST_WINDOW, id: "9002", title: "Shopping", process: "Notes" }
  ];
  const unrelatedWindow = {
    ...TEST_WINDOW,
    id: "9003",
    title: "Fix Notes window capture error",
    process: "iTerm"
  };
  const controller = createWindowController("darwin", () =>
    JSON.stringify([unrelatedWindow, ...notesWindows])
  );

  await assert.rejects(controller.resolve("Notes"), (error) => {
    assert.equal(error.code, "WINDOW_AMBIGUOUS");
    assert.match(error.message, /All iCloud/);
    assert.match(error.message, /Shopping/);
    assert.doesNotMatch(error.message, /Fix Notes window capture error/);
    return true;
  });
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
    ["type", "32", 600]
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

test("sequence clickText finds and clicks text inside the selected window", async () => {
  const stdout = createStream();
  const events = [];
  const robot = createRobot({
    screen: {
      capture(...args) {
        events.push(["capture", ...args]);
        return createTextCapture({
          width: TEST_WINDOW.bounds.width,
          height: TEST_WINDOW.bounds.height,
          screenX: TEST_WINDOW.bounds.x,
          screenY: TEST_WINDOW.bounds.y
        });
      }
    },
    moveMouseSmooth(...args) {
      events.push(["move", ...args]);
    },
    mouseClick(...args) {
      events.push(["click", ...args]);
    }
  });
  const steps = JSON.stringify([{
    command: "clickText",
    query: "New Note",
    exact: true,
    button: "right",
    double: true
  }]);

  assert.equal(await run(["sequence", "--window", TEST_WINDOW.id, "--steps-json", steps, "--json"], {
    stdout,
    robot,
    ocrBackend: {
      async recognize() {
        return [{
          text: "New Note",
          confidence: 0.99,
          bounds: { x: 10, y: 20, width: 80, height: 20 }
        }];
      }
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

  assert.equal(result.completed, 1);
  assert.deepEqual(result.results[0], {
    index: 1,
    command: "clickText",
    query: "New Note",
    found: true,
    matchedText: "New Note",
    confidence: 0.99,
    matchType: "exact",
    editDistance: null,
    similarity: null,
    ambiguous: false,
    candidateCount: 1,
    x: 150,
    y: 230,
    button: "right",
    double: true
  });
  assert.deepEqual(events, [
    ["capture", 100, 200, 800, 600],
    ["move", 150, 230],
    ["click", "right", true]
  ]);
});

test("sequence clickText stops the sequence when its text is missing", async () => {
  const stdout = createStream();
  const inputEvents = [];
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
    keyTap(...args) {
      inputEvents.push(args);
    },
    mouseClick(...args) {
      inputEvents.push(args);
    }
  });
  const steps = JSON.stringify([
    { command: "clickText", query: "Missing", exact: true },
    { command: "keyTap", key: "enter" }
  ]);
  const exitCode = await run([
    "sequence",
    "--window",
    TEST_WINDOW.id,
    "--steps-json",
    steps,
    "--json"
  ], {
    stdout,
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

  assert.equal(exitCode, 1);
  assert.equal(result.code, "SEQUENCE_TEXT_NOT_FOUND");
  assert.deepEqual(inputEvents, []);
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

test("Windows activation preserves a maximized window", {
  skip: process.platform !== "win32"
}, async () => {
  const title = `Robot maximized activation ${process.pid}`;
  const form = spawn("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
$form = New-Object System.Windows.Forms.Form
$form.Text = '${title}'
$form.Show()
$form.WindowState = [System.Windows.Forms.FormWindowState]::Maximized
[System.Windows.Forms.Application]::DoEvents()
[Console]::Out.WriteLine("READY")
[Console]::Out.Flush()
[System.Windows.Forms.Application]::Run($form)
`
  ], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  form.stdout.setEncoding("utf8");
  form.stderr.setEncoding("utf8");
  let formOutput = "";
  let formError = "";
  form.stderr.on("data", (chunk) => {
    formError += chunk;
  });

  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out creating maximized test window: ${formError}`));
    }, 5000);
    const onData = (chunk) => {
      formOutput += chunk;
      if (formOutput.includes("READY")) {
        clearTimeout(timeout);
        form.stdout.off("data", onData);
        resolve();
      }
    };
    form.stdout.on("data", onData);
    form.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Maximized test window exited with code ${code}: ${formError}`));
    });
  });

  const host = createWindowsWindowHost();
  try {
    await ready;
    let window;
    for (let attempt = 0; attempt < 20 && !window; attempt += 1) {
      window = (await host.list()).find((entry) => entry.title === title);
      if (!window) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    assert.ok(window, "Maximized test window was not enumerated");

    const isMaximized = () => {
      const result = spawnSync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RobotWindowStateProbe
{
    [DllImport("user32.dll")]
    private static extern bool IsZoomed(IntPtr hWnd);
    public static bool IsMaximized(long value)
    {
        return IsZoomed(new IntPtr(value));
    }
}
'@
[RobotWindowStateProbe]::IsMaximized([long]::Parse('${window.id}'))
`
      ], { encoding: "utf8", windowsHide: true });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim().toLowerCase() === "true";
    };

    assert.equal(isMaximized(), true);
    try {
      await host.activate(window.id);
    } catch (error) {
      if (error.code !== "WINDOW_HOST_REQUEST_FAILED") {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(isMaximized(), true);
  } finally {
    await host.dispose();
    if (!form.killed) {
      form.kill();
    }
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

test("persistent Windows host serves repeated native requests", {
  skip: process.platform !== "win32"
}, async () => {
  const host = createWindowsWindowHost();
  try {
    assert.ok(Array.isArray(await host.list()));
    assert.ok(Array.isArray(await host.list()));
    await assert.rejects(host.activate("0"), (error) => {
      assert.equal(error.code, "WINDOW_HOST_REQUEST_FAILED");
      assert.match(error.message, /Windows rejected the foreground-window request/);
      return true;
    });
  } finally {
    await host.dispose();
  }
});

