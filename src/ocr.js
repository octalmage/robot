import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const MODEL_CACHE_DIRECTORY = path.join(os.homedir(), ".cache", "ppu-paddle-ocr");
const MODEL_BASE_URL = "https://media.githubusercontent.com/media/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/main";
const DICTIONARY_BASE_URL = "https://raw.githubusercontent.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/main";
const MODEL_ASSETS = {
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
};
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
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
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
  const tempPath = path.join(
    cacheDirectory,
    `.${entry.file}.${process.pid}.${crypto.randomUUID()}.tmp`
  );

  await fs.promises.mkdir(cacheDirectory, { recursive: true });

  try {
    const response = await fetchResource(entry.url, {
      signal: AbortSignal.timeout(60000)
    });

    if (!response?.ok || !response.body) {
      throw createOcrError(
        `Could not download OCR model ${entry.file}: HTTP ${response?.status ?? "unknown"}.`,
        "OCR_MODEL_DOWNLOAD_FAILED"
      );
    }

    await pipeline(
      Readable.fromWeb(response.body),
      fs.createWriteStream(tempPath, { flags: "wx" })
    );

    if (!(await modelFileIsValid(tempPath, entry))) {
      throw createOcrError(
        `Downloaded OCR model ${entry.file} failed size or checksum verification.`,
        "OCR_MODEL_INVALID"
      );
    }

    if (await modelFileIsValid(cachePath, entry)) {
      return cachePath;
    }

    try {
      await fs.promises.rename(tempPath, cachePath);
    } catch (error) {
      if (!["EEXIST", "EPERM"].includes(error.code)) {
        throw error;
      }

      if (await modelFileIsValid(cachePath, entry)) {
        return cachePath;
      }

      await fs.promises.rm(cachePath, { force: true });
      await fs.promises.rename(tempPath, cachePath);
    }

    return cachePath;
  } catch (error) {
    if (error?.code?.startsWith("OCR_")) {
      throw error;
    }
    throw createOcrError(
      `Could not download OCR model ${entry.file}: ${error.message}`,
      "OCR_MODEL_DOWNLOAD_FAILED"
    );
  } finally {
    await fs.promises.rm(tempPath, { force: true });
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

function boundsFromQuad(quad, info) {
  if (!quad || !info || !Number(info.width) || !Number(info.height)) {
    return null;
  }

  const points = [quad.topLeft, quad.topRight, quad.bottomLeft, quad.bottomRight];

  if (points.some((point) => !point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y)))) {
    return null;
  }

  const xs = points.map((point) => Number(point.x) * Number(info.width));
  const ys = points.map((point) => Number(point.y) * Number(info.height));
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  return normalizeBounds({
    x: minX,
    y: minY,
    width: Math.max(maxX - minX, 1),
    height: Math.max(maxY - minY, 1)
  });
}

export function normalizeOcrItems(payload) {
  let sourceItems;
  let legacyInfo = null;

  if (Array.isArray(payload)) {
    sourceItems = payload;
  } else if (payload && Array.isArray(payload.items)) {
    sourceItems = payload.items;
  } else if (payload && Array.isArray(payload.results)) {
    sourceItems = payload.results;
  } else if (payload && Array.isArray(payload.observations)) {
    sourceItems = payload.observations;
    legacyInfo = payload.info;
  } else {
    throw createOcrError("OCR backend did not return a list of text items.", "OCR_OUTPUT_INVALID");
  }

  return sourceItems.reduce((items, item) => {
    if (!item || typeof item.text !== "string" || item.text.length === 0) {
      return items;
    }

    const bounds = normalizeBounds(item.bounds || item.box) || boundsFromQuad(item.quad, legacyInfo);

    if (!bounds) {
      return items;
    }

    items.push({
      text: item.text,
      confidence: Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : 0,
      bounds
    });

    return items;
  }, []);
}

export function createPaddleBackend(settings = {}, dependencies = {}) {
  const strategy = settings.strategy || DEFAULT_OCR_STRATEGY;
  const recognition = { strategy };
  const resolvedDependencies = {
    cacheDirectory: dependencies.cacheDirectory || MODEL_CACHE_DIRECTORY,
    modelAssets: dependencies.modelAssets || MODEL_ASSETS,
    fetchResource: dependencies.fetchResource || globalThis.fetch,
    loadPaddle: dependencies.loadPaddle || (() => import("ppu-paddle-ocr"))
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
        strategy: options.strategy || strategy
      });
      return normalizeOcrItems(result);
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

export function createExternalBackend(binary, runner) {
  return {
    name: "external",
    async recognize(image, options) {
      const settings = options || {};

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
      } catch (error) {
        throw createOcrError("OCR output was not valid JSON.", "OCR_OUTPUT_INVALID");
      }

      return normalizeOcrItems(payload);
    }
  };
}

