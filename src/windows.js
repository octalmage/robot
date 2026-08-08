import { spawn } from "node:child_process";
import { createCommandError } from "./commands/shared.js";

const WINDOWS_API = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

public sealed class RobotWindowInfo
{
    public string id;
    public string title;
    public string process;
    public int? processId;
    public RobotWindowBounds bounds;
    public string display;
    public double? scale;
    public bool minimized;
}

public sealed class RobotWindowBounds
{
    public int x;
    public int y;
    public int width;
    public int height;
}

public static class RobotWindowApi
{
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    private struct MonitorInfo
    {
        public int Size;
        public Rect Monitor;
        public Rect Work;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string Device;
    }

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    private static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out Rect rect);

    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out Rect value, int size);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);

    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("user32.dll")]
    private static extern bool ShowWindowAsync(IntPtr hWnd, int command);

    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint source, uint target, bool attach);

    private static Rect GetBounds(IntPtr hWnd)
    {
        Rect bounds;
        const int extendedFrameBounds = 9;
        if (DwmGetWindowAttribute(hWnd, extendedFrameBounds, out bounds, Marshal.SizeOf(typeof(Rect))) != 0)
        {
            GetWindowRect(hWnd, out bounds);
        }
        return bounds;
    }

    private static string GetDisplay(IntPtr hWnd)
    {
        const uint nearest = 2;
        IntPtr monitor = MonitorFromWindow(hWnd, nearest);
        MonitorInfo info = new MonitorInfo();
        info.Size = Marshal.SizeOf(typeof(MonitorInfo));
        return monitor != IntPtr.Zero && GetMonitorInfo(monitor, ref info) ? info.Device : null;
    }

    private static double? GetScale(IntPtr hWnd)
    {
        try
        {
            uint dpi = GetDpiForWindow(hWnd);
            return dpi == 0 ? (double?)null : dpi / 96.0;
        }
        catch (EntryPointNotFoundException)
        {
            return null;
        }
    }

    public static void EnableDpiAwareness()
    {
        try
        {
            SetProcessDpiAwarenessContext(new IntPtr(-4));
        }
        catch (EntryPointNotFoundException)
        {
        }
    }

    public static RobotWindowInfo[] List()
    {
        List<RobotWindowInfo> windows = new List<RobotWindowInfo>();
        Dictionary<int, string> processNames = new Dictionary<int, string>();
        foreach (Process process in Process.GetProcesses())
        {
            try
            {
                processNames[process.Id] = process.ProcessName;
            }
            catch
            {
            }
            finally
            {
                process.Dispose();
            }
        }
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
        {
            int titleLength = GetWindowTextLength(hWnd);
            if (!IsWindowVisible(hWnd) || titleLength == 0)
            {
                return true;
            }

            StringBuilder title = new StringBuilder(titleLength + 1);
            GetWindowText(hWnd, title, title.Capacity);
            Rect rect = GetBounds(hWnd);
            int width = rect.Right - rect.Left;
            int height = rect.Bottom - rect.Top;
            if (width <= 0 || height <= 0)
            {
                return true;
            }

            uint processId;
            GetWindowThreadProcessId(hWnd, out processId);
            string processName = null;
            processNames.TryGetValue((int)processId, out processName);

            windows.Add(new RobotWindowInfo
            {
                id = hWnd.ToInt64().ToString(CultureInfo.InvariantCulture),
                title = title.ToString(),
                process = processName,
                processId = processId > 0 ? (int?)processId : null,
                bounds = new RobotWindowBounds
                {
                    x = rect.Left,
                    y = rect.Top,
                    width = width,
                    height = height
                },
                display = GetDisplay(hWnd),
                scale = GetScale(hWnd),
                minimized = IsIconic(hWnd)
            });
            return true;
        }, IntPtr.Zero);
        return windows.ToArray();
    }

    public static bool Activate(long value)
    {
        IntPtr hWnd = new IntPtr(value);
        if (hWnd == IntPtr.Zero || !IsWindow(hWnd))
        {
            return false;
        }
        const int show = 5;
        const int restore = 9;
        ShowWindowAsync(hWnd, IsIconic(hWnd) ? restore : show);

        IntPtr foreground = GetForegroundWindow();
        uint ignoredProcessId;
        uint foregroundThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, out ignoredProcessId);
        uint targetThread = GetWindowThreadProcessId(hWnd, out ignoredProcessId);
        uint currentThread = GetCurrentThreadId();
        bool attachedToForeground = foregroundThread != 0 && foregroundThread != currentThread && AttachThreadInput(currentThread, foregroundThread, true);
        bool attachedToTarget = targetThread != 0 && targetThread != currentThread && AttachThreadInput(currentThread, targetThread, true);

        try
        {
            BringWindowToTop(hWnd);
            return SetForegroundWindow(hWnd) || GetForegroundWindow() == hWnd;
        }
        finally
        {
            if (attachedToTarget)
            {
                AttachThreadInput(currentThread, targetThread, false);
            }
            if (attachedToForeground)
            {
                AttachThreadInput(currentThread, foregroundThread, false);
            }
        }
    }
}
`;

const WINDOWS_LIST_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @'
${WINDOWS_API}
'@
[RobotWindowApi]::EnableDpiAwareness()
ConvertTo-Json -InputObject @([RobotWindowApi]::List()) -Compress -Depth 4
`;

