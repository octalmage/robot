import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createPaddleBackend, createRapidOcrBackend, toArrayBuffer } from "../src/ocr.js";

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

test("Paddle OCR lazily downloads, verifies, and reuses cached model assets", async (t) => {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "robot-model-cache-"));
  const cacheDirectory = path.join(tempDirectory, "cache");
  const sourceAssets = {
    detection: Buffer.from([1, 2, 3]),
    recognition: Buffer.from([4, 5, 6, 7]),
    charactersDictionary: Buffer.from("a\nb\n")
  };
  const modelAssets = Object.fromEntries(Object.entries(sourceAssets).map(([key, buffer]) => [
    key,
    {
      file: `${key}.model`,
      url: `https://models.example/${key}.model`,
      size: buffer.byteLength,
      sha256: sha256(buffer)
    }
  ]));
  const services = [];
  const fetchCalls = [];

  class FakePaddleOcrService {
    constructor(options) {
      this.options = options;
      this.initializeCalls = 0;
      this.recognizeCalls = [];
      this.destroyCalls = 0;
      services.push(this);
    }

    async initialize() {
      this.initializeCalls += 1;
    }

    async recognize(image, options) {
      this.recognizeCalls.push({ image, options });
      return {
        results: [{
          text: "Today",
          confidence: 0.95,
          box: { x: 10, y: 20, width: 40, height: 16 }
        }]
      };
    }

    async destroy() {
      this.destroyCalls += 1;
    }
  }

  const loadPaddle = async () => ({ PaddleOcrService: FakePaddleOcrService });
  const fetchResource = async (url) => {
    fetchCalls.push(url);
    const key = path.basename(new URL(url).pathname, ".model");
    return new Response(sourceAssets[key]);
  };
  const createBackend = (fetchOverride = fetchResource) => createPaddleBackend(
    { strategy: "per-box", minimumConfidence: 0.2 },
    { cacheDirectory, modelAssets, fetchResource: fetchOverride, loadPaddle }
  );
  const input = new Uint8Array([9, 8, 7]).buffer;

  t.after(() => fs.rmSync(tempDirectory, { recursive: true, force: true }));
  assert.equal(fs.existsSync(cacheDirectory), false);

  const firstBackend = createBackend();
  assert.equal(firstBackend.model, "tiny");
  assert.equal(fetchCalls.length, 0);
  const firstItems = await firstBackend.recognize(input);

  assert.deepEqual(firstItems, [{
    text: "Today",
    confidence: 0.95,
    bounds: { x: 10, y: 20, width: 40, height: 16 }
  }]);
  assert.deepEqual(fetchCalls.sort(), Object.values(modelAssets).map((entry) => entry.url).sort());
  assert.equal(services.length, 1);
  assert.deepEqual(services[0].options.recognition, {
    strategy: "per-box",
    minimumConfidence: 0.2
  });
  assert.equal(services[0].initializeCalls, 1);
  assert.equal(services[0].recognizeCalls[0].options.strategy, "per-box");

  for (const [key, entry] of Object.entries(modelAssets)) {
    const cached = fs.readFileSync(path.join(cacheDirectory, entry.file));
    assert.deepEqual(cached, sourceAssets[key]);
    assert.equal(services[0].options.model[key], path.join(cacheDirectory, entry.file));
  }

  await firstBackend.destroy();
  assert.equal(services[0].destroyCalls, 1);

  const cachedBackend = createBackend(async () => {
    throw new Error("valid cached assets must not be downloaded again");
  });
  await cachedBackend.recognize(input);
  await cachedBackend.destroy();
  assert.equal(services.length, 2);

  fs.writeFileSync(
    path.join(cacheDirectory, modelAssets.detection.file),
    Buffer.alloc(sourceAssets.detection.byteLength)
  );
  const repairCalls = [];
  const repairedBackend = createBackend(async (url) => {
    repairCalls.push(url);
    return new Response(sourceAssets.detection);
  });

  await repairedBackend.recognize(input);
  await repairedBackend.destroy();
  assert.deepEqual(repairCalls, [modelAssets.detection.url]);
  assert.deepEqual(
    fs.readFileSync(path.join(cacheDirectory, modelAssets.detection.file)),
    sourceAssets.detection
  );
});

test("Paddle OCR selects and caches the requested named model", async (t) => {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "robot-small-model-"));
  const cacheDirectory = path.join(tempDirectory, "cache");
  const sourceAssets = {
    detection: Buffer.from([11, 12]),
    recognition: Buffer.from([21, 22, 23]),
    charactersDictionary: Buffer.from("small\nmodel\n")
  };
  const smallAssets = Object.fromEntries(Object.entries(sourceAssets).map(([key, buffer]) => [
    key,
    {
      file: `small-${key}.model`,
      url: `https://models.example/small-${key}.model`,
      size: buffer.byteLength,
      sha256: sha256(buffer)
    }
  ]));
  const sourceByUrl = new Map(Object.entries(smallAssets).map(([key, entry]) => [
    entry.url,
    sourceAssets[key]
  ]));
  const fetchCalls = [];
  let serviceOptions;
  let destroyCalls = 0;

  class FakePaddleOcrService {
    constructor(options) {
      serviceOptions = options;
    }

    async initialize() {}

    async recognize() {
      return { results: [] };
    }

    async destroy() {
      destroyCalls += 1;
    }
  }

  const backend = createPaddleBackend(
    { model: "small" },
    {
      cacheDirectory,
      modelAssetsByName: { small: smallAssets },
      async fetchResource(url) {
        fetchCalls.push(url);
        return new Response(sourceByUrl.get(url));
      },
      async loadPaddle() {
        return { PaddleOcrService: FakePaddleOcrService };
      }
    }
  );

  t.after(() => fs.rmSync(tempDirectory, { recursive: true, force: true }));
  assert.equal(backend.model, "small");
  await backend.recognize(new ArrayBuffer(1));
  await backend.destroy();

  assert.deepEqual(fetchCalls.sort(), Object.values(smallAssets).map((entry) => entry.url).sort());
  assert.deepEqual(serviceOptions.model, Object.fromEntries(Object.entries(smallAssets).map(([key, entry]) => [
    key,
    path.join(cacheDirectory, entry.file)
  ])));
  assert.equal(destroyCalls, 1);
});

