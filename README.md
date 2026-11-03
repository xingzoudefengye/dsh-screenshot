# dsh-screenshot

A minimal macOS screenshot plugin for DeepSeek Harness: press a system-wide
shortcut anywhere and the native region selector opens, exactly like pressing
⇧⌘4 — but without keeping a chat app resident just for its screenshot tool.

## What it does

- **Global hotkey** (default `⌃⌥A`): works while any other app has focus. Opens
  the native macOS selection UI: drag a region, press **Space** to pick a
  window, **Esc** to cancel.
- **`screenshot` tool**: the agent can capture on request, either the native
  region selector or the whole main display.
- Captures are saved as PNG into `~/Pictures/DSH Screenshots`.

## What it deliberately does not do

No panel, no annotation editor, no window enumeration, and **no browser-side
bundle**. That last point is the important one: an earlier plugin in this shape
(a 9000-line hand-written CJS client bundle) failed to materialize and took the
harness's `ui-workspace` down with it, leaving 16 entries pending. This plugin
registers nothing in the browser, so the worst case is a warning that the
shortcut is not armed — the rest of the harness is unaffected.

## Permissions

- **Screen Recording** — required for the capture itself. Grant it to the app
  that runs DeepSeek Harness (System Settings → Privacy & Security → Screen
  Recording). Without it, macOS silently returns a wallpaper-only image or
  refuses the window capture; the plugin reports a `permission` failure.
- **Accessibility — not required.** The hotkey uses Carbon's
  `RegisterEventHotKey`, which the system allows without that grant.
- The native helper is compiled once with `swiftc` (Xcode Command Line Tools);
  the cache is keyed by source hash, so restarts reuse it.

## Configuration

```yaml
- insert:
    - id: screenshot
      name: 'dsh-screenshot'
      config:
        hotkey: 'ctrl+alt+a'            # ctrl/alt/shift/cmd (or primary) + one letter
        directory: '~/Pictures/DSH Screenshots'
```

An empty `hotkey` starts with no shortcut; the tool still works.

## Layout

| File | Role |
| --- | --- |
| `lib/index.js` | Row entry: config, hotkey lifecycle, `screenshot` tool. |
| `lib/capture.js` | `screencapture` invocation and failure classification. |
| `lib/hotkey.js` | Accelerator parsing, helper build/cache, trigger dispatch. |
| `bin/hotkey.swift` | ~90-line resident helper: one Carbon hotkey, one `TRIGGER` line. |