const WINDOWS_HOST_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
${WINDOWS_API}
'@
[RobotWindowApi]::EnableDpiAwareness()

while ($null -ne ($line = [Console]::In.ReadLine())) {
  if ([string]::IsNullOrWhiteSpace($line)) {
    continue
  }

  $requestId = $null
  try {
    $request = ConvertFrom-Json -InputObject $line
    $requestId = $request.id
    if ($request.operation -eq "list") {
      $data = @([RobotWindowApi]::List())
    } elseif ($request.operation -eq "activate") {
      $handle = [long]::Parse([string]$request.windowId, [Globalization.CultureInfo]::InvariantCulture)
      if (-not [RobotWindowApi]::Activate($handle)) {
        throw "Windows rejected the foreground-window request for handle $handle."
      }
      $data = $true
    } else {
      throw "Unknown window operation: $($request.operation)"
    }
    $response = [ordered]@{ id = $requestId; ok = $true; data = $data }
  } catch {
    $response = [ordered]@{ id = $requestId; ok = $false; error = $_.Exception.Message }
  }

  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $response -Compress -Depth 5))
  [Console]::Out.Flush()
}
`;

function normalizeWindowsHandle(windowId) {
  const value = String(windowId);
  if (!/^-?\d+$/.test(value)) {
    throw createCommandError(`Windows window ID must be a decimal integer: ${JSON.stringify(value)}.`, "INVALID_WINDOW_ID");
  }

  const handle = BigInt(value);
  if (handle < -9223372036854775808n || handle > 9223372036854775807n) {
    throw createCommandError(`Windows window ID is outside the signed 64-bit range: ${value}.`, "INVALID_WINDOW_ID");
  }
  return value;
}

function createWindowsActivateScript(windowId) {
  const value = normalizeWindowsHandle(windowId);
  return String.raw`
