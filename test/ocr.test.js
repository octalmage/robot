import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPaddleBackend, toArrayBuffer } from "../src/ocr.js";

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
