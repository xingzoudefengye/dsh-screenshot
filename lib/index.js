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
import { join } from 'node:path'

import z from '@deepseek-ai/schemastery'

import { capturePng } from './capture.js'
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
  directory: z.string().default('~/Pictures/DSH Screenshots')
    .description('Where captures are saved. `~` is expanded.'),
})

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

  const directory = expandHome(config.directory ?? '~/Pictures/DSH Screenshots')
  try {
    mkdirSync(directory, { recursive: true })
  } catch (failure) {
    warn(`could not create the screenshot directory ${directory}`, failure)
  }

  /** The capture in flight, so a second request does not open a second selector. */
  let inFlight = null

  /**
   * Take one screenshot and return its path.
   *
   * @param {'interactive'|'full'} mode - native selection or the whole screen.
   * @returns {Promise<{ path: string, bytes: number }>} the written file.
   */
  async function capture(mode) {
    if (inFlight !== null) throw new Error('a screenshot is already in progress')
    const pending = capturePng({ mode, directory, fileName: timestampName() })
    inFlight = pending
    try {
      return await pending
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
        info(`global hotkey captured ${shot.path} (${shot.bytes} bytes)`)
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
      'Take a screenshot of the operator\'s macOS screen and return the saved PNG path.',
      'mode "interactive" opens the native region selector (drag a region, press Space for a window, Esc to cancel);',
      'mode "full" grabs the main display without interaction.',
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
          path: { type: 'string', required: true, description: 'Absolute path of the saved PNG; empty when cancelled.' },
          bytes: { type: 'integer', required: true, description: 'File size in bytes; 0 when cancelled.' },
          cancelled: { type: 'boolean', required: true, description: 'Whether the operator dismissed the selector.' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.cancelled
          ? 'The screenshot was cancelled.'
          : `Screenshot saved to ${value.path} (${value.bytes} bytes).`,
      }],
    },
    async execute(args) {
      const mode = args?.mode === 'full' ? 'full' : 'interactive'
      try {
        const shot = await capture(mode)
        return { path: shot.path, bytes: shot.bytes, cancelled: false }
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

  info(`active: saving to ${directory}, hotkey ${hotkey.status().label ?? 'disabled'}`)
}