$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @'
${WINDOWS_API}
'@
[RobotWindowApi]::EnableDpiAwareness()
$handle = [long]::Parse('${value}', [Globalization.CultureInfo]::InvariantCulture)
if (-not [RobotWindowApi]::Activate($handle)) {
  throw "Windows rejected the foreground-window request for handle $handle."
}
`;
}

export function createWindowsWindowHost(options = {}) {
  const spawnProcess = options.spawnProcess || spawn;
  const pending = new Map();
  let child = null;
  let outputBuffer = "";
  let errorBuffer = "";
  let nextRequestId = 1;
  let disposed = false;
  let disposal;

  function createHostError(message, code = "WINDOW_HOST_ERROR") {
    const details = errorBuffer.trim();
    return createCommandError(details ? `${message}: ${details}` : message, code);
  }

  function rejectPending(error) {
    for (const request of pending.values()) {
      request.reject(error);
    }
    pending.clear();
  }

  function stopWithError(message) {
    rejectPending(createHostError(message));
    if (child && !child.killed) {
      child.kill();
    }
  }

  function handleLine(rawLine) {
    const line = rawLine.replace(/^\uFEFF/, "").trim();
    if (!line) {
      return;
    }

    let response;
    try {
      response = JSON.parse(line);
    } catch (error) {
      stopWithError(`Windows window host returned invalid JSON: ${error.message}`);
      return;
    }

    const key = String(response.id);
    const request = pending.get(key);
    if (!request) {
      stopWithError(`Windows window host returned an unknown request ID: ${key}`);
      return;
    }

    pending.delete(key);
    if (response.ok === true) {
      request.resolve(response.data);
    } else {
      request.reject(createCommandError(
        response.error || "Windows window host operation failed.",
        "WINDOW_HOST_REQUEST_FAILED"
      ));
    }
  }

  function handleOutput(chunk) {
    outputBuffer += chunk;
    let newlineIndex = outputBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      handleLine(outputBuffer.slice(0, newlineIndex));
      outputBuffer = outputBuffer.slice(newlineIndex + 1);
      newlineIndex = outputBuffer.indexOf("\n");
    }
  }

  function start() {
    if (disposed) {
      throw createCommandError("Windows window host has been disposed.", "WINDOW_HOST_DISPOSED");
    }
    if (child) {
      return child;
    }

    const running = spawnProcess(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_HOST_SCRIPT],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }
    );
    child = running;
    outputBuffer = "";
    errorBuffer = "";
    running.stdout.setEncoding("utf8");
    running.stderr.setEncoding("utf8");
    running.stdout.on("data", handleOutput);
    running.stderr.on("data", (chunk) => {
      errorBuffer = `${errorBuffer}${chunk}`.slice(-16384);
    });
    running.on("error", (error) => {
      if (child === running) {
        child = null;
      }
      rejectPending(createHostError(`Failed to start Windows window host: ${error.message}`));
    });
    running.on("exit", (code, signal) => {
      if (child === running) {
        child = null;
      }
      if (pending.size > 0) {
        const reason = signal ? `signal ${signal}` : `code ${code}`;
        rejectPending(createHostError(`Windows window host exited with ${reason}`));
      }
    });
    return running;
  }

  function request(operation, values = {}) {
    let running;
    try {
      running = start();
    } catch (error) {
      return Promise.reject(error);
    }

    const id = nextRequestId;
    nextRequestId += 1;
    return new Promise((resolve, reject) => {
      const key = String(id);
      pending.set(key, { resolve, reject });
      running.stdin.write(`${JSON.stringify({ id, operation, ...values })}\n`, "utf8", (error) => {
        if (!error) {
          return;
        }
        const queued = pending.get(key);
        if (queued) {
          pending.delete(key);
          queued.reject(createHostError(`Failed to write to Windows window host: ${error.message}`));
        }
      });
    });
  }

  async function dispose() {
    if (disposal) {
      return disposal;
    }

    disposed = true;
    const running = child;
    if (!running || running.exitCode !== null || running.signalCode !== null) {
      child = null;
      return;
    }

    disposal = new Promise((resolve) => {
      running.once("exit", resolve);
      running.stdin.end();
      running.kill();
    });
    return disposal;
  }

  return {
    list() {
      return request("list");
    },
    activate(windowId) {
      return request("activate", { windowId: normalizeWindowsHandle(windowId) });
    },
    dispose
  };
}

const MACOS_LIST_SCRIPT = String.raw`
ObjC.import("AppKit");
ObjC.import("CoreGraphics");
ObjC.bindFunction("CGWindowListCopyWindowInfo", ["id", ["uint32", "uint32"]]);

function number(value) {
  return Number(ObjC.unwrap(value));
}

