# robot

Single-shot desktop automation with mouse, keyboard, image matching, and OCR.

Requires Node.js `>=22`.

## Why this shape

The intended loop is:

1. Take a screenshot.
2. Let a vision model decide what to do.
3. Fire one CLI command for the next action.

Normal desktop commands run once and exit. `robot --mcp` is an opt-in persistent
MCP server for clients that need the same command surface as tools.

## Better than raw coordinates

Vision-picked coordinates are useful, but they are not the only option.

For stable UI targets, `robot findImage`, `robot clickImage`, `robot findText`,
and `robot clickText` let the agent:

- use the model for coarse reasoning
- use local bitmap matching for exact placement
- use OCR to target visible labels directly
- avoid DPI and scaling mistakes

That gives you a cleaner hybrid approach than relying on screenshot-to-pixel
guessing for every click.

macOS selection screenshots can contain exactly twice the pixels used by the
screen capture API. After an original-scale miss, image commands retry an
even-sized image at half scale using the center pixel from each Retina 2x2
block. The retry respects `--tolerance`, or uses a conservative `0.01` default,
and reports `imageScale: 0.5` when it supplies the match.

## Commands

```sh
robot screenshot --output /tmp/screen.bmp
robot click 450 890
robot type "hello world"
robot moveMouse 450 890
robot openApp "Example App"
robot activateApp "Example App"
robot findImage ./assets/button.bmp --tolerance 0.1
robot clickImage ./assets/button.bmp --tolerance 0.1
robot waitForImage ./assets/button.bmp --timeout 30000
robot findText "Message General"
robot clickText "Message General" 2
robot clickWord "continue" --index 2
robot waitForText "Options" --timeout 30000
```

Successful commands print TOON to stdout by default. Use `--json` or
`--format <toon|json|yaml|md|jsonl>` when another representation is easier to
consume. `--full-output` adds Incur's success and command metadata envelope.

`type` defaults to 12,000 characters per minute (5 ms per character). Use
`--cpm` to choose a different speed.

Text search results include a `matches` array with every candidate's 1-based
`index`, confidence, bounds, and screen point. `clickText` and `clickWord`
accept that index as a trailing argument, so `robot clickText "Message General"
2` selects the second result. `--index 2` remains available for every text
command. Quote a text query ending in a number so it remains one argument.

When a label is small or repeated elsewhere on screen, constrain OCR to its
region instead of lowering confidence globally:

```sh
robot clickText Today --x 650 --y 200 --width 200 --height 100
```

Paddle recognition defaults to `--ocr-strategy per-box`, which isolates compact
UI labels and nearby icons. `per-line` is available for paragraph-like content,
and `cross-line` favors throughput. `--confidence` controls the minimum accepted
recognition confidence for text matching.

Each click command observes the current screen again rather than reusing
coordinates from a previous process. This avoids clicking a stale position
after the UI moves.

`waitForText` and `waitForImage` capture and retry inside one CLI process. The
default timeout is 30 seconds. Their result includes `attempts`, `elapsedMs`,
and `timedOut`.

Application names are passed through unchanged to the operating-system
integration. There is no application-specific registry. macOS uses `open`,
Windows uses PowerShell, and Linux uses `gtk-launch`/`wmctrl`.

`moveMouse` always animates with smooth motion. There is no separate
`moveMouseSmooth` command.

## Generated interfaces

Command definitions are the source for help, schemas, LLM manifests, Agent
skills, completions, and MCP tools:

```sh
robot --help
robot clickText --help
robot clickText --schema --format json
robot --llms
robot --llms-full
robot skills add
robot skills add --no-global
robot skills list
robot completions --help
```

Use root or per-command `--help` for current syntax rather than relying on a
committed exhaustive reference. `skills add` installs globally by default;
`skills add --no-global` writes a project-local skill. Normal commands remain
single-shot, while `robot --mcp` starts the opt-in MCP integration.

## `robotjs` resolution

`robotjs` is a peer dependency. Desktop commands lazily require the installed
package through Node's standard package resolution; use `npm link robotjs` for
local development. Help, schema, and generated interfaces do not load it.

## OCR backend

Text commands default to `ppu-paddle-ocr` with ONNX Runtime Node. The npm
package contains the OCR engine but not the PP-OCRv6 Tiny model weights. The
first text command downloads the detection, recognition, and dictionary files
(about 6 MB) to `~/.cache/ppu-paddle-ocr`; later commands reuse that cache and
work offline. Every cached or downloaded file is checked against its expected
size and SHA-256 digest, and an invalid cache entry is downloaded again.

Every screen capture is saved as BMP, read explicitly into an `ArrayBuffer`,
and passed to the backend. The internal result contract uses pixel bounds:

```json
{
  "text": "Options",
  "confidence": 0.97,
  "bounds": { "x": 412, "y": 680, "width": 120, "height": 32 }
}
```

For experiments, an external OCR executable can be selected in this order:

1. `--ocr <path>`
2. `ROBOT_OCR_PATH`

The executable receives `--img <capture.bmp>` and, when supplied,
`--rec-langs <langs>`. It may return the pixel-bounds contract directly or
the previous normalized `info`/`observations` JSON shape.

## Notes

- macOS will generally require Accessibility permission for mouse/keyboard
  control and Screen Recording permission for screenshots.
- If `screenSize` returns `0x0`, the process usually does not have usable
  screen access yet.
