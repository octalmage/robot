import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODEL_CACHE_DIRECTORY = path.join(os.homedir(), ".cache", "ppu-paddle-ocr");
const MODEL_REPOSITORY = "PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models";
const MODEL_REVISION = "9027d49d3764d465c3d7c4e8506910fb8d9c1498";
const MODEL_BASE_URL = `https://media.githubusercontent.com/media/${MODEL_REPOSITORY}/${MODEL_REVISION}`;
const DICTIONARY_BASE_URL = `https://raw.githubusercontent.com/${MODEL_REPOSITORY}/${MODEL_REVISION}`;
const RAPIDOCR_WORKER_PATH = fileURLToPath(new URL("./rapidocr-worker.py", import.meta.url));
const MODEL_ASSETS = {
  tiny: {
    detection: {
      file: "PP-OCRv6_tiny_det.ort",
      url: `${MODEL_BASE_URL}/detection/ort/PP-OCRv6_tiny_det.ort`,
      size: 1882568,
      sha256: "2816e82d26a09d6af722492f80f3059d458377c084eca88f34d84ddf9b385580"
    },
    recognition: {
      file: "PP-OCRv6_tiny_rec.ort",
      url: `${MODEL_BASE_URL}/recognition/ort/PP-OCRv6_tiny_rec.ort`,
      size: 4530048,
      sha256: "efc46adf1bde1e05b58748268abb0e71791bfa8616c435676bbca13d1ea47767"
    },
    charactersDictionary: {
      file: "ppocrv6_tiny_dict.txt",
      url: `${DICTIONARY_BASE_URL}/recognition/ppocrv6_tiny_dict.txt`,
      size: 27157,
      sha256: "2f3717bbd530b681b6db3be35cc485e8a41a932b9558b833986bf0894eb21f2d"
    }
  },
  small: {
    detection: {
      file: "PP-OCRv6_small_det.ort",
      url: `${MODEL_BASE_URL}/detection/ort/PP-OCRv6_small_det.ort`,
      size: 9982352,
      sha256: "c21be8d8268f0f45e2693b1d52432a290a56d008f6c1ff28b4baa7c35bab250e"
    },
    recognition: {
      file: "PP-OCRv6_small_rec.ort",
      url: `${MODEL_BASE_URL}/recognition/ort/PP-OCRv6_small_rec.ort`,
      size: 21290816,
      sha256: "40bccd9fa3ae2d14d724bf9d020c8f0edfc801489477b92f7449162a538366df"
    },
    charactersDictionary: {
      file: "ppocrv6_dict.txt",
      url: `${DICTIONARY_BASE_URL}/recognition/ppocrv6_dict.txt`,
      size: 74948,
      sha256: "41557512862dfe31970cf22407742b629725461dd84c0d8771bde9c87c2202c8"
    }
  }
};
const DEFAULT_OCR_MODEL = "tiny";
const DEFAULT_OCR_STRATEGY = "per-box";

/**
 * @typedef {{ x: number, y: number, width: number, height: number }} OcrBounds
 * @typedef {{ text: string, confidence: number, bounds: OcrBounds }} OcrItem
 * @typedef {{ name: string, recognize(image: ArrayBuffer, options?: object): Promise<OcrItem[]>, destroy?(): Promise<void> }} OcrBackend
 */

function createOcrError(message, code) {
  const error = new Error(message);
  error.code = code || "OCR_ERROR";
  return error;
}

export function toArrayBuffer(buffer) {
  const { byteOffset, byteLength } = buffer;
  const arrayBuffer = buffer.buffer;
  if (byteOffset === 0 && byteLength === arrayBuffer.byteLength) {
    return arrayBuffer;
  }
  return arrayBuffer.slice(byteOffset, byteOffset + byteLength);
}

async function modelFileIsValid(assetPath, entry) {
  let stats;

  try {
    stats = await fs.promises.stat(assetPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }

  if (!stats.isFile() || stats.size !== entry.size) {
    return false;
  }

  const checksum = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(assetPath)) {
    checksum.update(chunk);
  }

  return checksum.digest("hex") === entry.sha256;
}

