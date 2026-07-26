const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MODEL_DIRECTORY = path.resolve(__dirname, "..", "models", "pp-ocrv6-tiny");
const MODEL_MANIFEST = require("../models/pp-ocrv6-tiny/manifest.json");

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

function toArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function loadModelAsset(key) {
  const entry = MODEL_MANIFEST.files[key];

  if (!entry) {
    throw createOcrError(`Missing OCR model manifest entry: ${key}.`, "OCR_MODEL_INVALID");
  }

  const assetPath = path.join(MODEL_DIRECTORY, entry.file);
  let buffer;

  try {
    buffer = fs.readFileSync(assetPath);
  } catch (error) {
    throw createOcrError(`Could not read bundled OCR model ${entry.file}: ${error.message}`, "OCR_MODEL_MISSING");
  }

  if (buffer.byteLength !== entry.size) {
    throw createOcrError(`Bundled OCR model ${entry.file} has an unexpected size.`, "OCR_MODEL_INVALID");
  }

  const checksum = crypto.createHash("sha256").update(buffer).digest("hex");

  if (checksum !== entry.sha256) {
    throw createOcrError(`Bundled OCR model ${entry.file} failed checksum verification.`, "OCR_MODEL_INVALID");
  }

  return toArrayBuffer(buffer);
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

function normalizeOcrItems(payload) {
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

function createPaddleBackend() {
  let servicePromise = null;

  async function initialize() {
    const model = {
      detection: loadModelAsset("detection"),
      recognition: loadModelAsset("recognition"),
      charactersDictionary: loadModelAsset("charactersDictionary")
    };
    const { PaddleOcrService } = await import("ppu-paddle-ocr");
    const service = new PaddleOcrService({ model });

    try {
      await service.initialize();
      return service;
    } catch (error) {
      await service.destroy();
      throw createOcrError(`Paddle OCR initialization failed: ${error.message}`, "OCR_INITIALIZATION_FAILED");
    }
  }

  return {
    name: "paddle",
    async recognize(image) {
      if (!(image instanceof ArrayBuffer)) {
        throw createOcrError("Paddle OCR expects captured image data as an ArrayBuffer.", "OCR_INPUT_INVALID");
      }

      if (!servicePromise) {
        servicePromise = initialize();
      }

      const service = await servicePromise;
      const result = await service.recognize(image, { flatten: true, noCache: true });
      return normalizeOcrItems(result);
    },
    async destroy() {
      if (servicePromise) {
        const service = await servicePromise;
        await service.destroy();
      }
    }
  };
}

function createExternalBackend(binary, runner) {
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

module.exports = {
  createExternalBackend,
  createPaddleBackend,
  normalizeOcrItems,
  toArrayBuffer
};
