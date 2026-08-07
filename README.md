# robot

Single-shot desktop automation with mouse, keyboard, image matching, and OCR.

## Installation

Requires Node.js 22 or newer. `robotjs@0.9.1` provides Node-API prebuilds for
Linux, macOS, and Windows on x64 and arm64. Other targets fall back to a source
build and require the
[RobotJS build prerequisites](https://github.com/octalmage/robotjs#building).

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

### PNG screenshots

RobotJS 0.9.1 prebuilds include PNG support on every supported platform, so
`robot screenshot --output screen.png` works without extra system libraries.
BMP output remains available.

## Usage

```sh
robot permissions
robot windows
robot activateWindow --title "Minecraft*"
robot screenshot --window Minecraft --output /tmp/minecraft.png
robot screenshot --window Minecraft --temp
robot screenshot --output /tmp/screen.bmp
robot moveMouse 450 890
robot click 450 890
robot type stick --window Minecraft
robot keyTap enter --window Minecraft
robot scrollMouse 0 -5
robot mousePos
robot screenSize
robot pixelColor 450 890

robot openApp "Example App"
robot activateApp "Example App"
robot sequence --window Minecraft --steps steps.json
robot sequence --window Minecraft --steps-json '[{"command":"type","text":"32"}]'

robot findImage ./assets/button.bmp --tolerance 0.1
robot clickImage ./assets/button.bmp --tolerance 0.1
robot waitForImage ./assets/button.bmp --timeout 30000

robot text --keep-capture
robot findText "Message General"
robot clickText "Message General" 2
robot clickWord "continue" --index 2
robot waitForText "Options" --timeout 30000
robot waitForText "cycle complete" --window Minecraft --timeout 30000
```

Commands print TOON by default. Use `--json` or
`--format <toon|json|yaml|md|jsonl>` for another format. `--full-output` adds
Incur's result metadata.

`type` defaults to 12,000 characters per minute (5 ms per character). Override
it with `--cpm`.

## Window targeting and sequences

`robot windows` lists application windows with their titles, IDs,
processes, bounds, displays, and display scales. `activateWindow` accepts
`--title` (with `*` and `?` wildcards) or an exact `--id`. Activation failures
include matching window diagnostics instead of only the operating-system
process error.

Use `--window <id-or-title>` on `screenshot`, `click`, `type`, `keyTap`, image
commands, and text commands to activate the selected window before operating.
Capture operations are constrained to that window, and rectangle and click
coordinates are window-relative. This keeps wait commands from matching the
same text or image in another application.

`sequence` focuses its target once, then runs input and OCR verification steps
in the same process:

```json
[
  { "command": "keyTap", "key": "t" },
  { "command": "type", "text": "cycle complete", "cpm": 12000 },
  { "command": "assertText", "query": "cycle complete", "exact": true },
  { "command": "click", "x": 100, "y": 50, "button": "left" },
  { "command": "waitForText", "query": "Ready", "timeout": 30000 }
]
```

Pass the array by file, inline JSON, stdin, or directly as the MCP `steps`
array:

```sh
robot sequence --window Minecraft --steps steps.json
robot sequence --window Minecraft --steps-json '[{"command":"keyTap","key":"enter"}]'
printf '%s' '[{"command":"type","text":"32"}]' | robot sequence --window Minecraft --steps -
```

`--capture-on-failure` retains a managed screenshot of the selected window
when any input, assertion, or wait step fails.

## Managed captures

`robot screenshot --temp` creates a PNG without requiring an output path. Its
result includes the generated `output`, a `file:` `imageUri`, and a stable
working-directory-scoped `latest` path. MCP clients receive those fields in
structured output. Captures are not deleted by default; `--temp-ttl <ms>`
removes expired captures the next time a managed capture is created.

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

`robot text --keep-capture` adds `captureImagePath` to each display result and
leaves that OCR input on disk for inspection.

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

The command definitions generate help, JSON Schema, LLM manifests,
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

## Development

For contributors working on this repository and the sibling `robotjs` checkout:

```sh
npm install
npm link ../robotjs --no-save
npm link
npm test
```
