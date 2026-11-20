/** Jujutsu workspace discovery and membership checks. */

import { isAbsolute, join, resolve } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'

import { canonicalDirectory } from './contain.js'
import { abortError, outputTooLarge } from './errors.js'
import type { JujutsuRunner } from './jujutsu.js'
import { parseJjRecords } from './jujutsu.js'
import { isFullSha, sameRepoPath } from './paths.js'
import type { Worktree, WorktreeOptions } from './worktrees.js'

const REPO_LINK_BYTES = 16 * 1024
const WORKSPACE_FIELDS = '"name" => name, "head" => target.commit_id()'
const WORKSPACE_LIST = `json({${WORKSPACE_FIELDS}, "path" => root, "current" => current_workspace}) ++ "\\n"`
const CURRENT_WORKSPACE = `if(current_workspace, json({${WORKSPACE_FIELDS}}) ++ "\\n")`

/** One workspace record, as the list template describes it. */
export interface JjWorkspaceRecord {
  /** Registered workspace name. */
  name: string
  /** The workspace's head commit id. */
  head: string
  /** Structured path, or null when the record carried none. */
  path: string | null
  /** True for the workspace the command ran in. */
  current: boolean
}

/**
 * Parse structured output, never the human-readable workspace summary.
 * @param stdout - template output, one JSON object per line.
 * @returns the parsed workspace records.
 */
export function parseJjWorkspaces(stdout: string): JjWorkspaceRecord[] {
  return parseJjRecords(stdout).flatMap(record => {
    if (typeof record.name !== 'string' || record.name === '' || !isFullSha(record.head)) return []
    const path = typeof record.path === 'string' && !record.path.includes('\0') && isAbsolute(record.path)
      ? record.path : null
    return [{ name: record.name, head: record.head, path, current: record.current === true }]
  })
}

/**
 * The primary .jj/repo is a directory; a linked workspace records a path
 * relative to .jj (or an absolute path) in a regular .jj/repo file.
 */
export async function jjCommonDirAt(
  ctx: Context,
  root: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const jjDir = await canonicalDirectory(ctx, join(root, '.jj'), signal)
    if (jjDir === null) return null
    const repo = await ctx.fs.resolve(join(jjDir, 'repo'), { signal })
    const info = await ctx.fs.stat(repo, signal)
    if (info?.type === 'directory') return ctx.fs.processPath(repo)
    if (info?.type !== 'file' || (info.size !== undefined && info.size > REPO_LINK_BYTES)) return null
    const bytes = await ctx.fs.readBytes(repo, signal, REPO_LINK_BYTES)
    const pointer = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    // Do not trim: spaces and newlines can be part of a workspace's path.
    if (pointer === '' || pointer.includes('\0')) return null
    return await canonicalDirectory(ctx, resolve(jjDir, pointer), signal)
  } catch {
    if (signal?.aborted) throw abortError()
    return null
  }
}

async function readWorkspaces(
  runner: JujutsuRunner,
  cwd: string,
  template: string,
  signal: AbortSignal | undefined,
): Promise<JjWorkspaceRecord[] | null> {
  const result = await runner.run(
    ['--ignore-working-copy', '--at-op=@', 'workspace', 'list', '-T', template],
    { cwd, signal },
  )
  if (result.lossy) throw outputTooLarge()
  return result.exitCode === 0 ? parseJjWorkspaces(result.stdout) : null
}

/**
 * Only a live workspace with the same store and registered name can be browsed.
 * @param ctx - plugin context with the filesystem capability.
 * @param runner - the `jj` runner.
 * @param root - repository root.
 * @param signal - cancellation.
 * @param options - which trees to offer and a common directory already resolved.
 * @returns each browsable workspace, anchor first.
 */
export async function* discoverJjWorkspaces(
  ctx: Context,
  runner: JujutsuRunner,
  root: string,
  signal: AbortSignal | undefined,
  { paths = null, commonDir = null }: WorktreeOptions = {},
): AsyncGenerator<Worktree> {
  const matches = (path: string): boolean => paths === null || paths.some(requested => sameRepoPath(path, requested))
  const entries = await readWorkspaces(runner, root, WORKSPACE_LIST, signal)
  // Older jj versions cannot identify the current workspace independently of
  // its commit. Keep the anchor-only view instead of guessing at membership.
  if (entries === null) return

  const current = entries.find(entry => entry.current)
  if (current !== undefined && matches(root)) {
    yield { path: root, name: current.name, head: current.head }
  }
  for (const entry of entries) {
    if (entry.current || entry.path === null) continue
    const path = await canonicalDirectory(ctx, entry.path, signal)
    if (path === null || sameRepoPath(path, root) || !matches(path)) continue
    commonDir ??= await jjCommonDirAt(ctx, root, signal)
    if (commonDir === null) return
    const candidateDir = await jjCommonDirAt(ctx, path, signal)
    if (candidateDir === null || !sameRepoPath(candidateDir, commonDir)) continue
    const actual = (await readWorkspaces(runner, path, CURRENT_WORKSPACE, signal))?.[0]
    if (actual?.name === entry.name) yield { path, name: entry.name, head: entry.head }
  }
}