test("toArrayBuffer preserves only the selected Buffer view", () => {
  const source = Buffer.from([1, 2, 3, 4]);
  const selected = source.subarray(1, 3);

  assert.deepEqual(new Uint8Array(toArrayBuffer(selected)), new Uint8Array([2, 3]));
});

function createFakeRapidWorker(onRequest, options = {}) {
  const worker = new EventEmitter();
  worker.stdin = new PassThrough();
  worker.stdout = new PassThrough();
  worker.stderr = new PassThrough();
  worker.killCalls = 0;
  let buffered = "";
  let closed = false;

  function close(code, signal) {
    if (!closed) {
      closed = true;
      queueMicrotask(() => worker.emit("close", code, signal));
    }
  }

  worker.kill = () => {
    worker.killCalls += 1;
    close(null, "SIGTERM");
    return true;
  };
  worker.stdin.on("data", (chunk) => {
    buffered += chunk.toString();
    let newline = buffered.indexOf("\n");
    while (newline !== -1) {
      const serialized = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (serialized) {
        onRequest(JSON.parse(serialized), worker);
      }
      newline = buffered.indexOf("\n");
    }
  });
  worker.stdin.on("finish", () => close(0, null));

  queueMicrotask(() => {
    if (options.error) {
      worker.emit("error", options.error);
      close(null, null);
    } else {
      worker.stdout.write(`${JSON.stringify({ type: "ready" })}\n`);
    }
  });
  return worker;
}

test("RapidOCR reuses one locked worker and returns normalized line results", async () => {
  const spawnCalls = [];
  const requests = [];
  let worker;
  const backend = createRapidOcrBackend(
    { command: "custom-uv", workerPath: "/opt/robot/rapidocr-worker.py" },
    {
      spawnProcess(command, args, options) {
        spawnCalls.push({ command, args, options });
        worker = createFakeRapidWorker((request, activeWorker) => {
          requests.push(request);
          activeWorker.stdout.write(`${JSON.stringify({
            id: request.id,
            items: [{
              text: `Line ${request.id}`,
              confidence: 0.95,
              bounds: { x: 10, y: 20, width: 100, height: 24 }
            }]
          })}\n`);
        });
        return worker;
      }
    }
  );

  assert.equal(backend.name, "rapidocr");
  assert.equal(backend.model, "small");
  assert.equal(backend.strategy, "per-line");
  assert.deepEqual(
    await backend.recognize(new ArrayBuffer(1), { imagePath: "/tmp/first.bmp" }),
    [{ text: "Line 1", confidence: 0.95, bounds: { x: 10, y: 20, width: 100, height: 24 } }]
  );
  assert.deepEqual(
    await backend.recognize(new ArrayBuffer(1), { imagePath: "/tmp/second.bmp" }),
    [{ text: "Line 2", confidence: 0.95, bounds: { x: 10, y: 20, width: 100, height: 24 } }]
  );

  assert.deepEqual(spawnCalls, [{
    command: "custom-uv",
    args: ["run", "--quiet", "--script", "/opt/robot/rapidocr-worker.py"],
    options: { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
  }]);
  assert.deepEqual(requests, [
    { id: 1, imagePath: "/tmp/first.bmp" },
    { id: 2, imagePath: "/tmp/second.bmp" }
  ]);

  await backend.destroy();
  assert.equal(worker.killCalls, 0);
  await assert.rejects(
    backend.recognize(new ArrayBuffer(1), { imagePath: "/tmp/third.bmp" }),
    (error) => error.code === "OCR_BACKEND_DISPOSED"
  );
});

test("RapidOCR reports actionable guidance when uv is unavailable", async () => {
  const spawnError = new Error("spawn uv ENOENT");
  spawnError.code = "ENOENT";
  const backend = createRapidOcrBackend({}, {
    spawnProcess() {
      return createFakeRapidWorker(() => {}, { error: spawnError });
    }
  });

  await assert.rejects(
    backend.recognize(new ArrayBuffer(1), { imagePath: "/tmp/capture.bmp" }),
    (error) => {
      assert.equal(error.code, "OCR_RAPIDOCR_UNAVAILABLE");
      assert.match(error.message, /requires uv on PATH/);
      assert.match(error.message, /docs\.astral\.sh/);
      return true;
    }
  );
  await backend.destroy();
});
