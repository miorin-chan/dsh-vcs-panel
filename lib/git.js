/**
 * Git process configuration.
 *
 * The generic runner in `command.js` owns deadlines, output caps, and abort
 * handling; this module only states what makes a Git invocation safe and
 * deterministic.
 */

import { CommandRunner } from './command.js'

// The subprocess service inherits the Host's environment unless a variable
// has an explicit tombstone. Ignore ambient Git repository selectors and
// pathspec modes even when the Host launched from an existing Git command.
const LOCAL_GIT_ENV = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS',
  'GIT_DIR', 'GIT_GRAFT_FILE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_QUARANTINE_PATH',
  'GIT_SHALLOW_FILE', 'GIT_WORK_TREE', 'GIT_NAMESPACE', 'GIT_PREFIX', 'GIT_INTERNAL_SUPER_PREFIX',
  'GIT_LITERAL_PATHSPECS', 'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS',
]
const CLEAR_LOCAL_GIT_ENV = Object.fromEntries([
  ...LOCAL_GIT_ENV,
  ...Object.keys(process.env).filter(name => LOCAL_GIT_ENV.includes(name.toUpperCase())),
].map(name => [name, undefined]))

/**
 * Run `git <args>` with fixed safety flags.
 *
 * `GIT_CONFIG_COUNT=0` clears ambient config overrides, no optional lock is
 * taken, and no prompt is possible. Repository-local config is still read, as
 * git itself does; `--no-ext-diff` is added by each comparison call site.
 */
export class GitRunner extends CommandRunner {
  /**
   * @param {object} ctx - Host context carrying the subprocess capability.
   */
  constructor(ctx) {
    super(ctx, {
      command: 'git',
      args: ['-c', 'core.quotepath=false'],
      env: {
        ...CLEAR_LOCAL_GIT_ENV,
        GIT_CONFIG_COUNT: '0',
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
      },
    })
  }
}
