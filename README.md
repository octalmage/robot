# robot

> Cross-platform desktop automation from the command line.

`robot` controls the mouse and keyboard, captures the screen, finds images, and
uses OCR to find, click, or wait for text.

## Install

Requires Node.js 22 or newer.

```sh
npm install -g getrobot
```

On macOS, request Accessibility and Screen Recording access before automating:

```sh
robot permissions --request
robot permissions
```

Published RobotJS prebuilds support Linux, macOS, and Windows on x64 and arm64,
including PNG and BMP screenshots. Other targets require the
[RobotJS build prerequisites](https://github.com/octalmage/robotjs#building).

## Examples

```sh
robot windows
robot activateWindow --title "Minecraft*"
robot screenshot --window Minecraft --output minecraft.png
robot screenshot --temp

robot moveMouse 450 890
robot click 450 890
robot type "hello world" --window Minecraft
robot keyTap enter --window Minecraft

robot findImage ./button.png --tolerance 0.1
robot clickImage ./button.png
robot clickText "Message General"
robot waitForText "cycle complete" --window Minecraft

robot sequence --window Minecraft --steps steps.json
```

Run `robot --help` or `<command> --help` for the complete command API. Commands
print TOON by default; use `--json` or
`--format <toon|json|yaml|md|jsonl>` for another format.

`type` defaults to 12,000 characters per minute. Override it with `--cpm`.

## Window targeting and sequences

`robot windows` lists titles, IDs, process/application identifiers, bounds,
displays, and display scales. `activateWindow` accepts an exact `--id` or a
`--title` with optional `*` and `?` wildcards. Failures include matching-window
diagnostics.

`openApp` and `activateApp` use native application identifiers: an application
name on macOS, an executable or `AppActivate` target on Windows, and a desktop
entry or `WM_CLASS` target on Linux. For portable targeting, use `windows` and
select a window by ID or title.

Use `--window <reference>` on `screenshot`, `click`, `type`, `keyTap`, image,
and text commands. References can be a window ID, title, process, or application
class. Exact process/application matches take precedence over title substrings.
Ambiguous references fail and list the matching window IDs. Bounds are refreshed
after activation, and text scopes are clipped to visible display areas.

`sequence` focuses its target once, then runs input and OCR verification steps
in the same process:

```json
[
  { "command": "keyTap", "key": "t" },
  { "command": "type", "text": "cycle complete", "cpm": 12000 },
  { "command": "assertText", "query": "cycle complete", "exact": true },
  { "command": "click", "x": 100, "y": 50, "button": "left" },
  { "command": "clickText", "query": "New Note", "exact": true },
  { "command": "waitForText", "query": "Ready", "timeout": 30000 }
]
```

The file must contain a non-empty JSON array. Each step has one of these
formats:

| `command` | Required fields | Optional fields and defaults |
| --- | --- | --- |
| `keyTap` | `key` | `modifiers` |
| `type` | `text` | `cpm` (`12000`) |
| `click` | none | `x` and `y` together (window-relative), `button` (`left`), `double` (`false`) |
| `clickText` | `query` | `index` (`1`), `confidence` (`0`), `exact`, `button` (`left`), `double` (`false`), OCR options |
| `assertText` | `query` | `confidence` (`0`), `exact`, OCR options |
| `waitForText` | `query` | `timeout` (`30000`), `confidence` (`0`), `exact`, OCR options |

OCR options are `ocr`, `recLangs`, and `ocrStrategy` (`per-box`). A `click`
without coordinates clicks the current pointer. `clickText`, `assertText`, and
`waitForText` stop the sequence when their target is not found. Print the
complete generated JSON Schema with:

```sh
robot sequence --schema --format json
```

Pass the array by file, inline JSON, stdin, or directly as the MCP `steps`
array:

```sh
robot sequence --window Minecraft --steps steps.json
robot sequence --window Minecraft --steps-json '[{"command":"keyTap","key":"enter"}]'
printf '%s' '[{"command":"type","text":"32"}]' | robot sequence --window Minecraft --steps -
```

`--capture-on-failure` retains a managed screenshot of the selected window
when any step fails.

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