async function downloadModelAsset(entry, cacheDirectory, fetchResource) {
  const cachePath = path.join(cacheDirectory, entry.file);

  try {
    const response = await fetchResource(entry.url, {
      signal: AbortSignal.timeout(60000)
    });

    if (!response?.ok) {
      throw createOcrError(
        `Could not download OCR model ${entry.file}: HTTP ${response?.status ?? "unknown"}.`,
        "OCR_MODEL_DOWNLOAD_FAILED"
      );
    }

    const contents = Buffer.from(await response.arrayBuffer());
    const checksum = crypto.createHash("sha256").update(contents).digest("hex");
    if (contents.byteLength !== entry.size || checksum !== entry.sha256) {
      throw createOcrError(
        `Downloaded OCR model ${entry.file} failed size or checksum verification.`,
        "OCR_MODEL_INVALID"
      );
    }

    await fs.promises.mkdir(cacheDirectory, { recursive: true });
    await fs.promises.writeFile(cachePath, contents);
    return cachePath;
  } catch (error) {
    if (error?.code?.startsWith("OCR_")) {
      throw error;
    }
    throw createOcrError(
      `Could not download OCR model ${entry.file}: ${error.message}`,
      "OCR_MODEL_DOWNLOAD_FAILED"
    );
  }
}

async function resolveModelAssets(dependencies) {
  const entries = Object.entries(dependencies.modelAssets);
  const resolved = await Promise.all(entries.map(async ([key, entry]) => {
    const cachePath = path.join(dependencies.cacheDirectory, entry.file);
    if (await modelFileIsValid(cachePath, entry)) {
      return [key, cachePath];
    }
    return [key, await downloadModelAsset(entry, dependencies.cacheDirectory, dependencies.fetchResource)];
  }));

  return Object.fromEntries(resolved);
}

function normalizeBounds(bounds) {
  if (!bounds) {
    return null;
  }

  const normalized = {
    x: Number(bounds.x),
    y: Number(bounds.y),
    width: Number(bounds.width),
    height: Number(bounds.height)
  };

  if (
    !Number.isFinite(normalized.x) ||
    !Number.isFinite(normalized.y) ||
    !Number.isFinite(normalized.width) ||
    !Number.isFinite(normalized.height) ||
    normalized.width <= 0 ||
    normalized.height <= 0
  ) {
    return null;
  }

  return normalized;
}

function normalizeOcrItems(items) {
  if (!Array.isArray(items)) {
    throw createOcrError("OCR backend did not return a list of text items.", "OCR_OUTPUT_INVALID");
  }

  const normalized = [];
  for (const item of items) {
    if (!item || typeof item.text !== "string" || item.text.length === 0) {
      continue;
    }

    const bounds = normalizeBounds(item.bounds) || normalizeBounds(item.box);
    if (!bounds) {
      continue;
    }

    const confidence = Number(item.confidence);
    normalized.push({
      text: item.text,
      confidence: Number.isFinite(confidence) ? confidence : 0,
      bounds
    });
  }

  return normalized;
}

