# Bond Security Review (Code Audit Report)

Date: 2026-04-08  
Scope: Repository as checked in, no runtime testing, no changes to code.

This report focuses on security properties that follow from Bond’s architecture:

Renderer (Vue) → Electron IPC → Main process → Unix socket (JSON-RPC 2.0 over WebSocket) → Daemon → Claude Agent SDK / local storage

The biggest risks are at trust boundaries: the daemon socket, renderer privileges exposed via `window.bond`, embedded browser/webview, and operatives (background agents with tool access).

---

## Executive summary

### Highest-risk findings

1. **Unauthenticated daemon socket (`~/.bond/bond.sock`)** enables any local process that can connect to issue privileged RPCs (**Critical**).
2. **Renderer compromise becomes local file access** via broad IPC surface (`file:read`, `image:readLocal`, etc.) (**Critical**).
3. **Operatives are an effective RCE primitive** when invoked through the daemon RPC surface because they run with permission bypass and allow `Bash/Edit/Write` by default (**Critical**).
4. **In-app browser automation supports JS exec/cookies/download**, allowing credentialed content access and disk writes; coupled with (1), it’s a high-value exfiltration vector (**High/Critical**, threat-model dependent).

### What this means

If your threat model includes **untrusted local software** (common on developer machines), or if there’s any plausible path to **renderer compromise** (XSS, supply chain, vulnerable dependency, malicious artifact), the current design can be leveraged for:

- Reading sensitive local files and screenshots
- Exfiltrating authenticated web content and cookies from the embedded browser
- Running arbitrary shell commands (via operatives)

---

## Threat model assumptions

This review assumes the following adversaries may exist:

- **Local attacker process**: malware or another app running under the same user account (or with access to the user’s home directory) that can reach `~/.bond/bond.sock`.
- **Renderer compromise**: any XSS-like issue or unsafe HTML execution path that allows arbitrary JS in the renderer.
- **Malicious web content**: a hostile page loaded inside the in-app browser/webview.
- **Prompt-injection / model output adversary**: the model can output untrusted instructions, markdown, or artifacts.

This review does **not** assume a remote network attacker can directly connect to the daemon socket, but local malware is a realistic threat for desktop apps that manage sensitive data.

---

## Architecture & trust boundaries (observed)

### Renderer / Preload / Main

- `window.bond` is exposed to the renderer via `contextBridge.exposeInMainWorld` (`src/preload/index.ts`).
- Many `window.bond.*` methods are privileged: file reads, browser webContents registration, JS execution in webviews, Sense controls, and CRUD over all user data.
- Main process uses `ipcMain.handle(...)` to service those calls (`src/main/index.ts`), and forwards many of them to the daemon through `BondClient` over the Unix socket.

### Daemon JSON-RPC server

- Daemon creates a WebSocket server and listens on a Unix socket path (`src/daemon/server.ts`, `src/daemon/main.ts`).
- The server accepts any WebSocket client, parses JSON, and dispatches based on `method`.
- No authentication/authorization is performed at connection time or per-method.

### Embedded browser/webview

- Main window sets:
  - `webviewTag: true`
  - `sandbox: false`
  - `contextIsolation: true`
  (`src/main/index.ts`)
- Renderer implements the browser UI with `<webview partition="persist:browser" allowpopups ... />` (`src/renderer/components/BrowserView.vue`).
- The daemon can send `browser.*` commands to the renderer (notification channel) and receive results via RPC (`src/daemon/server.ts` + `src/main/browser.ts` + `src/renderer/components/BrowserView.vue`).

### Operatives (background agents)

- Daemon can spawn operatives via RPC (`operative.spawn` in `src/daemon/server.ts`).
- Operatives run the Agent SDK with:
  - `permissionMode: 'bypassPermissions'`
  - default tools include `Bash`, `Edit`, `Write` (`src/daemon/operatives.ts`)

---

## Findings (prioritized)

Severity scale used here:

- **Critical**: practical compromise of user data or code execution with minimal prerequisites.
- **High**: serious compromise requiring additional preconditions or reduced impact.
- **Medium**: meaningful weakness; likely requires chaining or has bounded impact.
- **Low**: hard to exploit or small impact, but worth tracking.

### 1) Unauthenticated daemon socket allows arbitrary privileged RPC calls (Critical)

**Evidence**

- Daemon listens on `~/.bond/bond.sock` and accepts connections without auth (`src/daemon/server.ts` / `startServer`).
- There is no token, challenge/response, or peer identity validation.

**Impact**

Any local process that can open the socket can:

