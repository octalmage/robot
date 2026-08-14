import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCli } from "../src/cli.js";

const EMPTY_TEST_CONFIG = path.join(os.tmpdir(), `getrobot-test-${process.pid}-no-config.json`);

export function createStream() {
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

export async function run(argv, options = {}) {
  const { stdout = createStream(), ...overrides } = options;
  const cli = createCli({ configPath: EMPTY_TEST_CONFIG, ...overrides });
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

export function createRobot(overrides = {}) {
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
          toScreenPoint(point) {
            return point;
          }
        };
      }
    },
    image: {
      load() {
        return { width: 10, height: 10 };
      }
    },
    moveMouseSmooth() {},
    mouseClick() {},
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

export function createTextCapture(options = {}) {
  const settings = {
    width: 100,
    height: 50,
    screenX: 0,
    screenY: 0,
    scaleX: 1,
    scaleY: 1,
    ...options
  };

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