export function createPaddleBackend(settings = {}, dependencies = {}) {
  const strategy = settings.strategy ?? DEFAULT_OCR_STRATEGY;
  const modelName = settings.model ?? DEFAULT_OCR_MODEL;
  const recognition = { strategy };
  const modelAssets = dependencies.modelAssets
    ?? (dependencies.modelAssetsByName ?? MODEL_ASSETS)[modelName];
  if (!modelAssets) {
    throw createOcrError(`Unsupported Paddle OCR model: ${modelName}.`, "OCR_MODEL_UNSUPPORTED");
  }
  const resolvedDependencies = {
    cacheDirectory: dependencies.cacheDirectory ?? MODEL_CACHE_DIRECTORY,
    modelAssets,
    fetchResource: dependencies.fetchResource ?? globalThis.fetch,
    loadPaddle: dependencies.loadPaddle ?? (() => import("ppu-paddle-ocr"))
  };
  let servicePromise = null;
  let activeService = null;

  if (Number.isFinite(settings.minimumConfidence)) {
    recognition.minimumConfidence = settings.minimumConfidence;
  }

  async function initialize() {
    let service;

    try {
      const model = await resolveModelAssets(resolvedDependencies);
      const { PaddleOcrService } = await resolvedDependencies.loadPaddle();
      service = new PaddleOcrService({ model, recognition });
      await service.initialize();
      activeService = service;
      return service;
    } catch (error) {
      if (service) {
        await service.destroy();
      }
      if (error?.code?.startsWith("OCR_")) {
        throw error;
      }
      throw createOcrError(`Paddle OCR initialization failed: ${error.message}`, "OCR_INITIALIZATION_FAILED");
    }
  }

  return {
    name: "paddle",
    model: modelName,
    strategy,
    async recognize(image, options = {}) {
      if (!(image instanceof ArrayBuffer)) {
        throw createOcrError("Paddle OCR expects captured image data as an ArrayBuffer.", "OCR_INPUT_INVALID");
      }

      if (!servicePromise) {
        servicePromise = initialize();
      }

      const service = await servicePromise;
      const result = await service.recognize(image, {
        flatten: true,
        noCache: true,
        strategy: options.strategy ?? strategy
      });
      return normalizeOcrItems(result?.results);
    },
    async destroy() {
      if (!activeService && servicePromise) {
        await servicePromise.catch(() => undefined);
      }

      const service = activeService;
      activeService = null;
      servicePromise = null;

      if (service) {
        await service.destroy();
      }
    }
  };
}

