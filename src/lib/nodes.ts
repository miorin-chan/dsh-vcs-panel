/**
 * Timeline node ids that are not commit ids.
 *
 * A backend names its working state once, and the client's persisted selection
 * uses the same token. Commits are addressed by their own id.
 */

/** The synthetic working-tree row of a backend with a separate working tree. */
export const WORKING_TREE_NODE = 'worktree'

/** The working-copy commit of a backend where the working copy is a commit. */
export const WORKING_COPY_NODE = '@'
