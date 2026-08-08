import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRobot, createStream, run } from "../test-support/cli.js";

test("findImage resolves the image path and returns screen coordinates", async () => {
  const stdout = createStream();
  const loadCalls = [];
  const robot = createRobot({
    image: {
      load(imagePath) {
        loadCalls.push(imagePath);
        return { width: 16, height: 8 };
      }
    },
    screen: {
      capture(x, y, width, height) {
        assert.equal(x, 100);
        assert.equal(y, 200);
        assert.equal(width, 300);
        assert.equal(height, 400);

        return {
          width: 300,
          height: 400,
          byteWidth: 1200,
          bitsPerPixel: 32,
          bytesPerPixel: 4,
          screenX: 100,
          screenY: 200,
          scaleX: 2,
          scaleY: 2,
          findImage(needle, options) {
            assert.deepEqual(needle, { width: 16, height: 8 });
            assert.deepEqual(options, { tolerance: 0.2 });
            return { x: 24, y: 40 };
          },
          toScreenPoint(point, needle) {
            assert.deepEqual(point, { x: 24, y: 40 });
            assert.deepEqual(needle, { width: 16, height: 8 });
            return { x: 116, y: 222 };
          }
        };
      }
    }
  });

  const cwd = path.resolve(path.sep, "workspace", "robot");
  const exitCode = await run(["findImage", "assets/button.bmp", "--x", "100", "--y", "200", "--width", "300", "--height", "400", "--tolerance", "0.2", "--json"], { stdout, robot, cwd });
  const result = JSON.parse(stdout.read());

  assert.equal(exitCode, 0);
  assert.deepEqual(loadCalls, [path.join(cwd, "assets", "button.bmp")]);
  assert.equal(result.found, true);
  assert.deepEqual(result.screenPoint, { x: 116, y: 222 });
});

test("findImage retries an exact 2x screenshot at Retina scale", async () => {
  const stdout = createStream();
  const searches = [];
  const needle = {
    width: 4,
    height: 4,
    byteWidth: 12,
    bitsPerPixel: 24,
    bytesPerPixel: 3,
    image: Buffer.from(Array.from({ length: 48 }, (_, index) => index))
  };
  const robot = createRobot({
    image: {
      load() {
        return needle;
      }
    },
    screen: {
      capture() {
        return {
          width: 100,
          height: 50,
          byteWidth: 400,
          bitsPerPixel: 32,
          bytesPerPixel: 4,
          screenX: 0,
          screenY: 0,
          scaleX: 1,
          scaleY: 1,
          findImage(candidate, options) {
            searches.push({ candidate, options });
            if (searches.length === 1) {
              assert.equal(candidate, needle);
              assert.deepEqual(options, {});
              return null;
            }

            assert.deepEqual({
              width: candidate.width,
              height: candidate.height,
              byteWidth: candidate.byteWidth,
              bitsPerPixel: candidate.bitsPerPixel,
              bytesPerPixel: candidate.bytesPerPixel,
              image: [...candidate.image]
            }, {
              width: 2,
              height: 2,
              byteWidth: 6,
              bitsPerPixel: 24,
              bytesPerPixel: 3,
              image: [15, 16, 17, 21, 22, 23, 39, 40, 41, 45, 46, 47]
            });
            assert.deepEqual(options, { tolerance: 0.01 });
            return { x: 10, y: 12 };
          },
          toScreenPoint(point, target) {
            assert.deepEqual(point, { x: 10, y: 12 });
            assert.equal(target.width, 2);
            assert.equal(target.height, 2);
            return { x: 11, y: 13 };
          }
        };
      }
    }
  });

  const exitCode = await run(["findImage", "retina.png", "--json"], {
    stdout,
    robot,
    cwd: path.resolve(path.sep, "tmp")
  });
  const result = JSON.parse(stdout.read());

  assert.equal(exitCode, 0);
  assert.equal(searches.length, 2);
  assert.equal(result.found, true);
  assert.deepEqual(result.match, { x: 10, y: 12 });
  assert.deepEqual(result.screenPoint, { x: 11, y: 13 });
  assert.equal(result.tolerance, 0.01);
  assert.equal(result.imageScale, 0.5);
});

