import Cocoa
import WebKit
import Foundation

let TARGET_HOST = "selfservice.cedarville.edu"
let AUTH_COOKIES: Set<String> = [".ASPXAUTH", "studentselfservice_live"]
let SIGN_IN_URL = URL(string: "https://selfservice.cedarville.edu/cedarinfo/directory")!

// usage: auth-browser <cookie-file> --jar <jar-file> [--silent]
//        auth-browser --jar <jar-file> --logout
//
// exit codes: 0 = cookie written, 1 = cancelled, 2 = needs user interaction
let ARGS = Array(CommandLine.arguments.dropFirst())
let COOKIE_FILE = ARGS.first { !$0.hasPrefix("--") } ?? ""
let SILENT = ARGS.contains("--silent")
let LOGOUT = ARGS.contains("--logout")
let JAR_FILE = ARGS.firstIndex(of: "--jar").flatMap { i in
    i + 1 < ARGS.count ? ARGS[i + 1] : nil
} ?? ""

// Give up on a silent refresh rather than leave an invisible window spinning.
let SILENT_TIMEOUT: TimeInterval = 12

// How long a restored session cookie is allowed to live. Entra issues its
// session cookie with no expiry, meaning "until the browser quits" — which for
// a helper that quits every run means every sign-in is a fresh one. Giving it a
// real expiry is the whole point of the jar.
let SESSION_COOKIE_TTL: TimeInterval = 30 * 24 * 60 * 60

// Runs after each navigation: skips the account picker where it can, and
// reports whether the page has started asking the user for something.
let PROBE_JS = """
(function () {
  // "Pick an account" — reload with a login_hint instead of clicking the tile.
  // Entra ignores synthetic clicks on its Knockout bindings, but it honours the
  // hint and skips the picker. Only for a single remembered account; more than
  // one is a real choice and belongs to the user.
  if (document.getElementById('tilesHolder') && location.href.indexOf('login_hint=') === -1) {
    // Each tile also carries a "<upn>-menu-dots" sibling; only the tile counts.
    var tiles = Array.prototype.filter.call(
      document.querySelectorAll('#tilesHolder [data-test-id*="@"]'),
      function (t) { return !/-menu-dots$/.test(t.getAttribute('data-test-id')); }
    );
    if (tiles.length !== 1) return 'interactive';
    location.assign(
      location.href + '&login_hint=' + encodeURIComponent(tiles[0].getAttribute('data-test-id'))
    );
    return 'hinted';
  }

  var input = document.querySelector(
    'input[type=password], input[name=loginfmt], input[type=email], input[type=tel]'
  );
  return input ? 'interactive' : 'wait';
})()
"""

// ─── Cookie jar ────────────────────────────────────────────────────────────
//
// The helper's own WebKit store keeps persistent cookies, but Entra's session
// cookie is not one of them, so it dies with the process and every launch
// starts from a password prompt. Saving the jar on the way out and restoring it
// on the way in is what makes a sign-in last.

func saveJar(_ store: WKHTTPCookieStore, then done: @escaping () -> Void) {
    guard !JAR_FILE.isEmpty else { return done() }
    store.getAllCookies { cookies in
        // Only the SSO session belongs here. Keeping the site's own cookie
        // would mean a refresh could hand back the very cookie that just
        // expired, so it is always re-derived from a fresh assertion.
        let items: [[String: Any]] = cookies.filter { !$0.domain.contains(TARGET_HOST) }.map { c in
            var item: [String: Any] = [
                "name": c.name,
                "value": c.value,
                "domain": c.domain,
                "path": c.path,
                "secure": c.isSecure,
            ]
            if let expires = c.expiresDate {
                item["expires"] = expires.timeIntervalSince1970
            }
            return item
        }
        if let data = try? JSONSerialization.data(withJSONObject: items) {
            // Live session cookies — owner-only, always.
            FileManager.default.createFile(
                atPath: JAR_FILE,
                contents: data,
                attributes: [.posixPermissions: 0o600]
            )
        }
        done()
    }
}

func restoreJar(_ store: WKHTTPCookieStore, then done: @escaping () -> Void) {
    guard !JAR_FILE.isEmpty,
          let data = FileManager.default.contents(atPath: JAR_FILE),
          let items = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]]
    else { return done() }

    let fallbackExpiry = Date().addingTimeInterval(SESSION_COOKIE_TTL)
    let group = DispatchGroup()
    for item in items {
        guard let name = item["name"] as? String,
              let value = item["value"] as? String,
              let domain = item["domain"] as? String,
              let path = item["path"] as? String
        else { continue }

        var props: [HTTPCookiePropertyKey: Any] = [
            .name: name, .value: value, .domain: domain, .path: path,
        ]
        if item["secure"] as? Bool == true { props[.secure] = "TRUE" }
        props[.expires] = (item["expires"] as? TimeInterval)
            .map { Date(timeIntervalSince1970: $0) } ?? fallbackExpiry

        guard let cookie = HTTPCookie(properties: props) else { continue }
        group.enter()
        store.setCookie(cookie) { group.leave() }
    }
    group.notify(queue: .main, execute: done)
}

