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
robot keyTap t --window Minecraft
robot type "hello world" --window Minecraft
robot keyTap enter --window Minecraft

robot findImage ./button.png --tolerance 0.1
robot clickImage ./button.png
robot clickText "Message General"
robot waitForText "cycle complete" --window Minecraft
robot waitForText Seed --window Minecraft --fuzzy
robot text --window Minecraft --x 505 --y 280 --width 950 --height 540
robot text --window Minecraft --ocr-backend rapidocr

robot sequence --window Minecraft --steps steps.json
```

Run `robot --help` or `<command> --help` for the complete command API. Commands
print TOON by default; use `--json` or
`--format <toon|json|yaml|md|jsonl>` for another format.

Without a config file, `type` defaults to 600 characters per minute (100 ms per
character). Override it with `--cpm` or the user config.

## User defaults and agent setup

Initialize recommended defaults once per machine:

```sh
robot config --init
robot config
```

This creates `~/.config/robot/config.json` (or
`$XDG_CONFIG_HOME/robot/config.json`) without overwriting an existing file:

```json
{
  "defaults": {
    "cpm": 600,
    "ocrBackend": "paddle",
    "ocrModel": "small",
    "ocrStrategy": "per-box",
    "fuzzy": true
  }
}
```

`small` improves text recognition; fuzzy mode remains strict-first and only
allows one character error when no exact, prefix, or substring match exists.
Add `"window": "Minecraft"` only on a machine dedicated to one target.

Robot uses Incur's native config support. Precedence is explicit command or
sequence-step options, per-command config, shared user defaults, then built-in
defaults. Use `--config <path>` for another config and `--no-config` to ignore
the user file. Boolean settings can be negated explicitly, for example
`--no-fuzzy`.

For an unfamiliar interface, start with `robot text --window <target>`. Its
`allItems` output reports recognized labels, confidence, bounds, and screen
points. Prefer `clickText`, `waitForText`, or image targeting over guessed
coordinates; use `sequence` when focus must remain stable across several steps.

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
after activation, and text scopes are clipped to visible display areas. Rectangle
options are window-relative when combined with `--window`, including on the
`text` inventory command. Window-scoped polling reactivates the target
immediately before every capture; these captures represent the visible window
rectangle, not an occlusion-free offscreen framebuffer.

`sequence` reasserts target focus before every input or OCR step and each
polling retry:

```json
[
  { "command": "keyTap", "key": "t" },
  { "command": "type", "text": "cycle complete", "cpm": 600 },
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
| `type` | `text` | `cpm` (`600`) |
| `click` | none | `x` and `y` together (window-relative), `button` (`left`), `double` (`false`) |
| `clickText` | `query` | `index` (`1`), `confidence` (`0`), `exact`, `fuzzy`, `button` (`left`), `double` (`false`), OCR options |
| `assertText` | `query` | `confidence` (`0`), `exact`, `fuzzy`, OCR options |
| `waitForText` | `query` | `timeout` (`30000`), `confidence` (`0`), `exact`, `fuzzy`, OCR options |

OCR options are `ocr`, `recLangs`, `ocrModel`, and `ocrStrategy`. Sequence-level
`cpm`, OCR, and `fuzzy` settings apply to steps that do not override them. A
`click` without coordinates clicks the current pointer. `clickText`,
`assertText`, and `waitForText` stop the sequence when their target is not
found. Print the complete generated JSON Schema with:

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

Text match results include every candidate in `matches`, with one-based indices,
confidence, bounds, screen coordinates, and match quality. `robot text`
inventories every OCR item in `allItems` with the same location metadata.
`clickText` and `clickWord` accept an occurrence as either a trailing integer or
`--index`.
`--index` is also available on the find and wait commands. Quote a query ending
in a number to keep it as one argument:

```sh
robot clickText "Version 2"
```

Fuzzy fallback can be enabled by user config or `--fuzzy`; `--no-fuzzy`
disables a configured default for one command. It tolerates one insertion,
deletion, or substitution in queries of at least four characters and ignores
punctuation inserted inside a word, such as `Wor-ld`. Exact, prefix, and
substring matches always win. Equally ranked fuzzy candidates are reported as
`ambiguous` and are not selected unless you pass an explicit occurrence.
`--exact` disables fuzzy fallback, including a configured default. Fuzzy
results report `matchType`, `editDistance`, and `similarity`.

Use `--x`, `--y`, `--width`, and `--height` together to limit image or text
capture and matching to a screen region:

```sh
robot clickText Today --x 650 --y 200 --width 200 --height 100
robot text --window Minecraft --x 505 --y 280 --width 950 --height 540
```

Paddle OCR defaults to `--ocr-strategy per-box`, which works well for compact
UI labels. `per-line` is intended for lines of prose, and `cross-line` batches
multiple lines. `--ocr-model` and `--ocr-strategy` apply only to the Paddle
backend. `--confidence` sets the minimum accepted recognition confidence.

`robot text --keep-capture` adds `captureImagePath` to each display result and
leaves that OCR input on disk for inspection. Normally, use `allItems` before
requesting a retained screenshot.

## OCR models and external backends

Text commands use `ppu-paddle-ocr` with ONNX Runtime Node by default. The
built-in `--ocr-model tiny` downloads about 6 MB on first use; `robot config
--init` selects the higher-capacity roughly 30 MB `small` model for subsequent
commands. Detection, recognition, and dictionary files are stored in
`~/.cache/ppu-paddle-ocr` and verified by size and SHA-256 digest before use.

RapidOCR is available as an optional local backend:

```sh
robot text --window Minecraft --ocr-backend rapidocr
robot waitForText "cycle complete" --window Minecraft --ocr-backend rapidocr
```

Install [`uv`](https://docs.astral.sh/uv/getting-started/installation/) and
ensure `uv` is on `PATH`. On first use, Robot creates a locked Python
environment containing RapidOCR 3.9.2 and ONNX Runtime 1.29.0 in uv's cache.
The worker uses PP-OCRv6 Small, stays alive for the command, and is reused
across displays, polling attempts, and sequence steps. Results report
`ocrBackend: "rapidocr"`, `ocrModel: "small"`, and `ocrStrategy: "per-line"`.
Set `"ocrBackend": "rapidocr"` in shared defaults to enable it by default, or
set `ROBOT_OCR_BACKEND=rapidocr`. `ROBOT_RAPIDOCR_COMMAND` selects another uv
executable path.

Select an external OCR executable with `--ocr <command>` or
`ROBOT_OCR_PATH`; an external command takes precedence over `--ocr-backend`.
The executable receives `--img <capture.bmp>` and, when provided,
`--rec-langs <langs>`. It must print a JSON array:

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
