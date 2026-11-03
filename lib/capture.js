/**
 * Screenshot capture on macOS through the system `screencapture` utility.
 *
 * Deliberately tiny: no overlay, no editor, no window enumeration. Two modes
 * matter and both are one argument set each:
 *
 *   - `interactive`: `-i` opens the native selection UI (drag a region, press
 *     Space for window pick, Esc to cancel). This is what the global hotkey
 *     runs, so it behaves exactly like ⇧⌘4 without owning a window.
 *   - `full`: `-x` grabs the main display with no sound and no interaction.
 *
 * Post-capture behaviour follows the WeChat habit that made the operator reach
 * for that app: the PNG lands on the **clipboard** so ⌘V works immediately,
 * and a notification names the saved file. Saving is the side effect, not the
 * end goal — a screenshot nobody can paste is a screenshot nobody wanted.
 *
 * Cancelling the native selector makes `screencapture` exit non-zero **and**
 * write no file; that is a normal outcome, not a failure, so it maps to
 * `cancelled` instead of an error the agent has to interpret.
 *
 * @module dsh-screenshot/capture
 */

import { spawn } from 'node:child_process'
import { mkdirSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

/** Absolute path: never resolve shell tools through PATH. */
const SCREENCAPTURE = '/usr/sbin/screencapture'
const OSASCRIPT = '/usr/bin/osascript'

/** A capture failure carrying a stable code the caller can branch on. */
export class CaptureError extends Error {
  /**
   * @param {string} code - stable failure code.
   * @param {string} message - operator-facing detail.
   */
  constructor(code, message) {
    super(message)
    this.name = 'CaptureError'
    this.code = code
  }
}

/**
 * Run one child process to completion.
 *
 * @param {string} command - absolute executable path.
 * @param {string[]} args - argv tail.
 * @returns {Promise<{ code: number | null, stderr: string }>} exit code and stderr.
 */
function run(command, args) {
  return new Promise((resolveWait, rejectWait) => {
    let child
    try {
      child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (failure) {
      rejectWait(failure)
      return
    }
    let stderr = ''
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
      if (stderr.length > 8000) stderr = stderr.slice(-8000)
    })
    child.once('error', rejectWait)
    child.once('close', (code) => resolveWait({ code, stderr }))
  })
}

/**
 * Capture one PNG into `directory`.
 *
 * @param {object} options - capture request.
 * @param {'interactive'|'full'} options.mode - which native mode to run.
 * @param {string} options.directory - existing directory to write into.
 * @param {string} options.fileName - file name (no path separators).
 * @returns {Promise<{ path: string, bytes: number }>} the written file.
 * @throws {CaptureError} `unsupported` off macOS, `cancelled` when the operator
 *   dismissed the selector, `capture_failed` for everything else.
 */
export async function capturePng({ mode, directory, fileName }) {
  if (process.platform !== 'darwin') {
    throw new CaptureError('unsupported', `screenshots need macOS; this host is ${process.platform}`)
  }
  const path = join(directory, fileName)
  const args = ['-t', 'png', '-o']
  if (mode === 'interactive') args.push('-i')
  else args.push('-x')
  args.push(path)

  let result
  try {
    result = await run(SCREENCAPTURE, args)
  } catch (failure) {
    throw new CaptureError('capture_failed', `could not start screencapture: ${failure instanceof Error ? failure.message : String(failure)}`)
  }

  // A dismissed selector exits non-zero with no file: that is a cancel.
  try {
    statSync(path)
  } catch {
    if (result.code !== 0) {
      const detail = result.stderr.trim()
      if (detail === '') throw new CaptureError('cancelled', 'the screenshot was cancelled')
      // `screencapture` reports a permission refusal on stderr after the
      // operator has dismissed the macOS prompt.
      if (/permission|not permitted|denied/i.test(detail)) {
        throw new CaptureError('permission', 'Screen Recording permission is required for this app (System Settings → Privacy & Security → Screen Recording)')
      }
      throw new CaptureError('capture_failed', `screencapture exited ${String(result.code)}: ${detail}`)
    }
    throw new CaptureError('capture_failed', 'screencapture reported success but wrote no file')
  }

  const stat = statSync(path)
  if (stat.size === 0) {
    await rm(path, { force: true })
    throw new CaptureError('capture_failed', 'screencapture wrote an empty file')
  }
  return { path, bytes: stat.size }
}

/**
 * Create the destination directory up front so a capture never races it.
 *
 * @param {string} directory - absolute directory to ensure.
 * @returns {void}
 */
export function ensureDirectory(directory) {
  mkdirSync(directory, { recursive: true })
}

/**
 * Put a PNG file on the macOS clipboard so ⌘V works right away.
 *
 * Uses osascript rather than `pbcopy` because the clipboard has to hold an
 * **image**, and the scripting bridge can set the clipboard to a file's
 * contents without shelling out to a second tool per capture.
 *
 * @param {string} path - absolute path of the PNG.
 * @returns {Promise<boolean>} whether the clipboard was written.
 */
export async function copyImageToClipboard(path) {
  if (process.platform !== 'darwin') return false
  const script = [
    'set the clipboard to (read (POSIX file "' + path.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '") as «class PNGf»)',
  ].join('\n')
  try {
    const result = await run(OSASCRIPT, ['-e', script])
    return result.code === 0
  } catch {
    return false
  }
}

/**
 * Show a macOS notification so the operator learns where the file went.
 *
 * @param {string} title - notification title.
 * @param {string} message - notification body.
 * @returns {void}
 */
export function notify(title, message) {
  if (process.platform !== 'darwin') return
  const escape = (text) => String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const script = `display notification "${escape(message)}" with title "${escape(title)}"`
  try {
    const child = spawn(OSASCRIPT, ['-e', script], { stdio: 'ignore', detached: true })
    child.unref()
  } catch { /* notifications are cosmetic */ }
}