class CookieObserver: NSObject, WKHTTPCookieStoreObserver {
    weak var browser: AuthBrowser?
    func cookiesDidChange(in cookieStore: WKHTTPCookieStore) {
        browser?.checkCookies(in: cookieStore)
    }
}

class AuthBrowser: NSObject, NSApplicationDelegate, WKNavigationDelegate, NSWindowDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var cookieObserver: CookieObserver!
    var didComplete = false

    func applicationDidFinishLaunching(_: Notification) {
        if LOGOUT {
            wipeAndExit()
            return
        }

        let wkConfig = WKWebViewConfiguration()
        // Persistent rather than ephemeral so the store keeps what it can on
        // its own. It is not enough by itself — Entra issues its session cookie
        // with no expiry, which WebKit drops on exit — hence the jar below.
        wkConfig.websiteDataStore = .default()

        cookieObserver = CookieObserver()
        cookieObserver.browser = self
        wkConfig.websiteDataStore.httpCookieStore.add(cookieObserver)

        let rect = NSRect(x: 0, y: 0, width: 520, height: 700)
        webView = WKWebView(frame: rect, configuration: wkConfig)
        webView.navigationDelegate = self
        webView.autoresizingMask = [.width, .height]

        window = NSWindow(
            contentRect: rect,
            styleMask: [.titled, .closable, .resizable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Cedarville People Search — Sign In"
        window.contentView = webView
        window.delegate = self
        window.center()

        if SILENT {
            DispatchQueue.main.asyncAfter(deadline: .now() + SILENT_TIMEOUT) { [weak self] in
                guard let self, !self.didComplete else { return }
                exit(2)
            }
        } else {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }

        // Load only once the saved session is back in the store, or the first
        // request goes out unauthenticated and Entra shows a password prompt.
        restoreJar(wkConfig.websiteDataStore.httpCookieStore) { [weak self] in
            self?.webView.load(URLRequest(url: SIGN_IN_URL))
        }
    }

    func webView(_ webView: WKWebView, didFinish _: WKNavigation!) {
        checkCookies(in: webView.configuration.websiteDataStore.httpCookieStore)
        webView.evaluateJavaScript(PROBE_JS) { [weak self] result, _ in
            guard let self, !self.didComplete else { return }
            // A silent refresh only works while the page needs nothing from the
            // user; hand back to the caller the moment it does.
            if SILENT, result as? String == "interactive" { exit(2) }
        }
    }

    func checkCookies(in cookieStore: WKHTTPCookieStore) {
        guard !didComplete else { return }
        cookieStore.getAllCookies { [weak self] all in
            guard let self, !self.didComplete else { return }
            let site = all.filter { $0.domain.contains(TARGET_HOST) }
            guard site.contains(where: { AUTH_COOKIES.contains($0.name) }) else { return }

            self.didComplete = true
            let cookieStr = site.map { "\($0.name)=\($0.value)" }.joined(separator: "; ")
            // Write non-atomically so the pre-created 0o600 permissions are preserved.
            try? cookieStr.write(toFile: COOKIE_FILE, atomically: false, encoding: .utf8)
            saveJar(cookieStore) { exit(0) }
        }
    }

    // Sign-out has to clear the SSO session too, or "sign out" only means
    // "forget the cookie until the next silent refresh puts it back".
    func wipeAndExit() {
        if !JAR_FILE.isEmpty { try? FileManager.default.removeItem(atPath: JAR_FILE) }
        let store = WKWebsiteDataStore.default()
        store.removeData(
            ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(),
            modifiedSince: .distantPast
        ) { exit(0) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { exit(0) }
    }

    // Exit is ours to call — the jar has to be written first.
    func applicationShouldTerminateAfterLastWindowClosed(_: NSApplication) -> Bool { false }

    func windowWillClose(_: Notification) {
        guard !didComplete else { return }
        // Keep whatever progress was made: a half-finished sign-in still leaves
        // a session worth reusing next time.
        saveJar(webView.configuration.websiteDataStore.httpCookieStore) { exit(1) }
    }
}

let app = NSApplication.shared
let delegate = AuthBrowser()
app.setActivationPolicy(LOGOUT || SILENT ? .accessory : .regular)
app.delegate = delegate
app.run()
