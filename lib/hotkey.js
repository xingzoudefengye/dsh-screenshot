/**
 * The global screenshot hotkey, driven by `bin/hotkey.swift`.
 *
 * One resident helper registers a single Carbon hotkey (no Accessibility
 * permission needed) and prints `TRIGGER` on every press. This module owns the
 * helper's lifetime and turns each `TRIGGER` into a capture.
 *
 * Design notes:
 *  - The helper is compiled once with `swiftc` and cached by source hash, so a
 *    source edit recompiles but a restart does not.
 *  - Triggers are coalesced: `screencapture -i` is a blocking native selector,
 *    so a second press while one is open is ignored instead of stacking
 *    selectors the operator cannot dismiss.
 *  - The helper's stdin is held open by this process; when this process dies
 *    the pipe closes and the helper exits on its own. No orphans.
 *
 * @module dsh-screenshot/hotkey
 */

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Carbon virtual key codes for the letters this plugin can default to. */
const KEY_CODES = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11,
  q: 12, w: 13, e: 14, r: 15, y: 16, t: 17, o: 31, u: 32, i: 34, p: 35,
  l: 37, j: 38, k: 40, n: 45, m: 46,
}

/** Carbon modifier masks. */
const MODIFIER_MASKS = {
  cmd: 0x0100, // cmdKey
  shift: 0x0200, // shiftKey
  alt: 0x0800, // optionKey
  ctrl: 0x1000, // controlKey
}

/**
 * Parse `ctrl+alt+a` into Carbon key code and modifier mask.
 *
 * @param {string} accelerator - `+`-separated modifiers and one letter.
 * @returns {{ keyCode: number, modifiers: number, label: string } | null} the
 *   Carbon form, or null when the accelerator is malformed.
 */
export function parseAccelerator(accelerator) {
  if (typeof accelerator !== 'string' || accelerator.trim() === '') return null
  const parts = accelerator.toLowerCase().split('+').map((part) => part.trim()).filter((part) => part !== '')
  if (parts.length < 2) return null
  const key = parts[parts.length - 1]
  if (key.length !== 1 || !(key in KEY_CODES)) return null
  let modifiers = 0
  for (const part of parts.slice(0, -1)) {
    const mask = part === 'primary' ? MODIFIER_MASKS.cmd : MODIFIER_MASKS[part]
    if (mask === undefined) return null
    modifiers |= mask
  }
  return { keyCode: KEY_CODES[key], modifiers, label: accelerator }
}

/** Directory the compiled helper is cached in. */
const CACHE_DIR = join(tmpdir(), 'dsh-screenshot-hotkey')

/**
 * Compile the Swift helper once per source hash and return the binary path.
 *
 * @param {(message: string) => void} warn - diagnostic sink.
 * @returns {string} absolute path to the helper binary.
 * @throws {Error} when no usable compiler is present.
 */
export function buildHelper(warn) {
  const sourcePath = fileURLToPath(new URL('../bin/hotkey.swift', import.meta.url))
  const source = readFileSync(sourcePath, 'utf8')
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 16)
  const binary = join(CACHE_DIR, `hotkey-${hash}`)
  if (existsSync(binary)) return binary
  mkdirSync(CACHE_DIR, { recursive: true })
  const result = spawnSync('swiftc', ['-O', '-o', binary, sourcePath], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`could not compile the hotkey helper (needs Xcode Command Line Tools): ${String(result.stderr ?? '').trim() || 'swiftc failed'}`)
  }
  warn(`compiled the hotkey helper once into ${binary}`)
  return binary
}

/**
 * Own the helper process and dispatch its triggers.
 *
 * @param {object} options - hotkey options.
 * @param {string} options.accelerator - accelerator string, e.g. `ctrl+alt+a`.
 * @param {() => Promise<void> | void} options.onTrigger - called per press.
 * @param {(message: string) => void} options.info - diagnostic sink.
 * @param {(message: string, failure?: unknown) => void} options.warn - diagnostic sink.
 * @returns {{ start: () => void, dispose: () => void, status: () => object }} the controller.
 */
export function createHotkey({ accelerator, onTrigger, info, warn }) {
  const parsed = parseAccelerator(accelerator)
  let child = null
  let busy = false
  let armed = false
  let reason = parsed === null ? `could not parse the accelerator ${JSON.stringify(accelerator)}` : null

  /**
   * Run one capture, coalescing presses that arrive while another is open.
   *
   * @returns {Promise<void>} completion.
   */
  async function dispatch() {
    if (busy) return
    busy = true
    try {
      await onTrigger()
    } catch (failure) {
      warn('the global hotkey capture failed', failure)
    } finally {
      busy = false
    }
  }

  function start() {
    if (parsed === null) {
      warn(reason ?? 'hotkey disabled')
      return
    }
    if (process.platform !== 'darwin') {
      reason = 'the global hotkey is macOS-only'
      return
    }
    let binary
    try {
      binary = buildHelper(warn)
    } catch (failure) {
      reason = failure instanceof Error ? failure.message : String(failure)
      warn(reason)
      return
    }

    let spawned
    try {
      spawned = spawn(binary, [String(parsed.keyCode), String(parsed.modifiers)], {
        stdio: ['pipe', 'pipe', 'inherit'],
      })
    } catch (failure) {
      reason = `could not start the hotkey helper: ${failure instanceof Error ? failure.message : String(failure)}`
      warn(reason)
      return
    }
    child = spawned
    let carry = ''
    spawned.stdout?.setEncoding('utf8')
    spawned.stdout?.on('data', (chunk) => {
      carry += chunk
      let newline = carry.indexOf('\n')
      while (newline !== -1) {
        const line = carry.slice(0, newline).trim()
        carry = carry.slice(newline + 1)
        newline = carry.indexOf('\n')
        if (line === 'READY') {
          armed = true
          reason = null
          info(`global screenshot hotkey armed: ${parsed.label}`)
        } else if (line.startsWith('ERROR')) {
          armed = false
          reason = line.slice(5).trim() || 'the helper reported an error'
          warn(`global screenshot hotkey unavailable: ${reason}`)
        } else if (line === 'TRIGGER') {
          void dispatch()
        }
      }
    })
    spawned.once('exit', (code, signal) => {
      if (child !== spawned) return
      child = null
      armed = false
      reason = `the hotkey helper exited (code ${String(code)}, signal ${String(signal)})`
      warn(reason)
    })
    spawned.once('error', (failure) => {
      armed = false
      reason = `the hotkey helper failed: ${failure.message}`
      warn(reason)
    })
  }

  function dispose() {
    const running = child
    child = null
    armed = false
    if (running === null) return
    try {
      running.stdin?.end()
    } catch { /* the pipe may already be gone */ }
    const timer = setTimeout(() => {
      try {
        running.kill('SIGTERM')
      } catch { /* already exited */ }
    }, 500)
    timer.unref?.()
  }

  return {
    start,
    dispose,
    status: () => ({ accelerator, label: parsed?.label ?? null, armed, reason }),
  }
}
