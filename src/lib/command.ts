/**
 * The one place backend commands are started.
 *
 * argv is always built by the caller from fixed strings plus validated values,
 * never through a shell; the environment is scrubbed so a repository's own
 * configuration cannot redirect output, open an editor, or take a lock; and
 * every command has a deadline and a bound on captured stdout.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'

import { abortError, outputTooLarge, timeoutError, VcsError } from './errors.js'

/** Milliseconds one backend command may run before the request is abandoned. */
export const TIMEOUT_MS = 30_000
/** Deadline for a command that talks to a remote (fetch, push), including its hooks. */
export const REMOTE_TIMEOUT_MS = 120_000
/** Ceiling on one command's captured stdout. */
export const OUTPUT_MAX_BYTES = 8 * 1024 * 1024
/** Retained stderr tail; enough for diagnostics, never forwarded verbatim. */
export const STDERR_TAIL_BYTES = 16 * 1024
/** How long a terminated child gets to exit before being killed. */
export const TERMINATE_GRACE_MS = 2_000

/** The executable and fixed prefix one runner starts every command from. */
export interface CommandOptions {
  /** The executable name resolved on this host. */
  command: string
  /** Fixed arguments after the executable and before the caller's own. */
  args?: string[]
  /** Environment entries layered under the caller's own on every run. */
  env?: NodeJS.ProcessEnv
}

/** One command's directory, cancellation, input, and limits. */
export interface RunOptions {
  /** Directory to run in. */
  cwd: string
  /** Request cancellation. */
  signal?: AbortSignal
  /** Complete standard input, or ignored when absent. */
  stdin?: string
  /** stdout cap; {@link OUTPUT_MAX_BYTES} by default. */
  maxBytes?: number
  /** Deadline; {@link TIMEOUT_MS} by default. */
  timeoutMs?: number
  /** Extra environment entries for this run only. */
  env?: NodeJS.ProcessEnv
}

/** What one finished command reported. */
export interface CommandResult {
  /** Exit code, or null when the process died from a signal. */
  exitCode: number | null
  /** Captured stdout text. */
  stdout: string
  /** Captured stderr tail. */
  stderr: string
  /** True when stdout overflowed its cap and only the retained text remains. */
  lossy: boolean
}

/**
 * Run one external command to completion inside one directory.
 *
 * `run` reports the exit code and both output streams; it throws only when the
 * command could not be run or observed at all. Callers decide whether a
 * nonzero exit is a legitimate answer (an empty repository, for example).
 */
export class CommandRunner {
  #executable: string | null | undefined
  #command: string
  #prefixArgs: string[]
  #env: NodeJS.ProcessEnv

  /** The Host context this runner starts commands through. */
  declare readonly ctx: Context

  /**
   * @param ctx - Host context carrying the subprocess capability.
   * @param options - executable and fixed prefix.
   */
  constructor(ctx: Context, { command, args = [], env = {} }: CommandOptions) {
    this.ctx = ctx
    this.#command = command
    this.#prefixArgs = args
    this.#env = env
  }

  /** The resolved executable, or null when this host does not have it. */
  get executable(): string | null {
    return this.#executable ?? null
  }

  /**
   * Locate the executable once; a host without it is remembered as such.
   * @param signal - cancellation.
   * @returns the executable path, or null.
   */
  async resolve(signal?: AbortSignal): Promise<string | null> {
    if (this.#executable !== undefined) return this.#executable
    try {
      this.#executable = await this.ctx.subprocess.resolveExecutable(this.#command, undefined, signal)
    } catch {
      this.#executable = null
    }
    return this.#executable
  }

  /**
   * Run one command.
   *
   * stdin is either ignored or fed a complete string; stdout and stderr are
   * collected, with stdout capped at `options.maxBytes` (8 MB by default).
   * A capped stdout is reported through `lossy` instead of being silently
   * shortened, so a caller can answer with a stable "oversized" state.
   *
   * @param args - command arguments, already option-safe.
   * @param options - run options.
   * @returns the exit code and both captured streams.
   * @throws VcsError on timeout, cancellation, overflow, or spawn failure.
   */
  async run(args: string[], options: RunOptions): Promise<CommandResult> {
    if (options.signal?.aborted) throw abortError()
    const executable = this.#executable ?? await this.resolve(options.signal)
    if (executable === null) {
      throw new VcsError('vcs-missing', `${this.#command} is not available on this host.`)
    }

    const deadline = AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS)
    const signal = options.signal === undefined
      ? deadline
      : AbortSignal.any([options.signal, deadline])

    let handle: SubprocessHandle
    try {
      handle = this.ctx.subprocess.spawn({
        argv: [executable, ...this.#prefixArgs, ...args],
        cwd: options.cwd,
        stdio: {
          stdin: options.stdin === undefined ? 'ignore' : { data: options.stdin },
          stdout: { maxBytes: options.maxBytes ?? OUTPUT_MAX_BYTES },
          stderr: { maxBytes: STDERR_TAIL_BYTES },
        },
        graceMs: TERMINATE_GRACE_MS,
        signal,
        // A backend's environment is scrubbed so a repository's own config
        // cannot redirect output, prompt, or take a lock. Each backend states
        // exactly what its commands may inherit.
        env: {
          LC_ALL: 'C',
          ...this.#env,
          ...options.env,
        },
      })
    } catch {
      if (deadline.aborted) throw timeoutError()
      if (options.signal?.aborted) throw abortError()
      throw new VcsError('internal', `The ${this.#command} command could not be started.`)
    }

    let outcome: SubprocessOutcome
    try {
      outcome = await handle.done
    } catch {
      if (deadline.aborted) throw timeoutError()
      if (options.signal?.aborted) throw abortError()
      throw new VcsError('internal', `The ${this.#command} command could not be completed.`)
    }

    // A request abort is the browser leaving; it must not become a JSON error.
    if (options.signal?.aborted) throw abortError()
    if (deadline.aborted) throw timeoutError()

    const stdout = handle.collected.stdout?.readFrom(0) ?? { text: '', lossy: false }
    const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
    return { exitCode: outcome.exitCode, stdout: stdout.text, stderr, lossy: stdout.lossy === true }
  }

  /**
   * Run one command that must succeed and stay inside the output cap.
   * @param args - command arguments.
   * @param options - as {@link CommandRunner.run}.
   * @returns its output.
   * @throws VcsError when the command fails or the output overflowed.
   */
  async ok(args: string[], options: RunOptions): Promise<CommandResult> {
    const result = await this.run(args, options)
    if (result.exitCode !== 0) {
      throw new VcsError('internal', `The ${this.#command} command did not complete.`)
    }
    if (result.lossy) throw outputTooLarge()
    return result
  }
}
