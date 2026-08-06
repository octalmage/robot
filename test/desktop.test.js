import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRobot, createStream, run } from "../test-support/cli.js";

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

