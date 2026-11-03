/**
 * dsh-screenshot — a minimal macOS screenshot plugin.
 *
 * Two things, and nothing else:
 *
 *  1. A **system-wide hotkey** (`ctrl+alt+a` by default). Pressing it anywhere
 *     opens the native macOS region selector and saves a PNG. This is the
 *     WeChat-screenshot habit without the WeChat memory footprint.
 *  2. A **`screenshot` tool** the agent can call, for the times the request is
 *     "take a screenshot of this" rather than the operator pressing a key.
 *
 * No panel, no annotation editor, no window enumeration, and **no client
 * bundle**. An earlier attempt shipped a 9000-line hand-written browser bundle
 * whose materialization failure took the shell's UI workspace down with it;
 * this plugin registers nothing on the browser side, so the worst case is "the
 * shortcut is not armed" while the tool still works.
 *
 * @module dsh-screenshot
 */

import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import z from '@deepseek-ai/schemastery'

import { captureToClipboard, notify } from './capture.js'
import { createHotkey } from './hotkey.js'

/** Loader row identity. */
export const name = 'screenshot'

/** The tool registry is the only service this row needs. */
export const inject = ['tools']

/** Default accelerator, matching the WeChat habit. */
const DEFAULT_HOTKEY = 'ctrl+alt+a'

/**
 * Plugin configuration schema, validated by the Loader before {@link apply}.
 *
 * `Config` must be the schemastery object itself: cordis calls
 * `Config['~standard'].validate(raw)` on it, so exporting a factory that builds
 * the schema makes the row fail to activate with "cannot read 'validate'".
 */
export const Config = z.object({
  hotkey: z.string().default(DEFAULT_HOTKEY)
    .description('System-wide screenshot shortcut, e.g. ctrl+alt+a or primary+shift+s. Empty disables it.'),
  copyToClipboard: z.boolean().default(true)
    .description('Put every capture on the clipboard so ⌘V pastes it immediately.'),
  keepFile: z.boolean().default(false)
    .description('Keep the PNG on disk after copying. Off by default: the file is deleted and only the clipboard keeps the image.'),
  directory: z.string().default('')
    .description('Where to keep captures when keepFile is true. `~` is expanded. Empty means ~/Pictures/DSH Screenshots.'),
  notify: z.boolean().default(false)
    .description('Show a notification after a capture. Off by default: silent.'),
})

/**
 * Temp folder holding the transient PNG between capture and clipboard copy.
 *
 * @returns {string} an existing directory.
 */
function transientDirectory() {
  const directory = join(tmpdir(), 'dsh-screenshot')
  mkdirSync(directory, { recursive: true })
  return directory
}


/**
 * Expand a leading `~` against the home directory.
 *
 * @param {string} input - path that may start with `~`.
 * @returns {string} absolute path.
 */
function expandHome(input) {
  if (typeof input !== 'string' || input === '') return input
  const home = process.env.HOME ?? '~'
  if (input === '~') return home
  if (input.startsWith('~/')) return join(home, input.slice(2))
  return input
}

/**
 * One file name per capture, second-resolution and sortable.
 *
 * @param {Date} [now] - clock override for tests.
 * @returns {string} a `Shot-YYYY-MM-DD-HH-MM-SS.png` name.
 */