function run() {
  const screenObjects = $.NSScreen.screens;
  const screens = [];
  const primaryHeight = number(screenObjects.objectAtIndex(0).frame.size.height);

  for (let index = 0; index < number(screenObjects.count); index += 1) {
    const screen = screenObjects.objectAtIndex(index);
    const frame = screen.frame;
    const displayNumber = screen.deviceDescription.objectForKey("NSScreenNumber");
    screens.push({
      id: String(number(displayNumber)),
      x: number(frame.origin.x),
      y: number(frame.origin.y),
      width: number(frame.size.width),
      height: number(frame.size.height),
      scale: number(screen.backingScaleFactor)
    });
  }

  const options = $.kCGWindowListOptionAll | $.kCGWindowListExcludeDesktopElements;
  const records = $.CGWindowListCopyWindowInfo(options, $.kCGNullWindowID);
  const windows = [];

  for (let recordIndex = 0; recordIndex < number(records.count); recordIndex += 1) {
    const record = ObjC.deepUnwrap(records.objectAtIndex(recordIndex));
    const title = String(record.kCGWindowName || "");
    const process = record.kCGWindowOwnerName ? String(record.kCGWindowOwnerName) : null;
    const bounds = record.kCGWindowBounds || {};
    const width = Number(bounds.Width || 0);
    const height = Number(bounds.Height || 0);
    if (Number(record.kCGWindowLayer || 0) !== 0 || process === "WindowManager" || !title || width <= 0 || height <= 0) {
      continue;
    }

    const x = Number(bounds.X || 0);
    const y = Number(bounds.Y || 0);
    const cocoaCenterX = x + (width / 2);
    const cocoaCenterY = primaryHeight - y - (height / 2);
    const screen = screens.find((candidate) =>
      cocoaCenterX >= candidate.x && cocoaCenterX < candidate.x + candidate.width &&
      cocoaCenterY >= candidate.y && cocoaCenterY < candidate.y + candidate.height
    );

    windows.push({
      id: String(record.kCGWindowNumber),
      title,
      process,
      processId: record.kCGWindowOwnerPID == null ? null : Number(record.kCGWindowOwnerPID),
      bounds: { x, y, width, height },
      display: screen ? screen.id : null,
      scale: screen ? screen.scale : null
    });
  }
  return JSON.stringify(windows);
}
`;

const MACOS_ACTIVATE_SCRIPT = String.raw`
function run(argv) {
  const processId = Number(argv[0]);
  const title = argv[1];
  const systemEvents = Application("System Events");
  const matches = systemEvents.applicationProcesses.whose({ unixId: processId })();
  if (matches.length === 0) {
    throw new Error("No application process has pid " + processId + ".");
  }

  const process = matches[0];
  process.frontmost = true;
  const windows = process.windows();
  let selected = null;
  let bestScore = 0;
  for (const window of windows) {
    const currentTitle = String(window.name());
    if (currentTitle === title) {
      selected = window;
      bestScore = Number.POSITIVE_INFINITY;
      break;
    }

    let suffixLength = 0;
    while (
      suffixLength < currentTitle.length
      && suffixLength < title.length
      && currentTitle[currentTitle.length - suffixLength - 1] === title[title.length - suffixLength - 1]
    ) {
      suffixLength += 1;
    }
    if (suffixLength > bestScore) {
      bestScore = suffixLength;
      selected = window;
    }
  }

  if (windows.length === 1 || bestScore >= Math.min(title.length, String(selected ? selected.name() : "").length) / 2) {
    selected = selected || windows[0];
  } else if (bestScore === 0) {
    selected = null;
  }

  if (!selected) {
    throw new Error("The selected process no longer has the requested window.");
  }
  try {
    selected.actions.byName("AXRaise").perform();
  } catch (error) {
  }
  return "ok";
}
`;

function normalizeBounds(value) {
  const bounds = value && typeof value === "object" ? value : {};
  const normalized = {
    x: Number(bounds.x),
    y: Number(bounds.y),
    width: Number(bounds.width),
    height: Number(bounds.height)
  };

  if (!Object.values(normalized).every(Number.isFinite) || normalized.width <= 0 || normalized.height <= 0) {
    return null;
  }

  return normalized;
}

function normalizeWindow(value) {
  const bounds = normalizeBounds(value?.bounds);
  if (!bounds || value?.id === undefined || value?.id === null) {
    return null;
  }

  const processId = value.processId === undefined || value.processId === null
    ? null
    : Number(value.processId);
  const scale = value.scale === undefined || value.scale === null ? null : Number(value.scale);

  return {
    id: String(value.id),
    title: String(value.title || ""),
    process: value.process === undefined || value.process === null ? null : String(value.process),
    processId: Number.isInteger(processId) ? processId : null,
    bounds,
    display: value.display === undefined || value.display === null ? null : String(value.display),
    scale: Number.isFinite(scale) && scale > 0 ? scale : null
  };
}

function normalizeWindows(value) {
  const entries = Array.isArray(value) ? value : [value];
  return entries.filter((entry) => entry?.minimized !== true).map(normalizeWindow).filter(Boolean);
}

function parseJsonWindows(output, label) {
  const text = String(output || "").trim();
  if (!text) {
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw createCommandError(`${label} returned invalid JSON: ${error.message}`, "WINDOW_ENUMERATION_FAILED");
  }

  return normalizeWindows(parsed);
}

function parseLinuxWindows(output) {
  const windows = [];
  for (const line of String(output || "").split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    const match = line.match(/^(\S+)\s+(-?\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/);
    if (!match) {
      continue;
    }

    const [, id, , processId, x, y, width, height, , applicationClass, title] = match;
    const window = normalizeWindow({
      id,
      title,
      process: applicationClass,
      processId: Number(processId),
      bounds: {
        x: Number(x),
        y: Number(y),
        width: Number(width),
        height: Number(height)
      },
      display: null,
      scale: null
    });
    if (window?.title) {
      windows.push(window);
    }
  }
  return windows;
}

function escapePattern(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function createWildcardMatcher(value) {
  const expression = escapePattern(value).replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${expression}$`, "i");
}

