import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createCli } from "../src/cli.js";

function createStream() {
  let output = "";

  return {
    write(chunk) {
      output += chunk;
    },
    read() {
      return output;
    }
  };
}

async function run(argv, overrides = {}) {
  const cli = createCli(overrides);
  const stdout = overrides.stdout || createStream();
  let exitCode = 0;

  await cli.serve(argv, {
    stdout(chunk) {
      stdout.write(chunk);
    },
    exit(code) {
      exitCode = code;
    }
  });

  return exitCode;
}

function createRobot(overrides) {
  const robot = {
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
          save() {
            return true;
          },
          findImage() {
            return null;
          },
          clickImage() {
            return null;
          },
          toScreenPoint(point) {
            return point;
          }
        };
      }
    },
    image: {
      supportsPNG: true,
      load() {
        return { width: 10, height: 10 };
      }
    },
    moveMouse() {},
    moveMouseSmooth() {},
    mouseClick() {},
    typeString() {},
    typeStringDelayed() {},
    keyTap() {},
    scrollMouse() {},
    getMousePos() {
      return { x: 1, y: 2 };
    },
    getScreenSize() {
      return { width: 1440, height: 900 };
    },
    getPixelColor() {
      return "abcdef";
    }
  };

  return Object.assign(robot, overrides);
}

function createTextCapture(options) {
  const settings = Object.assign({
    width: 100,
    height: 50,
    screenX: 0,
    screenY: 0,
    scaleX: 1,
    scaleY: 1
  }, options);

  return {
    width: settings.width,
    height: settings.height,
    byteWidth: settings.width * 4,
    bitsPerPixel: 32,
    bytesPerPixel: 4,
    screenX: settings.screenX,
    screenY: settings.screenY,
    scaleX: settings.scaleX,
    scaleY: settings.scaleY,
    save(outputPath) {
      if (typeof settings.onSave === "function") {
        settings.onSave(outputPath);
      }

      fs.writeFileSync(outputPath, "raw");
      return true;
    },
    toScreenPoint(point, target) {
      const dimensions = target || { width: 0, height: 0 };

      return {
        x: Math.round(settings.screenX + ((point.x + Math.floor(dimensions.width / 2)) / settings.scaleX)),
        y: Math.round(settings.screenY + ((point.y + Math.floor(dimensions.height / 2)) / settings.scaleY))
      };
    }
  };
}

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

test("moveMouse uses smooth movement internally", async () => {
  const stdout = createStream();
  const stderr = createStream();
  const calls = [];
  const robot = createRobot({
    moveMouseSmooth(x, y) {
      calls.push({ x, y });
    }
  });

  const exitCode = await run(["moveMouse", "450", "890", "--json"], { stdout, stderr, robot });
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
  const stderr = createStream();
  const calls = [];
  const robot = createRobot({
    mouseClick(...args) {
      calls.push(args);
    }
  });

  const exitCode = await run(["click", "--json"], { stdout, stderr, robot });
  const result = JSON.parse(stdout.read());

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [[]]);
  assert.equal(result.button, "left");
  assert.equal(result.double, false);
});

test("click with coordinates moves smoothly before clicking", async () => {
  const stdout = createStream();
  const stderr = createStream();
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

  const exitCode = await run(["click", "10", "20", "--json"], { stdout, stderr, robot });
  const result = JSON.parse(stdout.read());

  assert.equal(exitCode, 0);
  assert.deepEqual(mouseMoves, [{ x: 10, y: 20 }]);
  assert.deepEqual(clickCalls, [[]]);
  assert.equal(result.x, 10);
  assert.equal(result.y, 20);
});

test("types joined text with an optional typing speed", async () => {
  const stdout = createStream();
  const stderr = createStream();
  const calls = [];
  const robot = createRobot({
    typeStringDelayed(text, cpm) {
      calls.push({ text, cpm });
    }
  });

  const exitCode = await run(["type", "hello", "world", "--cpm", "300", "--json"], { stdout, stderr, robot });
  const result = JSON.parse(stdout.read());

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [{ text: "hello world", cpm: 300 }]);
  assert.equal(result.text, "hello world");
  assert.equal(result.cpm, 300);
});

test("types with a reliable default speed", async () => {
  const stdout = createStream();
  const stderr = createStream();
  const calls = [];
  const robot = createRobot({
    typeStringDelayed(text, cpm) {
      calls.push({ text, cpm });
    }
  });

  const exitCode = await run(["type", "hello", "--json"], { stdout, stderr, robot });
  const result = JSON.parse(stdout.read());

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [{ text: "hello", cpm: 12000 }]);
  assert.equal(result.text, "hello");
  assert.equal(result.cpm, 12000);
});

