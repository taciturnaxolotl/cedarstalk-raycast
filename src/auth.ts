import { environment, LocalStorage, showToast, Toast } from "@raycast/api";
import { exec, execFile, spawn } from "child_process";
import { mkdir, readFile, rm, stat, symlink, unlink, writeFile } from "fs/promises";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const COOKIE_KEY = "session_cookie";
// Set once a sign-in has succeeded, so we know a silent renewal is worth trying
// before falling back to the sign-in screen.
const SSO_KEY = "sso_established";

const COOKIE_FILE = path.join(environment.supportPath, "auth-cookie.txt");
// The auth browser's saved session. Owner-only; the helper writes it 0600.
const JAR_FILE = path.join(environment.supportPath, "sso-jar.json");

// ─── Cookie storage ────────────────────────────────────────────────────────

export async function getStoredCookie(): Promise<string | undefined> {
  return LocalStorage.getItem<string>(COOKIE_KEY);
}

export async function storeCookie(cookie: string): Promise<void> {
  await LocalStorage.setItem(COOKIE_KEY, cookie);
  await LocalStorage.setItem(SSO_KEY, true);
}

export async function clearCookie(): Promise<void> {
  await LocalStorage.removeItem(COOKIE_KEY);
}

export async function hasSignedInBefore(): Promise<boolean> {
  return (await LocalStorage.getItem<boolean>(SSO_KEY)) === true;
}

// Full sign-out: the app cookie, the memory that SSO was ever set up, and the
// SSO session itself.
export async function signOut(): Promise<void> {
  await LocalStorage.removeItem(COOKIE_KEY);
  await LocalStorage.removeItem(SSO_KEY);
  await clearAuthBrowserSession();
}

// If Raycast closed mid-auth but the Swift app finished and wrote the cookie,
// pick it up on the next open and delete it from disk.
export async function drainPendingCookie(): Promise<string | undefined> {
  try {
    const cookie = (await readFile(COOKIE_FILE, "utf-8")).trim();
    await unlink(COOKIE_FILE).catch(() => {});
    if (cookie) return cookie;
  } catch {
    // file doesn't exist — nothing pending
  }
}

// ─── Auth browser ──────────────────────────────────────────────────────────

// Raised when a silent refresh reaches a page that wants the user (password,
// MFA prompt) — the caller should fall back to a visible sign-in.
export class InteractionRequiredError extends Error {
  constructor() {
    super("Sign-in needs your input.");
    this.name = "InteractionRequiredError";
  }
}

// Opens an isolated WKWebView window via a temporary .app bundle so macOS
// grants it proper window-server access via Launch Services.
//
// The Swift source in assets/auth-browser.swift is compiled on first launch
// and cached in supportPath — no pre-built binary is shipped with the
// extension. Compilation requires the Xcode Command Line Tools (swiftc).
export async function launchAuthBrowser(options?: {
  silent?: boolean;
}): Promise<string> {
  await unlink(COOKIE_FILE).catch(() => {});
  // Pre-create with owner-only permissions so the cookie is never world-readable.
  // Swift writes non-atomically to preserve these permissions.
  await writeFile(COOKIE_FILE, "", { mode: 0o600 });

  await runBrowser([
    COOKIE_FILE,
    "--jar",
    JAR_FILE,
    ...(options?.silent ? ["--silent"] : []),
  ]);

  const cookie = await readFile(COOKIE_FILE, "utf-8")
    .then((s) => s.trim())
    .catch(() => "");
  await unlink(COOKIE_FILE).catch(() => {});

  // `open -W` swallows the helper's exit code, so the cookie file is the only
  // signal. Silently failing means the SSO session needs the user.
  if (cookie) return cookie;
  throw options?.silent
    ? new InteractionRequiredError()
    : new Error("Sign-in cancelled.");
}

// Re-auth without a window. Works whenever the SSO session behind the app's
// own cookie is still alive, which is the common case — the app cookie expires
// in hours, the SSO session in months.
export async function refreshCookieSilently(): Promise<string | undefined> {
  try {
    const cookie = await launchAuthBrowser({ silent: true });
    await storeCookie(cookie);
    return cookie;
  } catch {
    return undefined;
  }
}

// Drops the SSO session the auth browser keeps, so signing out is real.
export async function clearAuthBrowserSession(): Promise<void> {
  await runBrowser(["--jar", JAR_FILE, "--logout"]).catch(() => {});
  await unlink(JAR_FILE).catch(() => {});
}

async function runBrowser(args: string[]): Promise<void> {
  const binaryPath = await ensureBinary();
  const appBundle = await ensureAppBundle(binaryPath);

  return new Promise<void>((resolve, reject) => {
    const proc = spawn("open", ["-n", "-W", appBundle, "--args", ...args], {
      stdio: "ignore",
    });
    proc.on("close", () => resolve());
    proc.on("error", reject);
  });
}

// Compile assets/auth-browser.swift on first launch; cache in supportPath.
// Recompiles automatically if the Swift source is newer than the cached binary
// (e.g. after an extension update or a stale binary from a previous approach).
async function ensureBinary(): Promise<string> {
  const binaryPath = path.join(environment.supportPath, "auth-browser");
  const swiftSrc = path.join(environment.assetsPath, "auth-browser.swift");
  try {
    const [binStat, srcStat] = await Promise.all([
      stat(binaryPath),
      stat(swiftSrc),
    ]);
    if (binStat.mtimeMs >= srcStat.mtimeMs) return binaryPath;
    // source is newer — fall through to recompile
  } catch {
    // binary doesn't exist yet — fall through to compile
  }

  const hasSwiftc = await execAsync("xcrun --find swiftc")
    .then(() => true)
    .catch(() => false);
  if (!hasSwiftc) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Xcode Command Line Tools required",
      message: "Run `xcode-select --install` in Terminal, then try again.",
    });
    throw new Error("swiftc not found — install Xcode Command Line Tools");
  }

  await mkdir(environment.supportPath, { recursive: true });

  const toast = await showToast({
    style: Toast.Style.Animated,
    title: "Compiling sign-in helper…",
  });
  try {
    // Use `xcrun swiftc` (not the raw path) so xcrun sets up DEVELOPER_DIR and
    // the correct SDK — running the swiftc binary directly loses that context.
    await execFileAsync("xcrun", ["swiftc", "-O", swiftSrc, "-o", binaryPath]);
  } finally {
    await toast.hide();
  }

  return binaryPath;
}

async function ensureAppBundle(binaryPath: string): Promise<string> {
  const appDir = path.join(os.tmpdir(), "CedarvilleAuth.app");
  const macosDir = path.join(appDir, "Contents", "MacOS");
  const plistPath = path.join(appDir, "Contents", "Info.plist");
  const bundledBinary = path.join(macosDir, "auth-browser");

  // Always recreate fresh so Launch Services sees a new bundle.
  await rm(appDir, { recursive: true, force: true }).catch(() => {});
  await mkdir(macosDir, { recursive: true });
  await symlink(binaryPath, bundledBinary);

  await writeFile(
    plistPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundlePackageType</key><string>APPL</string>
\t<key>CFBundleExecutable</key><string>auth-browser</string>
\t<key>CFBundleIdentifier</key><string>sh.dunkirk.cedarville-people-search.auth</string>
\t<key>CFBundleName</key><string>Cedarville Auth</string>
\t<key>NSPrincipalClass</key><string>NSApplication</string>
\t<key>NSHighResolutionCapable</key><true/>
\t<key>LSMinimumSystemVersion</key><string>13.0</string>
</dict>
</plist>`,
  );

  return appDir;
}
