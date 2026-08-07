import { formatWindowDiagnostics, selectDiagnosticWindows } from "./windows.js";

function createApplicationError(message, code) {
  const error = new Error(message);
  error.code = code || "APPLICATION_ERROR";
  return error;
}

function normalizeApplicationName(requested) {
  const name = String(requested || "").trim();

  if (!name) {
    throw createApplicationError("Application name cannot be empty.", "INVALID_ARGUMENT");
  }

  return name;
}

export function createApplicationController(platform, runner, windowController) {
  async function open(application) {
    const name = normalizeApplicationName(application);

    if (platform === "darwin") {
      await runner("/usr/bin/open", ["-a", name], "Open application");
    } else if (platform === "win32") {
      await runner(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Start-Process -FilePath $args[0]",
          name
        ],
        "Open application"
      );
    } else if (platform === "linux") {
      await runner("gtk-launch", [name], "Open application");
    } else {
      throw createApplicationError(`Application lifecycle is not supported on ${platform}.`, "UNSUPPORTED_PLATFORM");
    }

    return { requested: name, target: name };
  }

  async function activate(application) {
    const name = normalizeApplicationName(application);

    if (!["darwin", "win32", "linux"].includes(platform)) {
      throw createApplicationError(`Application lifecycle is not supported on ${platform}.`, "UNSUPPORTED_PLATFORM");
    }

    try {
      if (platform === "darwin") {
        await runner("/usr/bin/open", ["-a", name], "Activate application");
      } else if (platform === "win32") {
        await runner(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$shell = New-Object -ComObject WScript.Shell; if (-not $shell.AppActivate($args[0])) { exit 1 }",
            name
          ],
          "Activate application"
        );
      } else {
        await runner("wmctrl", ["-xa", name], "Activate application");
      }
    } catch (error) {
      let diagnostics = "Window diagnostics unavailable.";
      if (windowController) {
        try {
          const windows = await windowController.list();
          const matches = selectDiagnosticWindows(windows, name);
          diagnostics = formatWindowDiagnostics(matches);
        } catch (diagnosticError) {
          diagnostics = `Window diagnostics failed: ${diagnosticError.message}`;
        }
      }

      throw createApplicationError(
        `Failed to activate application ${JSON.stringify(name)}: ${error.message}\n${diagnostics}`,
        "APPLICATION_ACTIVATION_FAILED"
      );
    }

    return { requested: name, target: name };
  }

  return { open, activate };
}
