import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRobot, createStream, createTextCapture, run } from "../test-support/cli.js";

test("clickWord uses OCR matches and moves the mouse smoothly to the selected text", async () => {
  const stdout = createStream();
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

test("external OCR receives the BMP capture path and reads bounds output", async () => {
  const stdout = createStream();
  const processCalls = [];
  const robot = createRobot({
    screen: {
      capture() {
        return createTextCapture({ width: 100, height: 50 });
      }
    }
  });
  const cwd = path.resolve(path.sep, "workspace");

  const exitCode = await run(["findText", "Target", "--ocr", "./fake-ocr", "--rec-langs", "en-US", "--json"], {
    stdout,
    robot,
    cwd,
    runProcess(command, args, label) {
      processCalls.push({ command, args, label });
      return JSON.stringify([
        {
          text: "Target",
          confidence: 0.9,
          bounds: { x: 10, y: 10, width: 20, height: 10 }
        }
      ]);
    }
  });
  const result = JSON.parse(stdout.read());

  assert.equal(exitCode, 0);
  assert.equal(processCalls.length, 1);
  assert.equal(processCalls[0].command, path.join(cwd, "fake-ocr"));
  assert.equal(processCalls[0].label, "OCR");
  assert.equal(processCalls[0].args[0], "--img");
  assert.match(processCalls[0].args[1], /capture\.bmp$/);
  assert.deepEqual(processCalls[0].args.slice(2), ["--rec-langs", "en-US"]);
  assert.deepEqual(result.bounds, { x: 10, y: 10, width: 20, height: 10 });
});

test("waitForText performs the capture and retry loop in one command", async () => {
  const stdout = createStream();
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

test("findText returns every instance and clickText can select the second one positionally", async () => {
  const findStdout = createStream();
  const clickStdout = createStream();
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
    robot,
    ocrBackend
  });
  const findResult = JSON.parse(findStdout.read());
  const clickExitCode = await run(["clickText", "Message General", "2", "--json"], {
    stdout: clickStdout,
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

test("findText narrows a prefix match to the queried text", async () => {
  const stdout = createStream();
  const robot = createRobot({
    screen: {
      capture() {
        return createTextCapture({ width: 200, height: 100 });
      }
    }
  });

  const exitCode = await run(["findText", "Today", "--json"], {
    stdout,
    robot,
    ocrBackend: {
      async recognize() {
        return [{
          text: "Today afternoon",
          confidence: 0.9,
          bounds: { x: 10, y: 5, width: 150, height: 20 }
        }];
      }
    }
  });
  const result = JSON.parse(stdout.read());

  assert.equal(exitCode, 0);
  assert.equal(result.matchType, "startsWith");
  assert.deepEqual(result.rawBounds, { x: 10, y: 5, width: 150, height: 20 });
  assert.deepEqual(result.bounds, { x: 10, y: 5, width: 50, height: 20 });
  assert.deepEqual(result.screenPoint, { x: 35, y: 15 });
});

test("fuzzy text matching is opt-in and reports one-character OCR recovery", async () => {
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
  const strictStdout = createStream();
  const fuzzyStdout = createStream();

  const strictExitCode = await run(["findText", "Game", "--json"], {
    stdout: strictStdout,
    robot,
    ocrBackend
  });
  const fuzzyExitCode = await run(["findText", "Game", "--fuzzy", "--json"], {
    stdout: fuzzyStdout,
    robot,
    ocrBackend
  });
  const strictResult = JSON.parse(strictStdout.read());
  const fuzzyResult = JSON.parse(fuzzyStdout.read());

  assert.equal(strictExitCode, 0);
  assert.equal(fuzzyExitCode, 0);
  assert.equal(strictResult.found, false);
  assert.equal(strictResult.candidateCount, 0);
  assert.equal(fuzzyResult.found, true);
  assert.equal(fuzzyResult.ambiguous, false);
  assert.equal(fuzzyResult.matchType, "fuzzy");
  assert.equal(fuzzyResult.editDistance, 1);
  assert.equal(fuzzyResult.similarity, 0.75);
});

test("fuzzy matching repairs in-word punctuation but remains strict at its boundaries", async () => {
  const robot = createRobot({
    screen: {
      capture() {
        return createTextCapture({ width: 200, height: 100 });
      }
    }
  });

  async function find(query, recognizedText) {
    const stdout = createStream();
    const exitCode = await run(["findText", query, "--fuzzy", "--json"], {
      stdout,
      robot,
      ocrBackend: {
        async recognize() {
          return [{
            text: recognizedText,
            confidence: 1,
            bounds: { x: 10, y: 10, width: 80, height: 20 }
          }];
        }
      }
    });
    assert.equal(exitCode, 0);
    return JSON.parse(stdout.read());
  }

  const punctuation = await find("World", "Wor-ld");
  const short = await find("New", "Nev");
  const twoEdits = await find("Seed", "Sad");

  assert.equal(punctuation.found, true);
  assert.equal(punctuation.matchType, "fuzzy");
  assert.equal(punctuation.editDistance, 0);
  assert.equal(punctuation.similarity, 1);
  assert.equal(short.found, false);
  assert.equal(twoEdits.found, false);
});

test("strict text matches outrank fuzzy candidates", async () => {
  const stdout = createStream();
  const robot = createRobot({
    screen: {
      capture() {
        return createTextCapture({ width: 200, height: 100 });
      }
    }
  });

  const exitCode = await run(["findText", "Game", "--fuzzy", "--json"], {
    stdout,
    robot,
    ocrBackend: {
      async recognize() {
        return [
          { text: "Gane", confidence: 1, bounds: { x: 10, y: 10, width: 40, height: 20 } },
          { text: "Game", confidence: 0.8, bounds: { x: 100, y: 10, width: 40, height: 20 } }
        ];
      }
    }
  });
  const result = JSON.parse(stdout.read());

  assert.equal(exitCode, 0);
  assert.equal(result.found, true);
  assert.equal(result.matchType, "exact");
  assert.equal(result.candidateCount, 1);
  assert.equal(result.matches[0].text, "Game");
  assert.equal(result.editDistance, null);
  assert.equal(result.similarity, null);
});

test("ambiguous fuzzy matches require an explicit occurrence before clicking", async () => {
  const mouseMoves = [];
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
      return [
        { text: "Gane", confidence: 1, bounds: { x: 10, y: 10, width: 40, height: 20 } },
        { text: "Gape", confidence: 1, bounds: { x: 100, y: 10, width: 40, height: 20 } }
      ];
    }
  };
  const ambiguousStdout = createStream();
  const selectedStdout = createStream();

  const ambiguousExitCode = await run(["clickText", "Game", "--fuzzy", "--json"], {
    stdout: ambiguousStdout,
    robot,
    ocrBackend
  });
  const selectedExitCode = await run(["clickText", "Game", "2", "--fuzzy", "--json"], {
    stdout: selectedStdout,
    robot,
    ocrBackend
  });
  const ambiguousResult = JSON.parse(ambiguousStdout.read());
  const selectedResult = JSON.parse(selectedStdout.read());

  assert.equal(ambiguousExitCode, 0);
  assert.equal(selectedExitCode, 0);
  assert.equal(ambiguousResult.found, false);
  assert.equal(ambiguousResult.ambiguous, true);
  assert.equal(ambiguousResult.candidateCount, 2);
  assert.equal(ambiguousResult.selectedIndex, null);
  assert.equal(selectedResult.found, true);
  assert.equal(selectedResult.ambiguous, false);
  assert.equal(selectedResult.selectedIndex, 2);
  assert.deepEqual(mouseMoves, [{ x: 120, y: 20 }]);
});

test("exact and fuzzy text matching cannot be combined", async () => {
  const stdout = createStream();
  const robot = createRobot({
    screen: {
      capture() {
        return createTextCapture();
      }
    }
  });

  const exitCode = await run(["findText", "Game", "--exact", "--fuzzy", "--json"], {
    stdout,
    robot,
    ocrBackend: {
      async recognize() {
        return [{
          text: "Game",
          confidence: 1,
          bounds: { x: 10, y: 10, width: 40, height: 20 }
        }];
      }
    }
  });
  const result = JSON.parse(stdout.read());

  assert.equal(exitCode, 1);
  assert.equal(result.code, "INVALID_ARGUMENT");
  assert.match(result.message, /--exact and --fuzzy/);
});

test("a quoted query ending in a number remains part of the text", async () => {
  const stdout = createStream();
  const robot = createRobot({
    screen: {
      capture() {
        return createTextCapture({ width: 100, height: 50 });
      }
    }
  });

  const exitCode = await run(["clickText", "Version 2", "--json"], {
    stdout,
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

test("waitForText searches only the selected window", async () => {
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
    screen: {
      capture(...args) {
        events.push(["capture", ...args]);
        return createTextCapture({
          width: 800,
          height: 600,
          screenX: 100,
          screenY: 200
        });
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

  const exitCode = await run(["waitForText", "cycle complete", "--window", "Minecraft", "--timeout", "0", "--json"], {
    stdout,
    robot,
    windowController,
    ocrBackend: {
      async recognize() {
        return [{
          text: "cycle complete",
          confidence: 1,
          bounds: { x: 10, y: 10, width: 100, height: 20 }
        }];
      }
    }
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



test("text retains its OCR capture when requested", async (t) => {
  const stdout = createStream();
  const savedPaths = [];
  const robot = createRobot({
    screen: {
      capture() {
        return createTextCapture({
          onSave(capturePath) {
            savedPaths.push(capturePath);
          }
        });
      }
    }
  });

  const exitCode = await run(["text", "--keep-capture", "--json"], {
    stdout,
    robot,
    ocrBackend: {
      async recognize() {
        return [{ text: "Cycle complete", confidence: 1, bounds: { x: 1, y: 2, width: 30, height: 10 } }];
      }
    }
  });
  const result = JSON.parse(stdout.read());
  const capturePath = result.displays[0].captureImagePath;
  t.after(() => fs.rmSync(path.dirname(capturePath), { recursive: true, force: true }));

  assert.equal(exitCode, 0);
  assert.deepEqual(result.allText, ["Cycle complete"]);
  assert.deepEqual(savedPaths, [capturePath]);
  assert.ok(fs.existsSync(capturePath));
});

test("findText clips a selected window capture to its visible display area", async () => {
  const stdout = createStream();
  const captureCalls = [];
  const window = {
    id: "9001",
    title: "All iCloud",
    process: "Notes",
    processId: 11455,
    bounds: { x: 900, y: 700, width: 200, height: 200 },
    display: "1",
    scale: 1
  };
  const robot = createRobot({
    getDisplays() {
      return [{ id: 1, x: 0, y: 0, width: 1000, height: 800, isMain: true }];
    },
    screen: {
      capture(...args) {
        captureCalls.push(args);
        return createTextCapture({
          width: 100,
          height: 100,
          screenX: 900,
          screenY: 700
        });
      }
    }
  });

  const exitCode = await run([
    "findText",
    "Missing",
    "--exact",
    "--window",
    "Notes",
    "--json"
  ], {
    stdout,
    robot,
    ocrBackend: { async recognize() { return []; } },
    windowController: {
      async resolve(reference) {
        assert.equal(reference, "Notes");
        return window;
      },
      async activate(selected) {
        return selected;
      }
    }
  });
  const result = JSON.parse(stdout.read());

  assert.equal(exitCode, 0);
  assert.equal(result.found, false);
  assert.deepEqual(captureCalls, [[900, 700, 100, 100]]);
  assert.equal(result.capture.width, 100);
  assert.equal(result.capture.height, 100);
});