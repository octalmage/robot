import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MODEL_CACHE_DIRECTORY = path.join(os.homedir(), ".cache", "ppu-paddle-ocr");
const MODEL_REPOSITORY = "PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models";
const MODEL_REVISION = "9027d49d3764d465c3d7c4e8506910fb8d9c1498";
const MODEL_BASE_URL = `https://media.githubusercontent.com/media/${MODEL_REPOSITORY}/${MODEL_REVISION}`;
const DICTIONARY_BASE_URL = `https://raw.githubusercontent.com/${MODEL_REPOSITORY}/${MODEL_REVISION}`;
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
  const recognition = { strategy };
  const resolvedDependencies = {
    cacheDirectory: dependencies.cacheDirectory ?? MODEL_CACHE_DIRECTORY,
    modelAssets: dependencies.modelAssets ?? MODEL_ASSETS,
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