test("captures a screenshot and saves it to the requested output path", async () => {
  const stdout = createStream();
  const stderr = createStream();
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
            fs.mkdirSync(path.dirname(outputPath), { recursive: true });
            fs.writeFileSync(outputPath, "raw");
            return true;
          }
        };
      }
    }
  });

  const cwd = path.join(path.sep, "tmp", "robot-cli-test");
  const exitCode = await run(["screenshot", "10", "20", "30", "40", "--output", "screen.bmp", "--json"], { stdout, stderr, robot, cwd });
  const result = JSON.parse(stdout.read());

  assert.equal(exitCode, 0);
  assert.deepEqual(saveCalls, [path.join(cwd, "screen.bmp")]);
  assert.equal(fs.readFileSync(path.join(cwd, "screen.bmp"), "utf8"), "raw");
  assert.equal(result.output, path.join(cwd, "screen.bmp"));
  assert.equal(result.capture.scaleX, 2);
});

test("findImage resolves the image path and returns screen coordinates", async () => {
  const stdout = createStream();
  const stderr = createStream();
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

  const cwd = path.join(path.sep, "workspace", "robot");
  const exitCode = await run(["findImage", "assets/button.bmp", "--x", "100", "--y", "200", "--width", "300", "--height", "400", "--tolerance", "0.2", "--json"], { stdout, stderr, robot, cwd });
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
    cwd: path.join(path.sep, "tmp")
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
  const stderr = createStream();
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
    stderr,
    robot,
    cwd: path.join(path.sep, "tmp")
  });
  const result = JSON.parse(stdout.read());

  assert.equal(exitCode, 0);
  assert.equal(result.found, false);
  assert.equal(result.match, null);
  assert.equal(result.screenPoint, null);
});

test("clickWord uses OCR matches and moves the mouse smoothly to the selected text", async () => {
  const stdout = createStream();
  const stderr = createStream();
  const savedPaths = [];
  const mouseMoves = [];
  const clickCalls = [];
  const robot = createRobot({
    screen: {
      capture() {
        return {
          width: 200,
          height: 100,
          byteWidth: 800,
          bitsPerPixel: 32,
          bytesPerPixel: 4,
          screenX: 50,
          screenY: 75,
          scaleX: 1,
          scaleY: 1,
          save(outputPath) {
            savedPaths.push(outputPath);
            fs.writeFileSync(outputPath, "raw");
            return true;
          },
          toScreenPoint(point, target) {
            return {
              x: Math.round(point.x + (target.width / 2) + 50),
              y: Math.round(point.y + (target.height / 2) + 75)
            };
          }
        };
      }
    },
    moveMouseSmooth(x, y) {
      mouseMoves.push({ x, y });
    },
    mouseClick(...args) {
      clickCalls.push(args);
    }
  });

  const exitCode = await run(["clickWord", "continue", "--json"], {
    stdout,
    stderr,
    robot,
    ocrBackend: {
      async recognize(image) {
        assert.ok(image instanceof ArrayBuffer);
        return [
          {
            text: "Continue",
            confidence: 1,
            bounds: { x: 40, y: 20, width: 40, height: 20 }
          }
        ];
      }
    }
  });
  const result = JSON.parse(stdout.read());

  assert.equal(exitCode, 0);
  assert.equal(savedPaths.length, 1);
  assert.deepEqual(mouseMoves, [{ x: 110, y: 105 }]);
  assert.deepEqual(clickCalls, [[]]);
  assert.equal(result.found, true);
  assert.equal(result.text, "Continue");
  assert.deepEqual(result.screenPoint, { x: 110, y: 105 });
});

test("findText reads a BMP capture into an ArrayBuffer for OCR", async () => {
  const stdout = createStream();
  const stderr = createStream();
  const savedPaths = [];
  const ocrPaths = [];
  const robot = createRobot({
    screen: {
      capture() {
        return {
          width: 200,
          height: 100,
          byteWidth: 800,
          bitsPerPixel: 32,
          bytesPerPixel: 4,
          screenX: 0,
          screenY: 0,
          scaleX: 1,
          scaleY: 1,
          save(outputPath) {
            savedPaths.push(outputPath);
            fs.writeFileSync(outputPath, "raw");
            return true;
          },
          toScreenPoint(point, target) {
            return {
              x: Math.round(point.x + (target.width / 2)),
              y: Math.round(point.y + (target.height / 2))
            };
          }
        };
      }
    }
  });

  const exitCode = await run(["findText", "Message", "--json"], {
    stdout,
    stderr,
    robot,
    ocrBackend: {
      async recognize(image, options) {
        assert.ok(image instanceof ArrayBuffer);
        assert.equal(image.byteLength, 3);
        ocrPaths.push(options.imagePath);
        return [
          {
            text: "Message @Cal",
            confidence: 1,
            bounds: { x: 20, y: 10, width: 80, height: 10 }
          }
        ];
      }
    }
  });
  const result = JSON.parse(stdout.read());

  assert.equal(exitCode, 0);
  assert.equal(savedPaths.length, 1);
  assert.match(savedPaths[0], /capture\.bmp$/);
  assert.deepEqual(ocrPaths, savedPaths);
  assert.equal(result.found, true);
  assert.equal(result.text, "Message @Cal");
});

