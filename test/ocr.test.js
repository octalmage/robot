const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createPaddleBackend, toArrayBuffer } = require("../src/ocr");

test("bundled PP-OCRv6 Tiny recognizes positioned text from a BMP", { timeout: 30000 }, async () => {
  const backend = createPaddleBackend();

  try {
    const imagePath = path.resolve(__dirname, "..", "allow.bmp");
    const items = await backend.recognize(toArrayBuffer(fs.readFileSync(imagePath)));
    const match = items.find((item) => (
      item.text.toLowerCase().includes("allow remote debugging for this browser instance")
    ));

    assert.ok(match);
    assert.ok(match.confidence > 0.9);
    assert.ok(match.bounds.width > 0);
    assert.ok(match.bounds.height > 0);
    assert.ok(match.bounds.x >= 0);
    assert.ok(match.bounds.y >= 0);
  } finally {
    await backend.destroy();
  }
});