test("clickImage reports not-found without failing the process", async () => {
  const stdout = createStream();
  const robot = createRobot({
    screen: {
      capture() {
        return {
          width: 100,
          height: 100,
          byteWidth: 400,
          bitsPerPixel: 32,
          bytesPerPixel: 4,
          screenX: 0,
          screenY: 0,
          scaleX: 1,
          scaleY: 1,
          findImage() {
            return null;
          },
          toScreenPoint() {
            throw new Error("toScreenPoint should not be called when there is no match");
          }
        };
      }
    }
  });

  const exitCode = await run(["clickImage", "button.bmp", "--json"], {
    stdout,
    robot,
    cwd: path.resolve(path.sep, "tmp")
  });
  const result = JSON.parse(stdout.read());

  assert.equal(exitCode, 0);
  assert.equal(result.found, false);
  assert.equal(result.match, null);
  assert.equal(result.screenPoint, null);
});

test("waitForImage loads the target once and retries screen observations locally", async () => {
  const stdout = createStream();
  let captureCalls = 0;
  let loadCalls = 0;
  let clock = 0;
  const needle = { width: 10, height: 6 };
  const robot = createRobot({
    image: {
      load() {
        loadCalls += 1;
        return needle;
      }
    },
    screen: {
      capture() {
        captureCalls += 1;
        const attempt = captureCalls;

        return {
          width: 100,
          height: 50,
          byteWidth: 400,
          bitsPerPixel: 32,
          bytesPerPixel: 4,
          screenX: 0,
          screenY: 0,
          scaleX: 1,
          scaleY: 1,
          findImage() {
            return attempt === 2 ? { x: 20, y: 30 } : null;
          },
          toScreenPoint(point, target) {
            return {
              x: point.x + (target.width / 2),
              y: point.y + (target.height / 2)
            };
          }
        };
      }
    }
  });

  const exitCode = await run(["waitForImage", "button.bmp", "--timeout", "1000", "--json"], {
    stdout,
    robot,
    now: () => clock,
    sleep: async (duration) => {
      clock += duration;
    }
  });
  const result = JSON.parse(stdout.read());

  assert.equal(exitCode, 0);
  assert.equal(loadCalls, 1);
  assert.equal(captureCalls, 2);
  assert.equal(result.found, true);
  assert.deepEqual(result.screenPoint, { x: 25, y: 33 });
  assert.equal(result.attempts, 2);
  assert.equal(result.elapsedMs, 100);
  assert.equal(result.timedOut, false);
});

test("waitForImage stops after its local timeout", async () => {
  const stdout = createStream();
  let captureCalls = 0;
  let clock = 0;
  const robot = createRobot({
    image: {
      load() {
        return { width: 10, height: 6 };
      }
    },
    screen: {
      capture() {
        captureCalls += 1;
        return {
          width: 100,
          height: 50,
          byteWidth: 400,
          bitsPerPixel: 32,
          bytesPerPixel: 4,
          screenX: 0,
          screenY: 0,
          scaleX: 1,
          scaleY: 1,
          findImage() {
            return null;
          }
        };
      }
    }
  });

  const exitCode = await run(["waitForImage", "button.bmp", "--timeout", "200", "--json"], {
    stdout,
    robot,
    now: () => clock,
    sleep: async (duration) => {
      clock += duration;
    }
  });
  const result = JSON.parse(stdout.read());

  assert.equal(exitCode, 0);
  assert.equal(captureCalls, 3);
  assert.equal(result.found, false);
  assert.equal(result.attempts, 3);
  assert.equal(result.elapsedMs, 200);
  assert.equal(result.timedOut, true);
});

test("waitForImage searches only the selected window", async () => {
  const stdout = createStream();
  const events = [];
  const window = {
    id: "4242",
    title: "Minecraft 1.21",
    process: "javaw",
    processId: 1234,
    bounds: { x: 100, y: 200, width: 800, height: 600 },
    display: "\\\\.\\DISPLAY1",
    scale: 1.5
  };
  const robot = createRobot({
    image: {
      load() {
        return { width: 10, height: 6 };
      }
    },
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
          findImage() {
            return { x: 20, y: 30 };
          },
          toScreenPoint() {
            return { x: 125, y: 233 };
          }
        };
      }
    }
  });
  const windowController = {
    async resolve(reference) {
      events.push(["resolve", reference]);
      return window;
    },
    async activate(selected) {
      events.push(["activate", selected.id]);
      return selected;
    }
  };

  const exitCode = await run(["waitForImage", "button.bmp", "--window", "Minecraft", "--timeout", "0", "--json"], {
    stdout,
    robot,
    windowController
  });
  const result = JSON.parse(stdout.read());

  assert.equal(exitCode, 0);
  assert.equal(result.found, true);
  assert.equal(result.timedOut, false);
  assert.deepEqual(events, [
    ["resolve", "Minecraft"],
    ["activate", "4242"],
    ["capture", 100, 200, 800, 600]
  ]);
});