test("clickText isolates a small icon-prefixed label inside explicit bounds", async () => {
  const stdout = createStream();
  const captureCalls = [];
  const mouseMoves = [];
  const recognizeOptions = [];
  const robot = createRobot({
    screen: {
      capture(x, y, width, height) {
        captureCalls.push({ x, y, width, height });
        return createTextCapture({ width, height, screenX: x, screenY: y });
      }
    },
    moveMouseSmooth(x, y) {
      mouseMoves.push({ x, y });
    }
  });

  const exitCode = await run([
    "clickText",
    "Today",
    "--x", "650",
    "--y", "200",
    "--width", "200",
    "--height", "100",
    "--confidence", "0.9",
    "--ocr-strategy", "per-box",
    "--json"
  ], {
    stdout,
    robot,
    ocrBackend: {
      async recognize(_image, options) {
        recognizeOptions.push(options);
        return [{
          text: "国 Today",
          confidence: 0.92,
          bounds: { x: 41, y: 48, width: 62, height: 18 }
        }];
      }
    }
  });
  const result = JSON.parse(stdout.read());

  assert.equal(exitCode, 0);
  assert.deepEqual(captureCalls, [{ x: 650, y: 200, width: 200, height: 100 }]);
  assert.equal(recognizeOptions[0].strategy, "per-box");
  assert.equal(result.found, true);
  assert.equal(result.matchType, "contains");
  assert.deepEqual(result.rawBounds, { x: 41, y: 48, width: 62, height: 18 });
  assert.deepEqual(result.screenPoint, { x: 731, y: 257 });
  assert.deepEqual(mouseMoves, [{ x: 731, y: 257 }]);
});

test("clickText scans multiple displays and clicks matches found on a secondary display", async () => {
  const stdout = createStream();
  const stderr = createStream();
  const captureCalls = [];
  const mouseMoves = [];
  const clickCalls = [];
  const displays = [
    { id: 1, x: 0, y: 0, width: 100, height: 50, isMain: true },
    { id: 2, x: 100, y: 0, width: 120, height: 80, isMain: false }
  ];
  const robot = createRobot({
    getDisplays() {
      return displays;
    },
    screen: {
      capture(x, y, width, height) {
        captureCalls.push({ x, y, width, height });
        return createTextCapture({
          width,
          height,
          screenX: x,
          screenY: y
        });
      }
    },
    moveMouseSmooth(x, y) {
      mouseMoves.push({ x, y });
    },
    mouseClick(...args) {
      clickCalls.push(args);
    }
  });
  const ocrResults = [
    [],
    [
      {
        text: "Continue",
        confidence: 1,
        bounds: { x: 12, y: 16, width: 24, height: 16 }
      }
    ]
  ];

  const exitCode = await run(["clickText", "Continue", "--json"], {
    stdout,
    stderr,
    robot,
    ocrBackend: {
      async recognize() {
        return ocrResults.shift();
      }
    }
  });
  const result = JSON.parse(stdout.read());

  assert.equal(exitCode, 0);
  assert.deepEqual(captureCalls, [
    { x: 0, y: 0, width: 100, height: 50 },
    { x: 100, y: 0, width: 120, height: 80 }
  ]);
  assert.deepEqual(mouseMoves, [{ x: 124, y: 24 }]);
  assert.deepEqual(clickCalls, [[]]);
  assert.equal(result.found, true);
  assert.equal(result.text, "Continue");
  assert.deepEqual(result.screenPoint, { x: 124, y: 24 });
});

