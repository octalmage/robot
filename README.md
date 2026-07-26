# robot

Single-shot CLI wrapper around `robotjs` for desktop automation.

## Why this shape

The intended loop is:

1. Take a screenshot.
2. Let a vision model decide what to do.
3. Fire one CLI command for the next action.

There is no daemon or persistent process. `robotjs` operations are already fast,
so the CLI stays simple and composable.

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

All successful commands print JSON to stdout.

Text search results include a `matches` array with every candidate's 1-based
`index`, confidence, bounds, and screen point. `clickText` and `clickWord`
accept that index as a trailing argument, so `robot clickText "Message General"
2` selects the second result. `--index 2` remains available for every text
command. Quote a text query ending in a number so it remains one argument.

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

## `robotjs` resolution

The CLI loads `robotjs` in this order:

1. `ROBOTJS_PATH`
2. installed `robotjs`
3. sibling repo at `../robotjs`

That makes local development in this workspace work without adding more
runtime machinery.

## OCR backend

Text commands default to `ppu-paddle-ocr` with ONNX Runtime Node and the
bundled PP-OCRv6 Tiny detection, recognition, and dictionary assets. The
assets are listed in `models/pp-ocrv6-tiny/manifest.json`; their size and
SHA-256 checksum are verified before ONNX sessions are created. No model is
downloaded at runtime.

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
