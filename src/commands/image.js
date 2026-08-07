import { z } from "incur";
import {
  captureSchema,
  captureWithRect,
  clickOptionsShape,
  getCaptureMetadata,
  performClick,
  pointSchema,
  rectangleOptionsShape,
  resolveInputPath,
  resolveWindowScope,
  timeoutSchema,
  waitForObservation,
  waitMetadataShape,
  windowOptionShape
} from "./shared.js";

const RETINA_IMAGE_SCALE = 0.5;
const RETINA_FALLBACK_TOLERANCE = 0.01;

const imageArgs = z.object({
  image: z.string().describe("Image file to match")
});

const imageOptions = z.object({
  ...rectangleOptionsShape,
  ...windowOptionShape,
  tolerance: z.number().optional().describe("Image matching tolerance")
});

const imageOutput = z.object({
  image: z.string().describe("Resolved image file path"),
  found: z.boolean().describe("Whether the image was found"),
  match: pointSchema.nullable().describe("Capture-relative match point"),
  screenPoint: pointSchema.nullable().describe("Screen-relative match point"),
  capture: captureSchema.describe("Searched capture metadata"),
  tolerance: z.number().nullable().describe("Applied image matching tolerance"),
  imageScale: z.number().nullable().describe("Scale applied to the source image for the selected match")
});

function createRetinaNeedle(image) {
  const sourceWidth = image.width;
  const sourceHeight = image.height;
  const sourceByteWidth = image.byteWidth;
  const bytesPerPixel = image.bytesPerPixel;

  if (
    !Number.isInteger(sourceWidth) ||
    !Number.isInteger(sourceHeight) ||
    sourceWidth < 2 ||
    sourceHeight < 2 ||
    sourceWidth % 2 !== 0 ||
    sourceHeight % 2 !== 0 ||
    !Number.isInteger(sourceByteWidth) ||
    !Number.isInteger(bytesPerPixel) ||
    bytesPerPixel < 1 ||
    !(image.image instanceof Uint8Array)
  ) {
    return null;
  }

  const requiredSourceBytes = ((sourceHeight - 1) * sourceByteWidth) + (sourceWidth * bytesPerPixel);
  if (sourceByteWidth < sourceWidth * bytesPerPixel || image.image.byteLength < requiredSourceBytes) {
    return null;
  }

  const width = sourceWidth / 2;
  const height = sourceHeight / 2;
  const byteWidth = width * bytesPerPixel;
  const pixels = Buffer.alloc(byteWidth * height);
  const source = Buffer.from(image.image.buffer, image.image.byteOffset, image.image.byteLength);

  for (let y = 0; y < height; y += 1) {
    let sourceOffset = (((y * 2) + 1) * sourceByteWidth) + bytesPerPixel;
    let targetOffset = y * byteWidth;
    const targetEnd = targetOffset + byteWidth;

    while (targetOffset < targetEnd) {
      for (let channel = 0; channel < bytesPerPixel; channel += 1) {
        pixels[targetOffset + channel] = source[sourceOffset + channel];
      }
      sourceOffset += bytesPerPixel * 2;
      targetOffset += bytesPerPixel;
    }
  }

  return {
    width,
    height,
    byteWidth,
    bitsPerPixel: image.bitsPerPixel,
    bytesPerPixel,
    image: pixels
  };
}

function createImageMatcher(needle, searchOptions) {
  let retinaNeedle;
  let retinaSearchOptions;
  return (capture) => {
    const match = capture.findImage(needle, searchOptions);
    if (match) {
      return {
        match,
        screenPoint: capture.toScreenPoint(match, needle),
        imageScale: 1,
        tolerance: searchOptions.tolerance ?? null
      };
    }

    if (retinaNeedle === undefined) {
      retinaNeedle = createRetinaNeedle(needle);
      if (retinaNeedle) {
        retinaSearchOptions = {
          ...searchOptions,
          tolerance: searchOptions.tolerance ?? RETINA_FALLBACK_TOLERANCE
        };
      }
    }

    if (retinaNeedle) {
      const retinaMatch = capture.findImage(retinaNeedle, retinaSearchOptions);

      if (retinaMatch) {
        return {
          match: retinaMatch,
          screenPoint: capture.toScreenPoint(retinaMatch, retinaNeedle),
          imageScale: RETINA_IMAGE_SCALE,
          tolerance: retinaSearchOptions.tolerance
        };
      }
    }

    return {
      match: null,
      screenPoint: null,
      imageScale: null,
      tolerance: searchOptions.tolerance ?? null
    };
  };
}

function collectImageMatch(robot, matchImage, rect) {
  const capture = captureWithRect(robot, rect);
  return { capture, ...matchImage(capture) };
}

function createImageCommand({ description, click = false, wait = false }) {
  let options = imageOptions;
  let output = imageOutput;

  if (click) {
    options = options.extend(clickOptionsShape);
    output = output.extend({
      button: z.enum(["left", "middle", "right"]).describe("Mouse button used"),
      double: z.boolean().describe("Whether a double-click was used")
    });
  }

  if (wait) {
    options = options.extend({ timeout: timeoutSchema });
    output = output.extend(waitMetadataShape);
  }

  return {
    description,
    args: imageArgs,
    options,
    output,
    async run(c) {
      const runtime = c.var.runtime;
      const robot = runtime.getRobot();
      const image = resolveInputPath(runtime.cwd, c.args.image, "image path");
      const { rect } = await resolveWindowScope(runtime, {}, c.options, { activate: true });
      const needle = robot.image.load(image);
      const searchOptions = c.options.tolerance === undefined
        ? {}
        : { tolerance: c.options.tolerance };
      const matchImage = createImageMatcher(needle, searchOptions);
      let observation;
      let waitResult;

      if (wait) {
        waitResult = await waitForObservation(
          () => collectImageMatch(robot, matchImage, rect),
          (value) => !!value.match,
          c.options,
          runtime
        );
        observation = waitResult.value;
      } else {
        observation = collectImageMatch(robot, matchImage, rect);
      }

      if (click && observation.screenPoint) {
        performClick(robot, observation.screenPoint, c.options);
      }

      const result = {
        image,
        found: !!observation.match,
        match: observation.match,
        screenPoint: observation.screenPoint,
        capture: getCaptureMetadata(observation.capture),
        tolerance: observation.tolerance,
        imageScale: observation.imageScale
      };

      if (click) {
        result.button = c.options.button || "left";
        result.double = !!c.options.double;
      }

      if (waitResult) {
        result.attempts = waitResult.attempts;
        result.elapsedMs = waitResult.elapsedMs;
        result.timedOut = waitResult.timedOut;
      }

      return result;
    }
  };
}

export function registerImageCommands(cli) {
  cli.command("findImage", createImageCommand({
    description: "Find an image on the current screen."
  }));
  cli.command("clickImage", createImageCommand({
    description: "Find and click an image on the current screen.",
    click: true
  }));
  cli.command("waitForImage", createImageCommand({
    description: "Wait for an image to appear on the current screen.",
    wait: true
  }));

  return cli;
}