- Read/modify all user content: sessions, messages, todos, projects, collections, journal.
- Access Sense captures and base64 screenshots (`sense.capture` returns `{ capture, image }`).
- Drive the in-app browser (open, navigate, read, screenshot, exec, cookies, download).
- Spawn operatives (see Finding #3).

**Exploit scenario**

Malware running as the user connects to the socket and issues JSON-RPC calls to:

- Dump screenshots and OCR text via `sense.*`
- Exfiltrate data via browser commands or by spawning an operative that runs `curl`, etc.

**Recommended mitigations**

- Add **connection authentication**:
  - Generate a random secret, store with strict perms (e.g. 0600), require clients to present it (header, initial RPC method, or URL token).
- Ensure directory perms:
  - `~/.bond` should be `0700` and the socket should be restricted to the same user.
- Consider **peer credential checks** where available (platform-specific).
- Add **per-method authorization** and/or opt-in for especially risky methods (operatives, browser exec/cookies/download).

---

### 2) Renderer compromise ⇒ local file read via IPC (Critical)

**Evidence**

- `file:read` reads arbitrary paths:
  - `ipcMain.handle('file:read', ... readFileSync(filePath, 'utf-8'))` (`src/main/index.ts`)
- `image:readLocal` reads arbitrary local images to base64:
  - `readFileSync(filePath).toString('base64')` (`src/main/index.ts`)
- `MarkdownMessage.vue` resolves any markdown `<img src="/absolute/path.png">` by calling `window.bond.readLocalImage(...)` and replacing `img.src` with a data URI (`src/renderer/components/MarkdownMessage.vue`).

**Impact**

If arbitrary JS runs in the renderer (XSS or malicious artifact influence), the attacker can read local files and exfiltrate them. Even without XSS, the model can induce loading of arbitrary image files if the path exists and matches allowed extensions.

**Exploit scenario**

- Attacker gains renderer JS execution → calls `window.bond.readFile('~/.ssh/config')` (or other secrets) → sends content off-device.

**Recommended mitigations**

- Remove or sharply scope `file:read` (use file picker + scoped handles instead of arbitrary path reads).
- Restrict `readLocalImage` to known attachment directories or explicit user-selected files.
- Disable automatic local absolute path image resolution in markdown, or require an explicit user gesture/approval.

---

### 3) Operatives are an RCE-capable primitive via daemon RPC (Critical)

**Evidence**

- RPC method `operative.spawn` validates only that `name`, `prompt`, and `workingDir` exist (`src/daemon/server.ts`).
- Operatives run with:
  - `permissionMode: 'bypassPermissions'`
  - default tools include `Bash`, `Edit`, `Write` (`src/daemon/operatives.ts`).

**Impact**

Any actor with daemon socket access can trigger:

- Arbitrary shell command execution (`Bash`)
- Arbitrary file writes/edits (`Write/Edit`)
- Repository modifications and credential scraping (depending on environment)

**Exploit scenario**

- Local attacker connects to daemon socket → calls `operative.spawn` with a prompt that runs `Bash` to install persistence or exfiltrate secrets.

**Recommended mitigations**

- Require explicit user approval for operative spawn (and for specific tool use inside operatives).
- Do not use `bypassPermissions` by default; require approvals for write/Bash.
- Enforce allowlisted working directories for operatives.

---

### 4) In-app browser automation enables JS exec, cookie access, and credentialed downloads (High/Critical)

**Evidence**

The daemon exposes browser RPC methods (see `src/daemon/server.ts` `case 'browser.*'`). The renderer implements command execution:

- `browser.exec`: runs arbitrary JS in the webview (`webview.executeJavaScript`) (`src/renderer/components/BrowserView.vue`).
- `browser.cookies`: returns `document.cookie` and current URL.
- `browser.download`: fetches a URL using the webview’s session with `credentials: 'same-origin'`, base64-encodes the response in-page, returns it to daemon; daemon writes it to disk, with optional `outPath` (`src/renderer/components/BrowserView.vue`, `src/daemon/server.ts`).

Main process also supports:

- `browser:execInTab` → `webContents.executeJavaScript(js)` for the tab (`src/main/browser.ts`).

**Impact**

With daemon access (Finding #1), attacker can:

- Extract cookies from authenticated sessions (as far as `document.cookie` allows).
- Read page text/DOM from logged-in pages.
- Download authenticated resources and write them to disk (potential arbitrary path write if `outPath` is not constrained).

**Recommended mitigations**

- Gate browser methods behind user approvals (especially `exec`, `cookies`, `download`).
- Restrict or remove `outPath` for downloads; always write to an app-controlled temp directory and return the path.
- Reassess Electron settings (`webviewTag`, `sandbox`) and consider hardening webview permissions.

---

### 5) Electron main window uses `sandbox: false` and enables `webviewTag` (High)

**Evidence**

- `webPreferences: { contextIsolation: true, sandbox: false, webviewTag: true }` (`src/main/index.ts`).

**Impact**

These settings increase the blast radius of any renderer compromise and increase risk when embedding untrusted web content. While `contextIsolation: true` is good, disabling sandbox and enabling webviews is typically a risky configuration.

**Recommended mitigations**

- Avoid `sandbox: false` unless there is a strong compatibility reason.
- Consider removing `webviewTag` and using safer browser embedding patterns if feasible.

---

### 6) Artifacts run arbitrary HTML+JS in an iframe, and can trigger privileged actions via postMessage (High)

**Evidence**

- Artifacts are rendered via iframe `srcdoc`, with `sandbox="allow-scripts"` (`src/renderer/components/ArtifactFrame.vue`).
- The parent listens to `postMessage` events and supports:
  - `bond:openExternal` → `window.bond.openExternal(url)`
  - `bond:createTodo` → `window.bond.createTodo(...)`
  - `bond:copyText` → clipboard write
- The only check is `e.source === iframe.contentWindow` (no additional allowlist of message types beyond a simple switch, no rate limiting).
- Tailwind is loaded from a CDN (`https://cdn.tailwindcss.com`) inside the iframe.

**Impact**

Even with iframe sandboxing, artifacts can:

- Spam privileged commands (open many URLs, create many todos).
- Phish or mislead the user with UI that appears “in-app”.
- Expand the supply chain surface by relying on CDN code at runtime.

**Recommended mitigations**

- Consider removing `allow-scripts` by default, or introducing an explicit “interactive artifact” mode that requires user approval.
- Rate-limit and validate postMessage commands (length checks, allowlist URLs, etc.).
- Bundle required CSS locally (avoid runtime CDN dependencies in production).

---

### 7) Sense redaction/retention is best-effort and may retain sensitive text (Medium/High)

**Evidence**

- Blacklist is bundle-id based plus window-title heuristics for private browsing (`src/daemon/sense/privacy.ts`).
- Redaction is regex-based with limited patterns; drops entire frame only on Luhn-valid card + payment keywords (`src/daemon/sense/redaction.ts`).
- Retention cleanup can purge images but keep `text_content` (`purgeOldImages` comment: “keep text_content”) (`src/daemon/sense/storage.ts`).

**Impact**

- OCR/accessibility text can contain sensitive information even when screenshots are purged.
- Regex redaction can miss secrets or sensitive identifiers.

**Recommended mitigations**

- Provide a stricter privacy mode that drops more frames and/or purges text along with images.
- Expand redaction patterns and add stronger detectors.
- Ensure Sense access is guarded by daemon auth (ties back to Finding #1).

---

### 8) Markdown sanitization appears reasonable, but local-image auto-resolution increases privacy risk (Medium)

**Evidence**

- `marked` output is sanitized with DOMPurify (`src/renderer/components/MarkdownMessage.vue`, `src/renderer/components/MessageBubble.vue`).
- Local absolute-path images are automatically read and embedded (`MarkdownMessage.vue`).

**Impact**

Even without XSS, the model can cause the app to read and display local images by referencing absolute paths, if present and with allowed extensions. That content may then be exfiltrated through other channels.

**Recommended mitigations**

- Disable auto-resolution of local absolute paths, or restrict to explicitly attached images.

---

## Additional observations

### Positive security notes

- `shell:openExternal` restricts to `http://` and `https://` (`src/main/index.ts`), reducing obvious `file://` or `javascript:` abuse.
- Markdown is sanitized using DOMPurify before being inserted with `v-html`.

### Areas to review further (outside this static review)

- Dependency audit (`npm audit`, SCA) and Electron hardening best practices for your target versions.
- Actual filesystem permissions for `~/.bond` and `~/Library/Application Support/bond` in production.
- Whether any renderer code path can be influenced to execute arbitrary JS (beyond artifacts) via a DOMPurify bypass or an injection bug.

---

## Recommended remediation roadmap (prioritized)

1. **Daemon socket auth + strict permissions** (block local attacker).
2. **Add approvals/ACLs for operatives and browser automation** (block RCE and exfil).
3. **Reduce renderer privilege**:
   - remove generic `file:read`
   - restrict `readLocalImage`
4. **Harden Electron configuration** (avoid `sandbox: false`, reevaluate `webviewTag`).
5. **Harden artifacts**:
   - limit `allow-scripts`
   - rate-limit postMessage commands
   - remove CDN dependency
6. **Improve Sense privacy controls** (strict retention + stronger redaction options).

---

## Appendix: High-risk code surfaces referenced

- `src/daemon/server.ts`: JSON-RPC dispatch; no auth; Sense + browser + operative methods.
- `src/daemon/operatives.ts`: `permissionMode: 'bypassPermissions'`, default tools include `Bash/Edit/Write`.
- `src/main/index.ts`: IPC handlers for file reads, local image reads, browser exec, and Electron webPreferences.
- `src/preload/index.ts`: full `window.bond` API exposed to renderer.
- `src/renderer/components/BrowserView.vue`: webview usage; command handler includes exec/cookies/download.
- `src/renderer/components/ArtifactFrame.vue`: iframe `allow-scripts` + postMessage privileged actions.
- `src/renderer/components/MarkdownMessage.vue`: markdown → DOMPurify sanitize; local image path resolution.