test("findText keeps explicit bounds instead of scanning every display", async () => {
  const stdout = createStream();
  const stderr = createStream();
  const captureCalls = [];
  let getDisplaysCalls = 0;
  const robot = createRobot({
    getDisplays() {
      getDisplaysCalls += 1;
      return [
        { id: 1, x: 0, y: 0, width: 100, height: 50, isMain: true },
        { id: 2, x: 100, y: 0, width: 100, height: 50, isMain: false }
      ];
    },
    screen: {
      capture(x, y, width, height) {
        captureCalls.push({ x, y, width, height });
        return createTextCapture({
          width,
          height,
          screenX: x,
          screenY: y
        });
      }
    }
  });

  const exitCode = await run(["findText", "Message", "--x", "10", "--y", "20", "--width", "30", "--height", "40", "--json"], {
    stdout,
    stderr,
    robot,
    ocrBackend: {
      async recognize() {
        return [
          {
            text: "Message",
            confidence: 1,
            bounds: { x: 3, y: 4, width: 24, height: 8 }
          }
        ];
      }
    }
  });
  const result = JSON.parse(stdout.read());

  assert.equal(exitCode, 0);
  assert.equal(getDisplaysCalls, 0);
  assert.deepEqual(captureCalls, [{ x: 10, y: 20, width: 30, height: 40 }]);
  assert.equal(result.found, true);
  assert.deepEqual(result.screenPoint, { x: 25, y: 28 });
});

test("findText keeps the no-arg capture fast path when only one display is active", async () => {
  const stdout = createStream();
  const stderr = createStream();
  const captureCalls = [];
  let getDisplaysCalls = 0;
  const robot = createRobot({
    getDisplays() {
      getDisplaysCalls += 1;
      return [{ id: 1, x: 0, y: 0, width: 100, height: 50, isMain: true }];
    },
    screen: {
      capture(...args) {
        captureCalls.push(args);
        return createTextCapture({ width: 100, height: 50 });
      }
    }
  });

  const exitCode = await run(["findText", "Continue", "--json"], {
    stdout,
    stderr,
    robot,
    ocrBackend: {
      async recognize() {
        return [
          {
            text: "Continue",
            confidence: 1,
            bounds: { x: 20, y: 10, width: 20, height: 10 }
          }
        ];
      }
    }
  });

  assert.equal(exitCode, 0);
  assert.equal(getDisplaysCalls, 1);
  assert.deepEqual(captureCalls, [[]]);
});

test("returns Incur command-not-found JSON for invalid commands", async () => {
  const stdout = createStream();
  const exitCode = await run(["dance", "--json"], { stdout });
  const result = JSON.parse(stdout.read());

  assert.equal(exitCode, 1);
  assert.equal(result.code, "COMMAND_NOT_FOUND");
  assert.match(result.message, /dance/);
});

test("moveMouseSmooth is no longer a public CLI command", async () => {
  const stdout = createStream();
  const exitCode = await run(["moveMouseSmooth", "1", "2", "--json"], { stdout });
  const result = JSON.parse(stdout.read());

  assert.equal(exitCode, 1);
  assert.equal(result.code, "COMMAND_NOT_FOUND");
});

test("external OCR override receives the BMP capture path and preserves legacy output", async () => {
  const stdout = createStream();
  const stderr = createStream();
  const processCalls = [];
  const robot = createRobot({
    screen: {
      capture() {
        return createTextCapture({ width: 100, height: 50 });
      }
    }
  });

  const exitCode = await run(["findText", "Legacy", "--ocr", "./fake-ocr", "--rec-langs", "en-US", "--json"], {
    stdout,
    stderr,
    robot,
    cwd: "/workspace",
    runProcess(command, args, label) {
      processCalls.push({ command, args, label });
      return JSON.stringify({
        info: { width: 100, height: 50 },
        observations: [
          {
            text: "Legacy",
            confidence: 0.9,
            quad: {
              topLeft: { x: 0.1, y: 0.2 },
              topRight: { x: 0.3, y: 0.2 },
              bottomLeft: { x: 0.1, y: 0.4 },
              bottomRight: { x: 0.3, y: 0.4 }
            }
          }
        ]
      });
    }
  });
  const result = JSON.parse(stdout.read());

  assert.equal(exitCode, 0);
  assert.equal(processCalls.length, 1);
  assert.equal(processCalls[0].command, path.join("/workspace", "fake-ocr"));
  assert.equal(processCalls[0].label, "OCR");
  assert.equal(processCalls[0].args[0], "--img");
  assert.match(processCalls[0].args[1], /capture\.bmp$/);
  assert.deepEqual(processCalls[0].args.slice(2), ["--rec-langs", "en-US"]);
  assert.deepEqual(result.bounds, { x: 10, y: 10, width: 20, height: 10 });
});

