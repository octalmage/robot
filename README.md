# robot

Single-shot desktop automation with mouse, keyboard, image matching, and OCR.

## Installation

Requires Node.js 22 or newer. `robotjs@0.9.0` currently has no release
prebuilds, so npm compiles its native addon during installation; install the
[RobotJS build prerequisites](https://github.com/octalmage/robotjs#building)
for your platform first.

```sh
npm install -g robotcli
```

Now run: 

```
robot screenSize
```

Assuming it installed correctly you should get something like: 

```
size:
  width: 2240
  height: 1260
```

### macOS permissions

Use the native macOS permission prompts before the first automation command:

```sh
robot permissions --request
```

macOS still requires user approval. After approving Accessibility and Screen
Recording, run `robot permissions` to confirm both grants.

### Optional PNG support

BMP loading and saving is always available. On macOS or Linux, install `libpng`
and `pkg-config` in addition to the normal build prerequisites:

```sh
# macOS
brew install libpng pkg-config

# Debian or Ubuntu
sudo apt-get install libpng-dev pkg-config
```

Then enable PNG while npm builds RobotJS:

```sh
ROBOTJS_ENABLE_PNG=1 npm install --global robotcli
robot screenshot --output /tmp/robot.png
```

Without `ROBOTJS_ENABLE_PNG=1`, the locally compiled RobotJS addon is BMP-only.

## Usage

```sh
robot permissions
robot screenshot --output /tmp/screen.bmp
robot moveMouse 450 890
robot click 450 890
robot type "hello world"
robot keyTap a command
robot scrollMouse 0 -5
robot mousePos
robot screenSize
robot pixelColor 450 890

robot openApp "Example App"
robot activateApp "Example App"

robot findImage ./assets/button.bmp --tolerance 0.1
robot clickImage ./assets/button.bmp --tolerance 0.1
robot waitForImage ./assets/button.bmp --timeout 30000

robot text
robot findText "Message General"
robot clickText "Message General" 2
robot clickWord "continue" --index 2
robot waitForText "Options" --timeout 30000
```

Commands print TOON by default. Use `--json` or
`--format <toon|json|yaml|md|jsonl>` for another format. `--full-output` adds
Incur's result metadata.

`type` defaults to 12,000 characters per minute (5 ms per character). Override
it with `--cpm`.

## Image and text targeting

Image and text commands capture the screen immediately before matching, so a
click does not reuse coordinates from an earlier process. `waitForImage` and
`waitForText` retry in one process and report `attempts`, `elapsedMs`, and
`timedOut`.

Image matching first uses the source image at its original size. If that misses
and the image has even dimensions, it also tries a half-size version for macOS
Retina selection screenshots. The result's `imageScale` and `tolerance` fields
show which match succeeded.

Text results include every candidate in `matches`, with one-based indices,
confidence, bounds, and screen coordinates. `clickText` and `clickWord` accept
an occurrence as either a trailing integer or `--index`. `--index` is also
available on the find and wait commands. Quote a query ending in a number to
keep it as one argument:

```sh
robot clickText "Version 2"
```

Use `--x`, `--y`, `--width`, and `--height` together to limit image or text
matching to a screen region:

```sh
robot clickText Today --x 650 --y 200 --width 200 --height 100
```

Paddle OCR defaults to `--ocr-strategy per-box`, which works well for compact
UI labels. `per-line` is intended for lines of prose, and `cross-line` batches
multiple lines. `--confidence` sets the minimum accepted recognition
confidence.

## OCR models and external backends

Text commands use `ppu-paddle-ocr` with ONNX Runtime Node. On the first text
command, `robot` downloads the PP-OCRv6 Tiny detection, recognition, and
dictionary files (about 6 MB) to `~/.cache/ppu-paddle-ocr`. Cached files are
verified by size and SHA-256 digest before use.

Select an external OCR executable with `--ocr <command>` or
`ROBOT_OCR_PATH`. The executable receives `--img <capture.bmp>` and, when
provided, `--rec-langs <langs>`. It must print a JSON array:

```json
[
  {
    "text": "Options",
    "confidence": 0.97,
    "bounds": { "x": 412, "y": 680, "width": 120, "height": 32 }
  }
]
```

## Generated interfaces

The Incur command definitions generate help, JSON Schema, LLM manifests,
completions, MCP tools, and Agent skills:

```sh
robot --help
robot clickText --help
robot clickText --schema --format json
robot --llms
robot --llms-full
robot completions --help
robot skills add
robot skills add --no-global
robot skills list
robot --mcp
```

Desktop commands load `robotjs` only when invoked. Help, schemas, manifests,
skills, and completions do not load the native module.

## Development

For contributors working on this repository and the sibling `robotjs` checkout:

```sh
npm install
npm link ../robotjs --no-save
npm link
npm test
```