export function timestampName(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `Shot-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    + `-${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}.png`
}

/**
 * Resolve `defineTool` from the host's tools package.
 *
 * A missing package must cost the tool registration only: the hotkey is the
 * headline feature and keeps working on its own. This is tried lazily so that
 * importing this module never throws, which is how a plugin should behave
 * inside a host that owns the dependency graph.
 *
 * @returns {Promise<Function | null>} `defineTool`, or null when unavailable.
 */
export async function loadDefineTool() {
  try {
    const module = await import('@deepseek-ai/dsh-tools')
    return typeof module.defineTool === 'function' ? module.defineTool : null
  } catch {
    return null
  }
}

/**
 * Mount the plugin.
 *
 * @param {any} ctx - plugin context.
 * @param {any} [config] - validated row config.
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const warn = (message, failure) => {
    const detail = failure instanceof Error ? `: ${failure.message}` : ''
    const logger = ctx.logger
    if (typeof logger?.warn === 'function') logger.warn(`[dsh-screenshot] ${message}${detail}`)
    else console.warn(`[dsh-screenshot] ${message}${detail}`)
  }
  const info = (message) => {
    const logger = ctx.logger
    if (typeof logger?.info === 'function') logger.info(`[dsh-screenshot] ${message}`)
    else console.info(`[dsh-screenshot] ${message}`)
  }

  // Two destinations: by default the PNG is transient (temp dir, deleted after
  // the clipboard copy); `keepFile: true` opts back into a durable folder.
  const keepFile = config.keepFile === true
  const directory = keepFile
    ? expandHome(config.directory || '~/Pictures/DSH Screenshots')
    : transientDirectory()
  try {
    mkdirSync(directory, { recursive: true })
  } catch (failure) {
    warn(`could not create the screenshot directory ${directory}`, failure)
  }

  /** The capture in flight, so a second request does not open a second selector. */
  let inFlight = null

  /**
   * Take one screenshot and leave it on the clipboard.
   *
   * @param {'interactive'|'full'} mode - native selection or the whole screen.
   * @returns {Promise<{ bytes: number, copied: boolean, path: string }>} result;
   *   `path` is empty unless `keepFile` is on.
   */
  async function capture(mode) {
    if (inFlight !== null) throw new Error('a screenshot is already in progress')
    const fileName = timestampName()
    const pending = captureToClipboard({ mode, directory, fileName })
    inFlight = pending
    try {
      const shot = await pending
      // Silent by default; `notify: true` opts back into a banner.
      if (config.notify === true) {
        notify('截图已复制', '⌘V 可直接粘贴')
      }
      return { ...shot, path: keepFile ? join(directory, fileName) : '' }
    } finally {
      inFlight = null
    }
  }

  const hotkey = createHotkey({
    accelerator: config.hotkey ?? DEFAULT_HOTKEY,
    info,
    warn,
    onTrigger: async () => {
      try {
        const shot = await capture('interactive')
        info(`global hotkey captured ${String(shot.bytes)} bytes, clipboard ${shot.copied ? 'filled' : 'failed'}`)
      } catch (failure) {
        // Dismissing the selector is the normal way to back out; stay quiet.
        if (failure?.code === 'cancelled') return
        throw failure
      }
    },
  })

  ctx.effect(() => {
    hotkey.start()
    return () => hotkey.dispose()
  }, 'dsh-screenshot: global hotkey')

  // The tool is registered through an async resolve so a host without the
  // tools package still gets the hotkey instead of a failed row.
  void loadDefineTool().then((defineTool) => {
    if (defineTool === null) {
      warn('@deepseek-ai/dsh-tools is not resolvable here; the screenshot tool was not registered (the hotkey still works)')
      return
    }
    ctx.effect(() => ctx.tools.register(defineTool({
    name: 'screenshot',
    description: [
      'Take a screenshot of the operator\'s macOS screen and put it on the clipboard.',
      'mode "interactive" opens the native region selector (drag a region, press Space for a window, Esc to cancel);',
      'mode "full" grabs the main display without interaction.',
      'The PNG lands on the clipboard for immediate pasting and is deleted afterwards unless the plugin is configured to keep files.',
      'Use it when the operator asks to capture what is on screen. A dismissed selector is reported as cancelled, not as an error.',
    ].join(' '),
    parameters: {
      mode: {
        type: 'string',
        enum: ['interactive', 'full'],
        description: 'Native region selector, or the whole main display. Defaults to interactive.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', description: 'Absolute path of the kept PNG; empty unless the plugin keeps files.' },
          bytes: { type: 'integer', required: true, description: 'File size in bytes; 0 when cancelled.' },
          cancelled: { type: 'boolean', required: true, description: 'Whether the operator dismissed the selector.' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.cancelled
          ? 'The screenshot was cancelled.'
          : value.path
            ? `Screenshot copied to the clipboard and saved to ${value.path} (${value.bytes} bytes).`
            : `Screenshot copied to the clipboard (${value.bytes} bytes). The file was discarded.`,
      }],
    },
    async execute(args) {
      const mode = args?.mode === 'full' ? 'full' : 'interactive'
      try {
        const shot = await capture(mode)
        return { path: shot.path || undefined, bytes: shot.bytes, cancelled: false }
      } catch (failure) {
        if (failure?.code === 'cancelled') return { path: '', bytes: 0, cancelled: true }
        throw failure
      }
    },
      presentCall: () => ({ card: 'generic', title: 'Take a screenshot', kind: 'other', rawInput: {} }),
    })), 'dsh-screenshot: screenshot tool')
  }).catch((failure) => {
    warn('could not register the screenshot tool', failure)
  })

  info(`active: ${keepFile ? `keeping files in ${directory}` : 'clipboard only, files discarded'}, hotkey ${hotkey.status().label ?? 'disabled'}`)
}