test("openApp delegates an arbitrary application name to the platform", async () => {
  const stdout = createStream();
  const stderr = createStream();
  const processCalls = [];

  const exitCode = await run(["openApp", "Example", "App", "--json"], {
    stdout,
    stderr,
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
  const stderr = createStream();
  const processCalls = [];

  const exitCode = await run(["activateApp", "Example", "App", "--json"], {
    stdout,
    stderr,
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

test("waitForText performs the capture and retry loop in one command", async () => {
  const stdout = createStream();
  const stderr = createStream();
  let captureCalls = 0;
  let ocrCalls = 0;
  let clock = 0;
  const robot = createRobot({
    screen: {
      capture() {
        captureCalls += 1;
        return createTextCapture({ width: 100, height: 50 });
      }
    }
  });

  const exitCode = await run(["waitForText", "Ready", "--timeout", "1000", "--json"], {
    stdout,
    stderr,
    robot,
    ocrBackend: {
      async recognize() {
        ocrCalls += 1;
        return ocrCalls === 1
          ? []
          : [{ text: "Ready", confidence: 0.95, bounds: { x: 10, y: 10, width: 30, height: 10 } }];
      }
    },
    now: () => clock,
    sleep: async (duration) => {
      clock += duration;
    }
  });
  const result = JSON.parse(stdout.read());

  assert.equal(exitCode, 0);
  assert.equal(captureCalls, 2);
  assert.equal(ocrCalls, 2);
  assert.equal(result.found, true);
  assert.equal(result.attempts, 2);
  assert.equal(result.elapsedMs, 100);
  assert.equal(result.timedOut, false);
});

test("waitForImage loads the target once and retries screen observations locally", async () => {
  const stdout = createStream();
  const stderr = createStream();
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
    stderr,
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
  const stderr = createStream();
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
    stderr,
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

test("findText returns every instance and clickText can select the second one positionally", async () => {
  const findStdout = createStream();
  const findStderr = createStream();
  const clickStdout = createStream();
  const clickStderr = createStream();
  const mouseMoves = [];
  let ocrCalls = 0;
  const robot = createRobot({
    screen: {
      capture() {
        return createTextCapture({ width: 200, height: 100 });
      }
    },
    moveMouseSmooth(x, y) {
      mouseMoves.push({ x, y });
    }
  });
  const ocrBackend = {
    async recognize() {
      ocrCalls += 1;
      const offset = ocrCalls === 1 ? 0 : 20;

      return [
        {
          text: "Message General",
          confidence: 0.98,
          bounds: { x: 10 + offset, y: 10, width: 80, height: 20 }
        },
        {
          text: "Message General",
          confidence: 0.97,
          bounds: { x: 100 + offset, y: 60, width: 80, height: 20 }
        }
      ];
    }
  };

  const findExitCode = await run(["findText", "Message General", "--json"], {
    stdout: findStdout,
    stderr: findStderr,
    robot,
    ocrBackend
  });
  const findResult = JSON.parse(findStdout.read());
  const clickExitCode = await run(["clickText", "Message General", "2", "--json"], {
    stdout: clickStdout,
    stderr: clickStderr,
    robot,
    ocrBackend
  });
  const clickResult = JSON.parse(clickStdout.read());

  assert.equal(findExitCode, 0);
  assert.equal(clickExitCode, 0);
  assert.equal(ocrCalls, 2);
  assert.equal(findResult.candidateCount, 2);
  assert.deepEqual(findResult.matches.map((match) => match.index), [1, 2]);
  assert.deepEqual(findResult.matches.map((match) => match.screenPoint), [
    { x: 50, y: 20 },
    { x: 140, y: 70 }
  ]);
  assert.equal(clickResult.query, "Message General");
  assert.equal(clickResult.selectedIndex, 2);
  assert.equal(clickResult.matches.length, 2);
  assert.deepEqual(clickResult.screenPoint, { x: 160, y: 70 });
  assert.deepEqual(mouseMoves, [{ x: 160, y: 70 }]);
});

test("a quoted query ending in a number remains part of the text", async () => {
  const stdout = createStream();
  const stderr = createStream();
  const robot = createRobot({
    screen: {
      capture() {
        return createTextCapture({ width: 100, height: 50 });
      }
    }
  });

  const exitCode = await run(["clickText", "Version 2", "--json"], {
    stdout,
    stderr,
    robot,
    ocrBackend: {
      async recognize() {
        return [
          {
            text: "Version 2",
            confidence: 1,
            bounds: { x: 10, y: 10, width: 40, height: 10 }
          }
        ];
      }
    }
  });
  const result = JSON.parse(stdout.read());

  assert.equal(exitCode, 0);
  assert.equal(result.query, "Version 2");
  assert.equal(result.selectedIndex, 1);
});

