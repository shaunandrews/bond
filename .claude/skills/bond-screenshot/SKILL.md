---
name: bond-screenshot
description: Capture a screenshot of the running Bond Electron app to verify UI changes, debug layout issues, or confirm visual fixes. Use proactively after making visual changes to Bond.
---

# Bond Screenshot

Capture the Bond app's current state without interrupting the user.

## How It Works

Bond's main process watches for a trigger file. When `/tmp/bond-capture` appears, it captures the BrowserWindow contents via `webContents.capturePage()` and writes the result to `/tmp/bond-screenshot.png`. No macOS screen recording permission needed — it reads from Electron's own render pipeline.

## Taking a Screenshot

```bash
touch /tmp/bond-capture && sleep 1
```

Then read the result:

```
Read /tmp/bond-screenshot.png
```

## Limitations

- **No native window chrome.** The screenshot captures web contents only — you CANNOT see macOS traffic lights, title bar frame, or any native UI. Do not claim to verify alignment with native elements from these screenshots. If alignment with native chrome matters, ask the user to check.
- **The app must be running.** If the screenshot file doesn't appear or is stale, the app may not be running or may need a restart (main process changes require restart; renderer changes hot-reload).
- **Wait for HMR.** After editing renderer code, wait ~2 seconds before capturing so Vite's hot module replacement has time to apply.

## When to Use

- After making visual/CSS/layout changes to Bond, capture to verify your work.
- Useful for checking layout, spacing, colors, text rendering, component visibility.
- NOT useful for verifying alignment with native window chrome (traffic lights, title bar). Ask the user for those.