export function createRapidOcrBackend(settings = {}, dependencies = {}) {
  const command = settings.command || "uv";
  const workerPath = settings.workerPath || RAPIDOCR_WORKER_PATH;
  const spawnProcess = dependencies.spawnProcess || spawn;
  const pending = new Map();
  let child = null;
  let lineReader = null;
  let startPromise = null;
  let resolveReady;
  let rejectReady;
  let readySettled = false;
  let exitPromise = null;
  let resolveExit;
  let nextRequestId = 1;
  let stderr = "";
  let stopping = false;
  let destroyed = false;

  function appendStderr(chunk) {
    stderr = `${stderr}${chunk}`.slice(-8192);
  }

  function rejectPending(error) {
    for (const request of pending.values()) {
      request.reject(error);
    }
    pending.clear();
  }

  function fail(error) {
    if (!readySettled) {
      readySettled = true;
      rejectReady(error);
    }
    rejectPending(error);
  }

  function protocolError(message) {
    return createOcrError(`RapidOCR worker protocol error: ${message}`, "OCR_RAPIDOCR_PROTOCOL");
  }

  function handleLine(serialized) {
    let message;
    try {
      message = JSON.parse(serialized);
    } catch {
      const error = protocolError("received invalid JSON.");
      fail(error);
      child?.kill();
      return;
    }

    if (message?.type === "ready") {
      if (!readySettled) {
        readySettled = true;
        resolveReady();
      }
      return;
    }

    const request = pending.get(message?.id);
    if (!request) {
      const error = protocolError(`received an unknown request ID: ${JSON.stringify(message?.id)}.`);
      fail(error);
      child?.kill();
      return;
    }
    pending.delete(message.id);

    if (message.error) {
      request.reject(createOcrError(
        `RapidOCR failed: ${message.error.message || "unknown worker error"}`,
        message.error.code || "OCR_RAPIDOCR_FAILED"
      ));
      return;
    }

    try {
      request.resolve(normalizeOcrItems(message.items));
    } catch (error) {
      request.reject(error);
    }
  }

  function handleClose(code, signal) {
    child = null;
    lineReader?.close();
    lineReader = null;
    resolveExit?.();

    if (stopping) {
      return;
    }

    const details = stderr.trim();
    const reason = signal
      ? `signal ${signal}`
      : `code ${code ?? "unknown"}`;
    fail(createOcrError(
      `RapidOCR worker exited with ${reason}${details ? `: ${details}` : "."}`,
      "OCR_RAPIDOCR_EXITED"
    ));
  }

  function start() {
    if (startPromise) {
      return startPromise;
    }

    startPromise = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    try {
      child = spawnProcess(
        command,
        ["run", "--quiet", "--script", workerPath],
        { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
      );
      exitPromise = new Promise((resolve) => {
        resolveExit = resolve;
      });
      lineReader = createInterface({ input: child.stdout, crlfDelay: Infinity });
      lineReader.on("line", handleLine);
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", appendStderr);
      child.once("error", (error) => {
        const unavailable = error?.code === "ENOENT";
        fail(createOcrError(
          unavailable
            ? `RapidOCR requires uv on PATH. Install uv from https://docs.astral.sh/uv/getting-started/installation/.`
            : `Could not start RapidOCR worker: ${error.message}`,
          unavailable ? "OCR_RAPIDOCR_UNAVAILABLE" : "OCR_RAPIDOCR_START_FAILED"
        ));
      });
      child.once("close", handleClose);
    } catch (error) {
      fail(createOcrError(
        `Could not start RapidOCR worker: ${error.message}`,
        "OCR_RAPIDOCR_START_FAILED"
      ));
    }

    return startPromise;
  }

  return {
    name: "rapidocr",
    model: "small",
    strategy: "per-line",
    async recognize(image, options = {}) {
      if (!(image instanceof ArrayBuffer)) {
        throw createOcrError("RapidOCR expects captured image data as an ArrayBuffer.", "OCR_INPUT_INVALID");
      }
      if (!options.imagePath) {
        throw createOcrError("RapidOCR requires a capture path.", "OCR_INPUT_INVALID");
      }
      if (destroyed) {
        throw createOcrError("RapidOCR backend has been disposed.", "OCR_BACKEND_DISPOSED");
      }

      await start();
      const worker = child;
      if (!worker?.stdin?.writable) {
        throw createOcrError("RapidOCR worker is not available.", "OCR_RAPIDOCR_EXITED");
      }

      const id = nextRequestId;
      nextRequestId += 1;
      const response = new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      const serialized = `${JSON.stringify({ id, imagePath: options.imagePath })}\n`;

      try {
        worker.stdin.write(serialized, "utf8", (error) => {
          const request = pending.get(id);
          if (error && request) {
            pending.delete(id);
            request.reject(createOcrError(
              `Could not send image to RapidOCR worker: ${error.message}`,
              "OCR_RAPIDOCR_WRITE_FAILED"
            ));
          }
        });
      } catch (error) {
        pending.delete(id);
        throw createOcrError(
          `Could not send image to RapidOCR worker: ${error.message}`,
          "OCR_RAPIDOCR_WRITE_FAILED"
        );
      }

      return response;
    },
    async destroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      stopping = true;
      rejectPending(createOcrError("RapidOCR backend has been disposed.", "OCR_BACKEND_DISPOSED"));

      const worker = child;
      const exited = exitPromise;
      if (!worker) {
        return;
      }

      if (worker.stdin.writable) {
        worker.stdin.end();
      }

      let timeout;
      await Promise.race([
        exited,
        new Promise((resolve) => {
          timeout = setTimeout(() => {
            worker.kill();
            resolve();
          }, 2000);
        })
      ]);
      clearTimeout(timeout);
    }
  };
}

export function createExternalBackend(binary, runner) {
  return {
    name: "external",
    async recognize(image, options) {
      const settings = options ?? {};

      if (!(image instanceof ArrayBuffer)) {
        throw createOcrError("External OCR expects captured image data as an ArrayBuffer.", "OCR_INPUT_INVALID");
      }

      if (!settings.imagePath) {
        throw createOcrError("External OCR requires a capture path.", "OCR_INPUT_INVALID");
      }

      const args = ["--img", settings.imagePath];

      if (settings.recLangs) {
        args.push("--rec-langs", String(settings.recLangs));
      }

      const stdout = await runner(binary, args, "OCR");
      let payload;

      try {
        payload = typeof stdout === "string" ? JSON.parse(stdout) : stdout;
      } catch {
        throw createOcrError("OCR output was not valid JSON.", "OCR_OUTPUT_INVALID");
      }

      return normalizeOcrItems(payload);
    }
  };
}

