// dsh-screenshot: global screenshot hotkey helper.
//
// A tiny resident AppKit process that registers ONE system-wide hotkey with
// Carbon's RegisterEventHotKey and, when it fires, prints a single line to
// stdout and flushes. The Node half owns the pipe and runs the capture.
//
// RegisterEventHotKey is used deliberately: unlike a CGEventTap it does NOT
// require the Accessibility permission, so the only macOS grant this plugin
// ever needs is Screen Recording (for the capture itself).
//
// Usage:  hotkey <carbon-keycode> <carbon-modifier-mask>
//   prints "READY" once armed, or "ERROR <reason>" and exits non-zero.
//   Prints "TRIGGER" for every press. Exits when stdin closes, so a dead
//   harness never leaves an orphan holding the shortcut.

import AppKit
import Carbon
import Foundation

func fail(_ message: String) -> Never {
    print("ERROR \(message)")
    fflush(stdout)
    exit(2)
}

let arguments = CommandLine.arguments
guard arguments.count >= 3,
      let keyCode = UInt32(arguments[1]),
      let modifiers = UInt32(arguments[2]) else {
    fail("args")
}

/// The trigger line, written once per press.
func emit(_ line: String) {
    print(line)
    fflush(stdout)
}

/// Carbon hands the hotkey press to a C callback; this is the only state it needs.
final class HotkeyTarget: NSObject {
    /// Fired from the Carbon run loop (main thread).
    @objc func fire() {
        emit("TRIGGER")
    }
}

let target = HotkeyTarget()

var eventType = EventTypeSpec(
    eventClass: OSType(kEventClassKeyboard),
    eventKind: UInt32(kEventHotKeyPressed)
)

// Install the handler before registering, so no press can be missed.
let installStatus = InstallEventHandler(
    GetApplicationEventTarget(),
    { _, _, userData -> OSStatus in
        guard let userData else { return OSStatus(eventNotHandledErr) }
        let target = Unmanaged<HotkeyTarget>.fromOpaque(userData).takeUnretainedValue()
        // Carbon dispatches on the main thread; hop anyway to stay safe.
        if Thread.isMainThread { target.fire() } else { DispatchQueue.main.async { target.fire() } }
        return noErr
    },
    1,
    &eventType,
    Unmanaged.passUnretained(target).toOpaque(),
    nil
)
guard installStatus == noErr else { fail("install \(installStatus)") }

var hotKeyRef: EventHotKeyRef?
let signature: OSType = 0x44534853 // 'DSHS'
let hotKeyID = EventHotKeyID(signature: signature, id: 1)
let registerStatus = RegisterEventHotKey(
    keyCode,
    modifiers,
    hotKeyID,
    GetApplicationEventTarget(),
    0,
    &hotKeyRef
)
guard registerStatus == noErr else { fail("register \(registerStatus)") }

emit("READY")

// Two exit paths, both intentional:
//   - stdin EOF: the Node parent closed the pipe (harness unloaded or died).
//   - SIGTERM/SIGINT: an explicit shutdown from the plugin's dispose.
// A short polling read keeps this dependency-free and cheap.
let stdinFD = FileHandle.standardInput.fileDescriptor
signal(SIGTERM) { _ in exit(0) }
signal(SIGINT) { _ in exit(0) }

DispatchQueue.global(qos: .utility).async {
    var buffer = [UInt8](repeating: 0, count: 256)
    while true {
        let count = read(stdinFD, &buffer, buffer.count)
        if count <= 0 { exit(0) }
    }
}

// Run the main event loop; the Carbon handler needs it.
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
app.run()