function matchByTitle(windows, reference) {
  if (reference.includes("*") || reference.includes("?")) {
    const matcher = createWildcardMatcher(reference);
    return windows.filter((window) => matcher.test(window.title));
  }

  const normalized = reference.toLocaleLowerCase();
  const exact = windows.filter((window) => window.title.toLocaleLowerCase() === normalized);
  return exact.length > 0
    ? exact
    : windows.filter((window) => window.title.toLocaleLowerCase().includes(normalized));
}

function matchByReference(windows, reference) {
  const normalized = reference.toLocaleLowerCase();
  const exactTitle = windows.filter(
    (window) => window.title.toLocaleLowerCase() === normalized
  );
  if (exactTitle.length > 0) {
    return exactTitle;
  }

  const exactProcess = windows.filter(
    (window) => window.process?.toLocaleLowerCase() === normalized
  );
  if (exactProcess.length > 0) {
    return exactProcess;
  }

  const titleMatches = matchByTitle(windows, reference);
  if (titleMatches.length > 0) {
    return titleMatches;
  }

  if (reference.includes("*") || reference.includes("?")) {
    const matcher = createWildcardMatcher(reference);
    return windows.filter((window) => window.process && matcher.test(window.process));
  }

  return windows.filter(
    (window) => window.process?.toLocaleLowerCase().includes(normalized)
  );
}

function normalizeReference(reference) {
  const value = String(reference || "").trim();
  if (!value) {
    throw createCommandError("Window ID or title cannot be empty.", "INVALID_ARGUMENT");
  }
  return value;
}

export function formatWindowDiagnostics(windows, label = "Matching windows") {
  const entries = windows.slice(0, 12).map((window) => {
    const bounds = window.bounds;
    return `- id=${window.id} title=${JSON.stringify(window.title)} process=${window.process || "unknown"} pid=${window.processId ?? "unknown"} bounds=${bounds.x},${bounds.y},${bounds.width}x${bounds.height} display=${window.display ?? "unknown"} scale=${window.scale ?? "unknown"}`;
  });
  if (windows.length > entries.length) {
    entries.push(`- ... ${windows.length - entries.length} more`);
  }
  return `${label}:\n${entries.length > 0 ? entries.join("\n") : "- none"}`;
}

