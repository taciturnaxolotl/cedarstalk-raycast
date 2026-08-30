// Shared bits for the scripts/ tools: getting a session cookie out of the
// extension's own auth helper, and talking to the directory endpoint.

import { spawn } from "child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "fs/promises";
import * as os from "os";
import * as path from "path";

export const BASE_URL = "https://selfservice.cedarville.edu";

const SUPPORT = path.join(
  os.homedir(),
  "Library/Application Support/com.raycast.macos/extensions/cedarville-people-search",
);

export class AuthExpiredError extends Error {
  constructor() {
    super("session expired");
    this.name = "AuthExpiredError";
  }
}

// Builds a throwaway .app around the extension's cached auth-browser binary and
// runs it, same as src/auth.ts does. Silent first; a visible window only if the
// SSO session actually needs a human.
export async function mintCookie({ log = console.error } = {}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "cedar-"));
  const app = path.join(tmp, "CedarvilleAuth.app");
  const macos = path.join(app, "Contents", "MacOS");
  await mkdir(macos, { recursive: true });
  await symlink(path.join(SUPPORT, "auth-browser"), path.join(macos, "auth-browser"));
  await writeFile(
    path.join(app, "Contents", "Info.plist"),
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

  const cookieFile = path.join(tmp, "cookie.txt");
  await writeFile(cookieFile, "", { mode: 0o600 });
  const jar = path.join(SUPPORT, "sso-jar.json");

  try {
    for (const silent of [true, false]) {
      await new Promise((resolve, reject) => {
        const args = ["-n", "-W", app, "--args", cookieFile, "--jar", jar];
        if (silent) args.push("--silent");
        const p = spawn("open", args, { stdio: "ignore" });
        p.on("close", resolve);
        p.on("error", reject);
      });
      const cookie = (await readFile(cookieFile, "utf-8")).trim();
      if (cookie) return cookie;
      if (silent) log("silent refresh failed, opening the sign-in window…");
    }
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
  throw new Error("could not get a session cookie — sign in from Raycast once, then retry");
}

const headers = (cookie) => ({
  accept: "*/*",
  "accept-language": "en-US,en;q=0.9",
  referer: `${BASE_URL}/cedarinfo/directory`,
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
  cookie,
});

// One directory query. `params` takes any of FirstNameSearch, LastNameSearch,
// Department, PopulationSearch. Retries transient failures; throws
// AuthExpiredError the moment the server starts redirecting us to SSO.
export async function search(cookie, params, { retries = 3 } = {}) {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== ""),
  );
  const url = `${BASE_URL}/CedarInfo/Directory/SearchResultsJson?${qs}`;

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await sleep(400 * 2 ** (attempt - 1));
    try {
      const res = await fetch(url, { headers: headers(cookie) });
      if (!res.url.includes("selfservice.cedarville.edu")) throw new AuthExpiredError();
      if (res.status === 401 || res.status === 403) throw new AuthExpiredError();
      if (!res.ok) {
        lastError = new Error(`HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      if (!Array.isArray(data)) throw new AuthExpiredError();
      return data;
    } catch (e) {
      if (e instanceof AuthExpiredError) throw e;
      lastError = e;
    }
  }
  throw lastError ?? new Error("request failed");
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
