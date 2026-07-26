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

function createApplicationController(platform, runner) {
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
    } else if (platform === "linux") {
      await runner("wmctrl", ["-xa", name], "Activate application");
    } else {
      throw createApplicationError(`Application lifecycle is not supported on ${platform}.`, "UNSUPPORTED_PLATFORM");
    }

    return { requested: name, target: name };
  }

  return { open, activate };
}

module.exports = {
  createApplicationController
};