export function selectDiagnosticWindows(windows, reference) {
  const value = normalizeReference(reference).toLocaleLowerCase();
  return windows.filter((window) =>
    window.title.toLocaleLowerCase().includes(value)
    || (window.process && window.process.toLocaleLowerCase().includes(value))
  );
}

export function createWindowController(platform, runner, options = {}) {
  const windowsHost = options.windowsHost || null;

  async function list() {
    if (platform === "win32" && windowsHost) {
      return normalizeWindows(await windowsHost.list());
    }
    if (platform === "win32") {
      return parseJsonWindows(
        await runner("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_LIST_SCRIPT], "List windows"),
        "Window enumeration"
      );
    }
    if (platform === "darwin") {
      return parseJsonWindows(
        await runner("/usr/bin/osascript", ["-l", "JavaScript", "-e", MACOS_LIST_SCRIPT], "List windows"),
        "Window enumeration"
      );
    }
    if (platform === "linux") {
      return parseLinuxWindows(await runner("wmctrl", ["-lpGx"], "List windows"));
    }

    throw createCommandError(`Window management is not supported on ${platform}.`, "UNSUPPORTED_PLATFORM");
  }

  async function resolve(reference, mode = "any") {
    const value = normalizeReference(reference);
    const windows = await list();
    let matches = [];

    if (mode !== "title") {
      matches = windows.filter((window) => window.id.toLocaleLowerCase() === value.toLocaleLowerCase());
    }
    if (matches.length === 0 && mode !== "id") {
      matches = mode === "title"
        ? matchByTitle(windows, value)
        : matchByReference(windows, value);
    }

    if (matches.length === 0) {
      const candidates = selectDiagnosticWindows(windows, value);
      const available = candidates.length > 0 ? candidates : windows;
      throw createCommandError(
        `No window matched ${JSON.stringify(value)}.\n${formatWindowDiagnostics(available, candidates.length > 0 ? "Related windows" : "Available windows")}`,
        "WINDOW_NOT_FOUND"
      );
    }
    if (matches.length > 1) {
      throw createCommandError(
        `Window reference ${JSON.stringify(value)} is ambiguous. Use --id.\n${formatWindowDiagnostics(matches)}`,
        "WINDOW_AMBIGUOUS"
      );
    }

    return matches[0];
  }

  async function activate(reference, mode = "any") {
    const window = reference && typeof reference === "object"
      ? normalizeWindow(reference)
      : await resolve(reference, mode);
    if (!window) {
      throw createCommandError("Cannot activate an invalid window record.", "WINDOW_ACTIVATION_FAILED");
    }

    try {
      if (platform === "win32") {
        if (windowsHost) {
          await windowsHost.activate(window.id);
        } else {
          await runner(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-Command", createWindowsActivateScript(window.id)],
            "Activate window"
          );
        }
      } else if (platform === "darwin") {
        if (window.processId === null) {
          throw createCommandError("macOS window activation requires a process ID.", "WINDOW_ACTIVATION_FAILED");
        }
        await runner(
          "/usr/bin/osascript",
          ["-l", "JavaScript", "-e", MACOS_ACTIVATE_SCRIPT, String(window.processId), window.title],
          "Activate window"
        );
      } else if (platform === "linux") {
        await runner("wmctrl", ["-ia", window.id], "Activate window");
      } else {
        throw createCommandError(`Window management is not supported on ${platform}.`, "UNSUPPORTED_PLATFORM");
      }
    } catch (error) {
      if (error?.code === "UNSUPPORTED_PLATFORM") {
        throw error;
      }
      throw createCommandError(
        `Failed to activate window ${window.id}: ${error?.message || String(error)}\n${formatWindowDiagnostics([window], "Selected window")}`,
        "WINDOW_ACTIVATION_FAILED"
      );
    }

    return resolve(window.id, "id");
  }

  async function dispose() {
    if (windowsHost && typeof windowsHost.dispose === "function") {
      await windowsHost.dispose();
    }
  }

  return { list, resolve, activate, dispose };
}
