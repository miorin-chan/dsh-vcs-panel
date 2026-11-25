# 实现：dsh-vcs-panel

本文记录实现契约：Host 路由与安全边界、核心数据形状、资源上限、Client 构建与宿主接缝、图与变更树管线，以及代码复用来源。

## Host 路由、安全与后端

### 注册与路由

Host 端为无运行时依赖的 Node ESM 插件，注入 `['connection', 'sessions', 'subprocess', 'fs']`。
`apply` 仅在配置显式为字面量 `enabled: false` 时跳过路由注册（如需同时移除前端页签，需在 Plugins 中停用整个 bundle）。
下表的 `GET` 与 `POST` 路由均注册在 `ctx.connection.fetch` 的认证栅栏内。
读取的请求 `signal` 与插件生命周期 `AbortController` 组合，取消的请求保留 `AbortError`，不转为错误 JSON。
写路由只接插件生命周期的 `signal`，浏览器离开时已开始的写操作继续执行。

| 路由 | 查询参数 | 应答字段 |
| --- | --- | --- |
| `GET /api/vcs.repositories` | `sessionId` | `cwd`、`repositories[]`（`path`、`name`、`enclosing`、`vcs`、`availableVcs`、`capabilities`、`sources[]`、`worktrees[]` 含 `path`、`name`、`head`、Git 的 `branch`，以及 `primary?`、`locked?`、`inUse?`、`canRemove?`、`canForget?`）、`truncated`、`worktreesTruncated`、`configError?` |
| `GET /api/vcs.repository-config` | `sessionId` | `revision`、`scanDirectories[]`、`repositories[]`（条目含 `path`、`available`）、`backends[]`（条目含 `path`、`vcs`、`available`）、`error?` |
| `GET /api/vcs.repository-preview` | `sessionId`、`path`、`kind`（`directory` 或 `repository`） | `repositories[]`（相对 `path`、`name`、`vcs`、`availableVcs`）、`truncated` |
| `POST /api/vcs.repository-config` | JSON `{ sessionId, revision, scanDirectories, repositories, backends? }`（两个路径数组，以及 `{ path, vcs }` 偏好数组） | 同配置 GET |
| `GET /api/vcs.overview` | `sessionId`、`repo?`（至多一个，须是已发现的仓库） | NDJSON：先 `scope`（`cwd`、`repositories`），每个仓库读完一行 `repository`（`OverviewRepository`）或 `error`（`path`、`error.code`），最后 `done`（`unlistedTruncated`）；见[全景读取](#全景读取) |
| `GET /api/vcs.status` | `sessionId`、`repo`、`worktree?`、`readOnly?`（`1` 跳过 Jujutsu 快照） | `repo`、`vcs`、`capabilities`、`defaultNode`、`branch`、`workingCopy?`、`groups`、`total`、`untrackedTotal`、`untrackedAdded`、`truncated`、`stageHistory` |
| `GET /api/vcs.watch` | `sessionId`、`repo?`、`worktree?`（可重复）、`client?` | SSE `ready` 与 `invalidate`（`domains[]`、`origin?`） |
| `GET /api/vcs.branches` | `sessionId`、`repo` | `branches[]`（`name`、`current`、`occupied`）、`truncated`（仅 `capabilities.branchSwitch` 为真时可用） |
| `GET /api/vcs.remotes` | `sessionId`、`repo` | `remotes[]`、`truncated`（`capabilities.tagOps` 或 `capabilities.branchOps` 为真时可用） |
| `GET /api/vcs.untracked` | `sessionId`、`repo`、`worktree?`、`path`（`/` 结尾） | `path`、`entries[]`（`name`、`path`、`type`）、`truncated`（仅 `capabilities.untracked` 为真时可用） |
| `GET /api/vcs.diff` | `sessionId`、`repo`、`worktree?`、`scope`、`path`、`oldPath?`、`rev?` | `VcsFileDiff` |
| `GET /api/vcs.log` | `sessionId`、`repo`、`worktree?`（可重复）、`ref`、`limit`、`skip` | `commits[]`、`truncated`、`nextSkip`；传入工作树时另有 `worktreeHeads[]`（`path`、`head`） |
| `GET /api/vcs.commit` | `sessionId`、`repo`、`worktree?`、`sha` | `commit`（`CommitDetail`，不含 patch；`refs` 含 `current`、分离 `head` 及 `remote`/`branch` 标注）、`truncated` |
| `GET /api/vcs.turn` | `sessionId`、`turn`、`seq?` | `turn`、`head`（`TurnHead \| null`）、`changed`、`added`、`deleted` |
| `POST /api/vcs.sync` | JSON 请求体 `{ sessionId, repo }` | `upstream`、`pulled`、`pushed`（仅 `capabilities.sync` 为真时可用） |
| `POST /api/vcs.switch` | JSON 请求体 `{ sessionId, repo, branch }` | `branch`（仅 `capabilities.branchSwitch` 为真时可用） |
| `POST /api/vcs.worktree` | JSON `{ sessionId, repo, action: 'create', path, mode?, name?, revision? }` 或 `{ sessionId, repo, action: 'remove' \| 'forget', worktree, expectedName?, expectedBranch?, expectedHead? }` | `{ path }`（分别由 `capabilities.worktreeCreate`、`worktreeRemove`、`worktreeForget` 控制） |
| `POST /api/vcs.branch` | JSON 请求体 `{ sessionId, repo, action, branch, name?, local?, force? }` | 本地：`rename` → `{ from, branch }`；`delete` → `{ branch }`；`merge` → `{ branch, current, result }`；`rebase` → `{ branch, current }`；`push` → `{ branch, upstream, pushed }`。远程：`checkout-remote` → `{ branch, local }`；`delete-remote` → `{ branch }`；`merge-remote` / `pull-remote` → `{ branch, current, result }`（仅 `capabilities.branchOps` 为真时可用） |
| `POST /api/vcs.tag` | JSON 请求体 `{ sessionId, repo, action, tag, remote? }` | `delete` → `{ tag }`；`push` → `{ tag, remote, pushed }`（仅 `capabilities.tagOps` 为真时可用） |
| `POST /api/vcs.commit-op` | JSON 请求体 `{ sessionId, repo, action, sha, name?, message?, mode?, checkout? }` | `tag` → `{ tag, sha }`；`branch` → `{ branch, sha, checkedOut?: true }`；`checkout` → `{ sha }`；`cherry-pick` / `revert` / `drop` / `rebase` → `{ sha, current }`；`merge` → `{ sha, current, result }`；`reset` → `{ sha, current, mode }`（仅 `capabilities.commitOps` 为真时可用） |
| `POST /api/vcs.stage` | JSON 请求体 `{ sessionId, repo, scope, path, oldPath?, fingerprint?, lines? }`，或目录与分组的 `{ sessionId, repo, scope, files }` | `{ scope, path, fileCount? }`（仅 `capabilities.stageOps` 为真时可用） |
| `POST /api/vcs.stage-history` | JSON 请求体 `{ sessionId, repo, action: 'undo' \| 'redo', id }` | `{ action, stageHistory }`（仅 `capabilities.stageOps` 为真时可用） |

### 自动刷新订阅

- `vcs.watch` 使用同源 SSE。页签与文档可见时建立连接，隐藏或切换范围时关闭连接。
  `ready` 后客户端补查，以覆盖隐藏期间和连接建立前的变化。
  自动刷新期间保留上次成功数据。
- `invalidate` 携带 `working`、`history` 或 `repositories`。
  客户端防抖合并域。同一域只运行一次读取，期间到达的通知合成一次待处理刷新。
  仓库列表刷新后，同一路径的后端变化会重置阅读状态与 diff 缓存，并以新的后端范围和仓库标识重开订阅。
  写入或对话期间暂缓读取。面板写入带 `X-VCS-Client`，若事件的 `origin` 匹配该面板，它使用操作完成后的显式刷新。
- Git 用独立的工作树监听与元数据监听。
  后者覆盖每棵工作树的 `HEAD`、index 和公共引用存储，动态监听当前分支与上游引用，并过滤锁文件与 Watchman cookie。
  macOS 和 Windows 优先用原生递归监听，其他平台按目录数量设限。
  超出监听范围的变更可通过会话事件、重新激活或手动刷新发现。
- Git 状态读取由 Host 按仓库根单飞。
  写入或工作树变更会使在途读取失效，后续请求等待一次新的共享读取。
- Jujutsu 监听 `op_heads/heads`，以操作头标识避免重复通知。
  自动状态请求带 `readOnly=1`，比较按不可变提交 ID 读取。
  Host 在有变更的会话回合结束后为匹配的已选工作区安排快照，隐藏时留待重新订阅。

### 输入校验与路径边界

客户端只传会话标识与候选路径，不能凭请求参数让服务端读取任意目录或注入命令选项：

- **会话与仓库范围**：`sessionId` 必须命中带有效 `header.cwd` 的活跃会话。
  列表由 `discoverRepositories` 枚举，仓库路由由 `resolveSessionRepository` 直接校验目标，无需枚举目录。
  两者按[工作区配置](DESIGN.md#仓库发现与工作区配置)与默认规则确定范围。
  默认向上最多查 64 层，直属扫描跳过 `.git`、`.jj` 和 `node_modules`。
  候选目录经 `ctx.fs.resolve` 规范化，并保持在对应扫描目录内。
  标记用 `lstat` 检测，兼容 linked worktree 和 submodule 的 `.git` 文件；
  两种标记都在时按 `backends` 偏好选择，否则 `.jj` 优先于 `.git`。
  列表的 `sources` 保留 `default`、`directory` 和 `repository` 来源，后两种含配置中的相对 `path`；
  `availableVcs` 按标记优先级列出实际存在的后端，供管理界面限定可选值。
  读取仓库文件另用 `containPath` 校验实际路径。
- **发现配置读写**：配置文件限为会话目录内的常规 UTF-8 JSON 文件，Host 拒绝配置文件路径别名。
  读取限量并核对文件版本，`revision` 隐藏实际文件版本。
  保存后端使用 `ctx.fs.writeText` 的版本或创建前置条件原子写入，避免覆盖过期编辑；路径失效的已保存条目可保留或移除。
  `backends` 的 `path` 接受相对路径或表示会话根的 `"."`，`vcs` 只接受 `git` 与 `jujutsu`；
  重复路径、未知后端、增改条目的标记缺失都在保存时拒绝。
  已保存条目在新标记消失后可原样保留，读取时回退到标记优先级。
  `repository-config-invalid`、`repository-config-conflict`、
  `repository-config-write-failed` 和 `repository-path-unavailable` 分别表示无效、冲突、保存失败和路径不可用。
- **仓库分组与工作树白名单**：`groupRepositories` 将验证为同一存储的工作树归组，
  以首个已授权工作树为入口（`repo`）；无法验证归属的独立发现根不合并。
  Git 从 `git worktree list --porcelain -z` 读取目录，略过 bare、prunable 和不在线的树，
  并用 `git rev-parse --path-format=absolute --show-toplevel --git-common-dir` 核对工作树根和共享目
  录。 Jujutsu 从 `jj workspace list` 的 JSON 模板读取名称、登记路径和工作副本提交。
  实时目录必须指向同一个规范化的 `.jj/repo` 存储（链接文件以 `.jj` 为相对基准）， 且其
  `current_workspace` 名称须匹配登记项。
  该模板能力从 jj 0.47 提供；旧版本或没有登记路径的工作区保留独立发现的入口视图，生命周期操作要求有当前登记路径。
  状态与详情读取的 `worktree` 只接收一个目标，历史读取可接收多个无重复的绝对路径；每次根据 `repo` 重新校验。
  Git 工作区文件路径约束使用所选树的根。
  生命周期以外的写请求仍以仓库入口为目标，带 `worktree` 参数会被拒绝。
- **工作树生命周期**：移除和解除关联按当前仓库的实时工作树清单校验确切目标；主目录及活动会话使用的目录受保护。
  新建使用相对于入口的目标路径或允许范围内的绝对路径；目标必须尚未存在，且处于会话目录内或是入口的直接同级目录。
  Git 用 `worktree add/remove`，禁止强制移除；Jujutsu 用 `workspace add/forget/remove`，按已安装后端的能力开放。
  删除前检查可能丢失的文件或提交；JJ 从现有快照只读核对文件路径，再由原生命令保存已跟踪文件的本地修改。
  使用稀疏检出的 JJ 工作区可解除关联，面板保留其磁盘文件。
  同一共享存储下的面板写入共用锁。
  生命周期写入使工作区、历史与仓库发现结果失效。
- **路径与修订号净化**：`validateRelPath` 拒绝绝对路径、反斜杠、空段、`.`、`..`、`-` 前缀与控制字符，
  Git 侧再包 `:(literal)` pathspec，Jujutsu 侧用 `file:"..."` fileset。
  提交 ID 先做 7–64 位十六进制校验；Git 再经 `rev-parse --verify <sha>^{commit}` 解析，
  Jujutsu 仅接受 `@` 或十六进制 ID。
- **写请求栅栏**：`vcs.sync`、`vcs.switch`、`vcs.branch`、`vcs.tag`、
  `vcs.commit-op` 、`vcs.stage` 与 `vcs.stage-history` 只接受 `POST`，
  `content-type` 必须是 `application/json`（跨站页面不经 CORS 预检发不出），
  `Sec-Fetch-Site` 存在且不是 `same-origin` / `none` 时返回 `403 forbidden`；
  请求体中的 `sessionId` 与 `repo` 再走与读取相同的会话与仓库白名单。
  切换的 `branch` 与分支操作的 `branch`、`name`、`local` 必须是字符串：拒绝空串、
  超过 255 字符、空白或控制字符、`-` 前缀。
  `vcs.branch` 的 `action` 必须是 `rename`、`delete`、`merge`、`rebase`、`push`、
  `checkout-remote`、`delete-remote`、`merge-remote` 或 `pull-remote` 之一；`name` 只用于 `rename`，
  `local` 只用于 `checkout-remote`，`force` 只用于 `delete` 且必须是布尔值。
  本地分支操作的目标必须命中该仓库的本地分支列表；
  重命名与远程检出的新名字还要通过 `git check-ref-format refs/heads/<name>`。
  远程分支操作的目标必须由后端按 `git remote` 的最长远程名切分，并命中一个真实、
  非符号引用的 `refs/remotes/<remote>/<branch>`；不支持 `<remote>/HEAD`。
  删除只发送 `refs/heads/<branch>` 且不带 `--force`；
  拉取只抓取命名的 `refs/heads/<branch>` 到对应的 `refs/remotes/<remote>/<branch>`。
  `vcs.tag` 的 `action` 必须是 `delete` 或 `push`；`tag` 拒绝空串、超过 255 字符、空白或控制字符与 `-` 前缀，
  再通过 `git check-ref-format refs/tags/<name>` 并确认该 ref 存在；`push` 的 `remote` 必须命中 `git remote` 的结果。
  `vcs.commit-op` 的 `action` 必须是 `tag`、`branch`、`checkout`、`cherry-pick`、
  `revert`、`drop`、`merge`、`rebase` 或 `reset`；`sha` 为 7–64 位十六进制；
  `tag` / `branch` 的 `name` 复用引用名校验；`branch` 的可选 `checkout` 必须是布尔值；
  `tag` 的 `message` 是长度不超过 4,000 的字符串；`reset` 的 `mode` 必须是 `soft`、`mixed` 或 `hard`。
  同一共享存储同时只允许一次面板写操作，第二次返回 `409 busy`。

失败统一返回 `{ error: { code, message } }`，不携带宿主绝对路径、原始命令或堆栈：

| `code` | HTTP | 触发情形 |
| --- | --- | --- |
| `bad-request` / `not-a-repo` | 400 | 参数非法、仓库不在当前会话发现列表内，或所选工作树不属于该来源仓库 |
| `not-found` | 404 | 目标文件或提交不存在 |
| `no-session` / `no-cwd` | 409 | 会话不存在或无工作目录 |
| `output-too-large` | 413 | 子进程输出超出字节上限（`lossy`） |
| `vcs-missing` / `timeout` | 503 | 宿主缺少 `git`/`jj` 可执行文件，或命令超时 |
| `internal` | 500 | 未预期的后端失败 |
| `forbidden` | 403 | 浏览器声明为跨站的写请求，或非生命周期写请求携带 `worktree` 参数 |
| `busy` | 409 | 同一仓库已有写操作在进行 |
| `no-upstream` | 409 | 分离头指针、分支没有上游，或上游在远程上不存在 |
| `diverged` | 409 | 分支与上游各有新提交 |
| `pull-blocked` | 409 | 快进被拒绝（通常是本地改动会被覆盖） |
| `remote-failed` | 502 | 抓取或推送失败：远程不可达、凭据或远程钩子拒绝、与其他推送者竞争 |
| `switch-blocked` | 409 | 切换被拒绝（本地改动或未跟踪文件会被覆盖、分支已在别的工作树检出） |
| `switch-failed` | 409 | 切换命令因其他原因失败 |
| `worktree-path-invalid` / `worktree-revision-invalid` | 400 | 新建目录越界或路径不可用，或者起点无法解析为单个提交 |
| `worktree-exists` / `worktree-protected` / `worktree-in-use` / `worktree-locked` | 409 | 目录或登记已存在、目录受保护、会话正在使用或工作树已锁定 |
| `worktree-dirty` / `worktree-unreferenced` / `worktree-stale` | 409 | 工作树含不能安全保留的状态或文件、分离 `HEAD` 上有未保全的提交，或目标自确认后已变化 |
| `worktree-unsupported` / `worktree-failed` / `worktree-partial` | 409 | 后端能力不足、操作未完成，或仅部分变更已发生 |
| `branch-invalid` | 400 | 重命名的新名字不是有效分支名 |
| `branch-exists` | 409 | 重命名的新名字已存在 |
| `branch-unmerged` | 409 | 删除的分支未完全合并；客户端据此升级为二次确认 |
| `branch-in-use` | 409 | 目标分支已在另一个工作树检出，或试图删除当前分支 |
| `merge-blocked` | 409 | 合并被冲突、本地改动或未完成的合并阻止；自己发起的合并会中止，已存在的合并不被触碰 |
| `rebase-blocked` | 409 | 变基被冲突、本地改动或未完成的变基阻止；自己发起的变基会中止，已存在的变基不被触碰 |
| `branch-failed` | 409 | 分支命令因其他原因失败 |
| `tag-missing` | 404 | 标签不存在或已删除 |
| `remote-missing` | 409 | 标签推送目标不在当前仓库的远程列表中 |
| `remote-branch-missing` | 409 | 远程分支不存在、已删除，或目标是对应远程的符号 HEAD |
| `tag-push-failed` | 502 | 远程拒绝标签：不可达、凭据或远程钩子拒绝、远程已有不同对象 |
| `tag-failed` | 409 | 标签命令因其他原因失败 |
| `tag-invalid` | 400 | 提交菜单的标签名不合法 |
| `tag-exists` | 409 | 提交菜单要创建的标签已存在 |
| `checkout-blocked` | 409 | 提交检出被拒绝（本地改动或未跟踪文件会被覆盖） |
| `commit-not-on-branch` | 409 | 丢弃的提交不在当前分支上 |
| `commit-conflict` | 409 | 拣选、还原或丢弃冲突并已中止，分支保持不变 |
| `commit-blocked` | 409 | 提交操作被本地改动、已有操作或不支持的提交形态阻止 |
| `commit-failed` | 409 | 提交操作因其他原因失败 |
| `stale-diff` | 409 | 暂存目标已变化，或逐行选择的指纹与当前 diff 不匹配 |
| `staging-unsupported` | 409 | 当前目标或改动不支持请求的暂存操作 |
| `staging-failed` | 409 | Git 未能完成暂存或取消暂存 |
| `stage-history-stale` | 409 | 历史记录已变化，或索引条目、`HEAD`、工作树身份与预计状态不匹配 |
| `stage-history-unavailable` | 409 | 当前没有可重放的记录，或仓库状态、对象或索引布局不支持事务 |
| `stage-history-busy` | 409 | Git 索引锁已存在，或该仓库已有面板写操作 |

写操作失败时，`stderr` 末尾三行去掉 URL 中的凭据后只写入 Host 日志（`VcsError.detail`），不进入应答。

### 命令隔离与后端能力

两个后端共用 `CommandRunner`（`lib/command.js`），以固定 argv 直接执行子进程，不经过 shell；
环境收窄为 `LC_ALL=C` 加后端白名单，防止仓库配置重定向输出、拉起编辑器或持锁：

- **Git**：固定 `-c core.quotepath=false`，环境设 `GIT_CONFIG_COUNT=0`、`GIT_TERMINAL_PROMPT=0`、
  `GIT_OPTIONAL_LOCKS=0`；比较命令加 `--no-pager`、`--no-ext-diff`、`--no-color`、`-U3`。
- **Jujutsu**：固定 `--color=never`、`--no-pager`，环境设 `JJ_EDITOR=true`；
  除工作副本快照外的读取均带 `--ignore-working-copy`。

每个后端实现 `require`、`head`、`status`、`log`、`commit`、`diff`（可选 `untracked`、`worktrees`、`sync`、
`branches` / `switchBranch`、`branchOp`、`remotes` / `tagOp`、`commitOp`、`stage`）并声明 `capabilities`；
Client 仅按能力对象驱动布局，不按后端名称分支：

| 能力字段 | Git | Jujutsu |
| --- | --- | --- |
| `workingCopy` / `workingCopyNode` | `'row'` / `null` | `'commit'` / `'@'` |
| `staging` / `untracked` / `aheadBehind` / `sync` / `branchSwitch` / `branchOps` / `tagOps` / `commitOps` / `stageOps` | `true` | `false` |
| `changeId` / `snapshots` | `false` | `true` |
| `worktreeCreate` / `worktreeRemove` / `worktreeForget` | 创建及移除 | 创建、解除关联及按已安装版本开放移除 |
| `ranges`（`defaultRange`） | **`all`**、`HEAD` | **`all`**、`@` |

Git 工作树预览保留 Git 的读取能力。
单选其他工作树或多选时，Client 将 `sync`、`branchSwitch`、`branchOps`、`tagOps`、
`commitOps` 与 `stageOps` 置为 `false`，其他工作树的 `status` 也返回只读详情能力。
工作树菜单使用仓库级的生命周期能力，勾选范围不参与这类操作的授权。

两个后端的读写规则差异：

- **Git**：`head` 仅读取 `symbolic-ref -q --short HEAD` 与 `rev-parse -q --verify HEAD^{commit}`，不扫描索引与工作区；
  `status` 组合 `status --porcelain=v2 -z --branch --untracked-files=normal` 与两次 `diff --numstat -z`
  （index 与工作区），按 `XY` 拆成 `staged`、`unstaged`、`untracked`（两侧均改时各出现一次，冲突标 `U`）。
  `untrackedAdded` 在行数统计中纳入列表上限之外的文件。
  遇到折叠目录时用 `ls-files --others --exclude-standard -z` 枚举，统计普通 UTF-8 文本，末行没有换行符时也算一行。
  二进制、符号链接与嵌套 Git 仓库不参与统计。
  Host 每棵工作树最多并发读取 4 个文件，大于单文件 diff 字节上限时流式计数，30 秒内无法取得完整总数时返回 `null`。
  `diff` 按 `staged`（对 `HEAD`）、`unstaged`（对 index）、`untracked`（按新文件合成）、
  `commit`（对第一父，root 对空树）取值；空仓库读取 `HEAD` 日志视为空历史而非错误。
  `GitBackend.commit` 并行读取详情（`show`）、`HEAD` 符号/分支指向（`for-each-ref %(refname)%00%(HEAD)`、
  `symbolic-ref`、`rev-parse HEAD`）并在含远程引用时并行读取远程列表，为详情返回与 `log` 一致的 `current: true`、
  分离 `head` 及 `remote`/`branch` 标注。
- **Git 多起点历史**：在 `HEAD` 范围读取时，取所选树经校验的非空 `head` 对象 ID，
  去重后传给一次 `git log --topo-order`；没有已存在的 `HEAD` 就返回空历史。
  单选入口树时直接读取 `HEAD`，`all` 保持使用 `git log --all`。Client 把所选根路径集合纳入 `HEAD` 范围的分页键，
  下一页发现 `worktreeHeads` 已变更则重新载入首屏。 非默认树的单选和多选中，
  前端隐藏读取命令所在树的 `current` / `head` 装饰，改用工作区行显示各树的 `HEAD`。
- **Git 共享底层工具**：`lib/git-utils.js` 复用 `listGitRemotes`、`remoteNames`（上限 500）、
  `readBranchUpstream` 与 `runPorcelainPush`；`lib/ref-utils.js` 复用 `RESET_MODES`、`refExists`、`validateRefFormat`、
  `requireLocalBranch`、`runAbortableOp`、`mergeRevisionIntoCurrent` 与 `rebaseCurrentOntoRevision`。
- **Git 同步**（`lib/sync.js`）：复用 `readBranchUpstream` 与 `runPorcelainPush`，
  在远程不是 `.` 时执行 `fetch --quiet <remote>`，再用 `rev-list --left-right --count HEAD...@{upstream}` 比较：
  两侧都有提交返回 `diverged`；只落后执行 `merge --ff-only --quiet @{upstream}`；只领先推送且不带 `--force`，
  不跳过钩子，抓取与推送使用远程命令超时。
- **Git 分支切换**：
  `branches` 用 `for-each-ref --sort=-committerdate --count 501 --format=%(refname:short)%00%(HEAD) refs/heads` 读
  取本地分支，`current` 来自 `%(HEAD)`；只列 `refs/heads`，远程跟踪分支不在其中，也不会被检出为新的本地分支。
  `switchBranch` 先用 `requireLocalBranch` 确认目标，再用 `git switch --no-guess --quiet <branch>`；
  不带 `--force`、不贮藏、不丢弃改动，Git 自己拒绝会覆盖本地或未跟踪文件的切换，该拒绝映射为 `switch-blocked`。
  目标已是当前分支时直接返回，不执行命令。
- **Git 分支操作**（`lib/branch-ops.js`）：经 `runGitBranchOp` 统一分发；
  本地分支方法先经 `requireLocalBranch` 确认目标，当前分支上的删除直接返回 `branch-in-use`。 远
  程分支方法先用 `remoteNames`（`git remote`）按最长远程名切分 `remote/branch`，
  再用 `for-each-ref` 确认 `refs/remotes/<remote>/<branch>` 存在且不是符号引用；`refs/remotes/<remote>/HEAD` 一律拒绝。
  `checkoutGitRemoteBranch` 用 `git switch --no-guess --quiet --track -c <local> refs/remotes/<remote>/<branch>` 创建
  跟踪本地分支并检出，本地名已存在或无效时分别返回 `branch-exists` / `branch-invalid`，切换受阻返回 `switch-blocked`。
  `deleteGitRemoteBranch` 执行 `git push --porcelain <remote> --delete refs/heads/<branch>`，
  成功后删除对应的远程跟踪引用；远程拒绝返回 `remote-failed`。 `mergeGitRemoteBranch` 复用本地合并的冲突中止逻辑，
  只是目标 ref 换成远程跟踪引用。 `pullGitRemoteBranch` 先用
  `fetch --quiet <remote> +refs/heads/<branch>:refs/remotes/<remote>/<branch>` 更新该跟踪引用，
  再执行同一合并逻辑；抓取失败返回 `remote-failed`。
  `renameGitBranch` 经 `validateRefFormat` 校验并确认未占用，
  再执行 `git branch -m <old> <new>`（当前分支会随之移动 `HEAD` 的名称，
  upstream 配置由 Git 保留）。 `deleteGitBranch` 默认执行 `git branch -d`；未完全合并时返回 `branch-unmerged`，
  只有请求带 `force: true`（来自“仍然删除”）才执行 `git branch -D`。 `mergeGitBranch` 与 `rebaseGitBranch` 复用
  `mergeRevisionIntoCurrent` / `rebaseCurrentOntoRevision`，在 `MERGE_HEAD` / `REBASE_HEAD` 已存在时不触碰用户的操作，
  失败时仅当本次命令留下对应标志文件才中止，随后返回 `merge-blocked` / `rebase-blocked`。
  `pushGitBranch` 复用 `readBranchUpstream` 与 `runPorcelainPush`；不抓取、不快进、不带 `--force`，
  远程拒绝返回 `remote-failed`。
- **Git 标签操作**（`lib/tag-ops.js`）：经 `runGitTagOp` 统一分发；
  `remotes` 复用 `listGitRemotes` 读取并校验远程（最多 500 个）。
  `deleteGitTag` 与 `pushGitTag` 经 `validateRefFormat` 确认标签名并确认存在；
  删除执行 `git tag --delete <tag>`，只移除本地 ref。
  推送复用 `runPorcelainPush`（目标由 `remoteNames` 精确校验），不带 `--force`，
  远程已有不同对象时返回 `tag-push-failed`。
- **Git 提交操作**（`lib/commit-ops.js`）：经 `runGitCommitOp` 统一分发；
  `addGitTag` 经 `validateRefFormat` 校验并确认未占用后创建轻量或附注标签，
  空说明的轻量标签显式传 `--no-sign` 以免全局 `tag.gpgSign = true` 升格为签名标签并触发非交互编辑器失败。
  `createGitBranch` 校验 `refs/heads/<name>` 后，默认执行 `git branch <name> <sha>` 创建分支；
  当请求带 `checkout: true` 时改用 `git switch --no-guess --quiet -c <name> <sha>` 一步创建并检出（返
  回 `{ branch, sha, checkedOut: true }`），会被本地改动或未跟踪文件覆盖时返回 `checkout-blocked`。
  `checkoutGitCommit` 执行 `git switch --detach --quiet <sha>`。
  `cherryPickGitCommit` / `revertGitCommit` 复用 `runAbortableOp`，
  冲突时仅当留下 `CHERRY_PICK_HEAD` / `REVERT_HEAD` 才执行对应 `--abort`，返回 `commit-conflict`。
  `dropGitCommit` 要求目标在当前分支上、只有单父提交，
  经 `runAbortableOp` 执行 `git rebase --onto <parent> <sha> <branch>`。
  `mergeGitCommit` / `rebaseGitCommit` 与分支版本共用 `mergeRevisionIntoCurrent` / `rebaseCurrentOntoRevision`。
  `resetGitCommit` 只执行 `git reset --soft|--mixed|--hard <sha>`；Hard 是唯一会丢弃索引/工作区改动的路径，
  且必须由对话框明确选择。
- **Git 远程引用标注**：`log` 与 `commit` 在解析 `refs/remotes/...` 后，
  若有远程引用则通过 `remoteNames` 复用最长远程名匹配，给每个引用补上 `remote` 与 `branch`；
  `origin/HEAD` 这类符号引用不标注。
  前端据此只对带这两个字段的远程徽标开放菜单，服务端仍会再次校验。
- **Jujutsu 多工作区与快照**：手动刷新串行请求勾选工作区的 `status`，
  各通过一次 `jj log --no-graph -r @ -T commit_id` 快照，完成后再读历史。
  同路径的并发请求复用快照 Promise。自动状态与历史读取均从已有快照取数据。
  单选入口时读取 `::@ ~ root()`，其他选择用已验证的提交 ID 构造祖先并集；`all` 始终读取 `all() ~ root()`。
  历史不会启动快照；客户端按共享存储中的确切提交 ID 读取详情与 `jj diff --git -r <rev>`，也不触发快照。
  轮末 `head` 仅读取记录的 `change_id`。 `diff` 输出含 NUL 或 `U+FFFD` 时按二进制处理。
- **每轮摘要与头指针记录**：`createTurnTracker`（`lib/turns.js`）监听活跃会话的 `session/event`、
  `agent/turn-stopping`、`tools/pre-execute` 与 `session/disposed`，
  在有工具执行或 `workspace/changes` 的轮次结束时串行读取外围仓库的 `head`（下一轮工具执行前等待上一轮完成，
  防止跨轮切分支串台）。
  `vcs.turn` 通过 `ctx.get('workspaceChanges')` 可选读取宿主的每轮 `{ total, added, deleted }`
  （校验 `turn` 与 `seq` 归属一致，剔除宿主路径与文件明细），并与该轮 `head` 合并返回；
  两者均不存在（如 Host 重启后的历史轮次）时返回 `404 not-found`。

### 全景读取

`vcs.overview` 为[全景栏与平铺](DESIGN.md#全景栏)提供每个指针的基线、领先 / 落后、独有与占用。
带 `repo` 时只读这一个仓库，目标按读取路由的规则校验；参数无效或缺少后端命令时在流开始前返回 JSON 错误。
不带 `repo` 时沿用仓库发现及同仓库工作树的归组规则，每次最多读 4 个，读完一个就写出一行，单个仓库失败只写一行 `error`。
已登记的仓库读完后，Host 从会话目录逐层列目录（最深 6 层、最多 20,000 次列举，跳过 `.git`、`.jj`、`node_modules`，
只进入解析后仍在会话目录内的目录），把带标记、却与已登记仓库不共用后端元数据目录的仓库按 `registered: false` 写出；
主检出在会话目录外的仓库不列出。

每个 Git 仓库的读取：

- 检出来自经校验的 `worktree list`（与工作树菜单同一来源），
  每个检出用一次 `status --porcelain=v2 -z --untracked-files=normal` 计改动条目数（整次请求共用 4 路并发），
  用其 Git 目录下的 `rebase-merge`、`rebase-apply`、`MERGE_HEAD`、`CHERRY_PICK_HEAD`、
  `REVERT_HEAD`、`BISECT_LOG` 判断进行中操作。
  在 `default-workspace` 实测，51 棵工作树的状态读取共 526 ms（单棵最长 335 ms）。
- 一次 `for-each-ref refs/heads refs/remotes` 读出指针、上游与 `%(upstream:track)`；
  候选主线依次是各远程 `HEAD` 指向的分支、存在的 `main` / `master`，都没有时用主工作树的分支。
- 基线：Git 2.47 起每批 64 个指针用一次带多个 `%(is-base:<commit>)` 的 `for-each-ref`，没有候选选中时取最后一个候选。
  更旧的 Git 对每个候选跑 `rev-list --left-right --count`，取领先最少、其次落后最少的候选，平局按引用名顺序；
  在 `default-workspace` 上与 `%(is-base:)` 的结果 97/100 一致，差异来自它的第一父提交启发式。
- 领先 / 落后：Git 2.41 起每个基线一次 `%(ahead-behind:<base>)`，
  更旧的 Git 和游离检出用 `rev-list --left-right --count`。
  计数都以提交 ID 为键，引用名不进格式串。
- 独有：有远程的仓库读一次 `rev-list --parents --branches --not --remotes` 得到未发布子图，
  每个分支在子图内从自己的提交出发计数；子图超过 50,000 个提交时改为逐个分支 `rev-list --count <tip> --not --remotes`。
  游离检出计 `--not --branches --remotes`，无远程的仓库计对基线的领先数，贮藏记为 1。
- `stash list` 给出贮藏与它的基底提交，标签只计数；`fetchedAt` 是 common dir 下 `FETCH_HEAD` 的修改时间，
  DSH 文件服务不报告修改时间，这一处像刷新监听一样直接 `lstat`。

每个 Jujutsu 仓库按[书签与工作区的对应规则](DESIGN.md#jujutsu-的指针对应到同一组量)读取：

- `op log` 读取最近 2,000 个操作里的当前操作 ID 和抓取完成时间，其余命令都固定在该操作。
  全部命令带 `--ignore-working-copy`；操作日志头分叉、无法读出唯一操作时，只报告仓库读取失败，不合并操作。
  共置仓库用 `git root` 确认共享的 Git 目录，再将 `FETCH_HEAD` 的修改时间与抓取操作时间取较新的一项。
- `bookmark list --all-remotes` 读书签目标及跟踪状态，`workspace list` 读并核验工作区路径，
  `log --no-graph` 读取工作副本的位置和改动数、`trunk()`、匿名头，以及指针的提交摘要。
  `git remote list` 列远程，`tag list` 计标签。
  共用一个位置的工作区仍分别列在 `checkouts` 中，书签行优先显示有冲突或未保存改动的工作区。
- 基线距离、跟踪距离与独有从已校验的完整提交 ID 构造 revset，以 `jj log -T '"."'` 的输出长度计数。
  独有不依赖基线：有远程却没有基线时仍按 `::x ~ ::remote_bookmarks()` 计数。
  同一 revset 只读一次，整次请求最多并行 4 路计数；书签和匿名头各列至多 2,000 项，
  工作区至多 51 个，每项提交计数和标签数至多 50,000。
  超过这些上限时设置 `truncated`。

```ts
type OverviewRepository = {
  path: string; name: string; vcs: string; registered: boolean; supported: boolean
  remotes: string[]; fetchedAt: number | null; tags: number; truncated: boolean
  baselines: { name: string; ahead: number; behind: number }[]   // 相对第一个候选
  checkouts: { path: string; branch: string | null; head: string | null; primary: boolean; locked: boolean
    workingCopy?: string   // Jujutsu 的记录快照 @；head 是用来匹配书签的位置
    dirty: number | null; operation: 'rebase' | 'merge' | 'cherry-pick' | 'revert' | 'bisect' | 'conflict' | null }[]
  pointers: { kind: 'branch' | 'remote' | 'detached' | 'stash'; name: string; sha: string; time: number | null; subject: string
    base: string | null; isBase: boolean; ahead: number | null; behind: number | null; unique: number
    upstream?: string | null; track?: { ahead: number; behind: number; gone?: true } | null
    bookmarkConflict?: true
    checkout?: string | null; remote?: string; branch?: string; onto?: string | null }[]
}
```

### Git 暂存

`stageOps` 声明整文件暂存与取消暂存能力。
写入沿用同步、切换等仓库操作的目标范围，只接受授权的仓库入口（默认工作树），并与其他仓库写入共用写锁。
Client 仅在单选该 Git 工作树时开放操作。
整文件与逐行操作的写入目标均为 Git index。

- `scope` 决定方向。`unstaged` 与 `untracked` 执行暂存，`staged` 执行取消暂存。
  `path` 与可选 `oldPath` 是仓库相对路径。
  省略 `lines` 表示整文件操作。
- 目录与分组操作以 `files` 代替 `path`、`oldPath`、`fingerprint` 与 `lines`，
  `scope` 只能是 `unstaged`（暂存）或 `staged`（取消暂存）。 `files` 列出 1 到 1,000 项（两个状态分组上限之和），
  每项为 `{ path, oldPath? }`，路径不得重复；以 `/` 结尾的 `path` 表示整体暂存的未跟踪目录，
  只用于 `unstaged` 且不带 `oldPath`。
  Host 用一次 `git status` 核对已跟踪的改动，用一次 `git ls-files --others --exclude-standard` 展开未跟踪文
  件与目录， 任一项已不再是该方向的改动时返回 `stale-diff`，冲突文件与嵌套仓库返回 `staging-unsupported`，
  index 保持不变。 全部文件在同一个 index 事务内写入，暂存路径经 `git update-index --stdin` 传入，
  不受命令行长度限制。 只解析出一个文件时应答与整文件操作相同；多于一个时 `path` 是这些文件的共同父目录（带结尾 `/`，
  仓库根为空串），`fileCount` 是文件数，重命名计一个文件。
- Git 状态在截断文件分组前为同时有已暂存和未暂存改动的文件标记 `partiallyStaged: true`，供文件复选框显示混合状态。
- 合并视图按路径组织工作树文件。Git 文本比较的 `indexOid` 标识共享的 index 版本。
  两侧版本匹配时，Client 用 index 行位置对齐 hunk，共用上下文，并保留每行的源 scope 和 hunk 索引。
  重叠区域保留带标签的源 hunk。版本无法对齐或比较无法组合时，文件仍只有一个入口，展开后显示各自的比较结果。
- 支持逐行操作的 Git 工作区文本 diff 返回 `lineStaging: true` 和 `fingerprint`。
  通过行号悬停 `+`/`−`、行号列拖选 / `Shift+Click`、正文跨行拖选浮动按钮，或 hunk 标题文字按钮与 `s`/`u` 提交时，
  Client 提交该指纹及含对应行的 `lines: [{ hunk, line }]`。
  Host 也接受包含多行的请求。
  两项索引均从零开始，分别指向响应中的 `hunks` 和对应 hunk 的 `lines`，与界面行号和布局无关。
  合并视图按源 `origin.side` 在增删行标注 `data-stage-state`（`staged` 实色条、`unstaged` 虚线条）。
- 整文件操作支持二进制、符号链接、模式变化、删除及经 Git 状态验证的重命名。
  逐行操作适用于受支持的普通文件文本 diff，包括部分新增或删除。
  重命名、复制、模式变化、符号链接、子模块、二进制、超限或冲突 diff 不声明 `lineStaging`。
  未跟踪文本需由 Host 核对 UTF-8 内容与 Git diff 一致，可执行位遵循 Git 的 `core.fileMode` 设置。
- Host 在共享写锁内校验暂存目标。
  逐行操作重新读取文件 diff 并校验指纹和所选行，再以完整的 index 源 blob 构建补丁。
  源 blob 上限为 2 MiB，与 diff 输出和 Client 渲染上限分别校验。
  `git apply --cached` 在临时索引上校验原文。
  整文件与逐行写入共用同一 index 事务，在事务内核对受影响条目、`HEAD` 和索引锁。
  Client 在操作成功或收到 `stale-diff` 时刷新工作区状态与 diff，并沿用阅读锚点恢复。

### Git 索引撤销与重做

默认 Git 工作树的 `GET /api/vcs.status` 附带 `stageHistory: { undo, redo }`。
每个值为 `null` 或 `{ id, scope, path, lineCount?, fileCount? }`，说明对应方向的下一个操作；
目录与分组操作的 `path` 与 `fileCount` 与其应答一致。
Client 提交方向与当前记录 `id`，Host 在共享写锁内核对记录，拒绝其他面板已推进的历史位置。
操作完成后刷新状态与 diff；拒绝时保留历史位置与当前索引，面板显示具体原因。

- 每个工作树最多保留 32 条，Host 内存预算约为 1 MiB。
  只保留受影响的语义条目及用于验证的 `HEAD` 和仓库标识。
- Host 独占创建 Git 的 `index.lock` 后读取索引，将工作放在唯一的临时索引中，通过 `GIT_INDEX_FILE` 交给 Git。
  提交前再校验实际索引、锁和 `HEAD`，将锁原子重命名为索引。
  撤销和重做在锁内比较并更新目标条目，保留其他路径的索引改动。
  拆分索引在发布时可能转为完整索引，语义条目保持一致。
  Git 的索引锁约束索引写入，发布前另行复核引用和索引文件状态。
- 快照或恢复规则覆盖普通索引条目，包含文件模式和对象 ID。
  触及特殊标志或子模块索引条目时建立历史边界。
  仓库处于合并等未完成状态时，仍可暂存无冲突文件，成功写入后清空原历史。
  当前事务支持本地 `.git` 目录和经 Git 双向登记的链接工作树。
  远程执行环境、任意分离的 Git 元数据目录以及含稀疏目录条目的索引无法使用此事务。

撤销和重做的交互边界见 [工作区撤销与重做](DESIGN.md#工作区撤销与重做)。

## 核心数据形状

```ts
type RefKind = 'head' | 'branch' | 'bookmark' | 'remote' | 'tag'
// Git：HEAD 指向的当前分支带 current: true，分离头指针才单独出现 head
// Jujutsu：本地书签为 bookmark，远程书签为 remote（如 main@origin）
// Git 的远程跟踪引用额外带 remote 与 branch（如 origin + topic）；解析不出时为 undefined
type Ref = { name: string; kind: RefKind; current?: true; conflict?: true; remote?: string; branch?: string }

type CommitNode = {
  sha: string
  changeId?: string
  parents: string[]
  refs: Ref[]
  author: string
  authorTime: number
  subject: string
  workingCopy?: boolean
  empty?: boolean
  conflict?: boolean
}

type CommitDetail = CommitNode & {
  committer?: string
  committerTime?: number
  message?: string
  files: FileEntry[]
}

type BranchInfo = {
  name: string | null
  oid: string | null
  detached: boolean
  unborn: boolean
  upstream: string | null
  ahead: number
  behind: number
}

type WorkingCopyInfo = {
  node: string
  commitId: string
  changeId?: string
  parents: string[]
  refs: Ref[]
  subject: string
  author: string
  authorTime: number
  empty?: boolean
  conflict?: boolean
  summary: { changed: number; added: number; deleted: number }
}

type FileEntry = {
  path: string
  origPath?: string       // 重命名/复制的源路径（请求 diff 时传为 oldPath）
  status: string          // M | A | D | R | U；未跟踪项为 U
  untracked?: boolean     // 未跟踪：diff 按新文件比较，行上不显示增删行数
  added: number | null
  deleted: number | null
  binary?: boolean
  directory?: boolean     // Git 未展开的未跟踪目录
  conflict?: boolean
}

type VcsHunk = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]         // 保留 +/-/空格 前缀
}

type VcsFileDiff =
  | { kind: 'text'; path: string; before: boolean; after: boolean; hunks: VcsHunk[]; coarse?: boolean; lineStaging?: true; fingerprint?: string }
  | { kind: 'binary'; path: string }
  | { kind: 'oversized'; path: string }
// Client 视图层在此之上另有 'loading' | 'missing' | 'error' 三种状态

type TurnHead =
  | { kind: 'branch'; name: string }
  | { kind: 'detached' }
  | { kind: 'unborn' }
  | { kind: 'workingCopy'; changeId: string | null }

type TurnSummary = {
  turn: number
  head: TurnHead | null
  changed: number | null
  added: number | null
  deleted: number | null
}
```

## 上限

数据超限时返回 `oversized`、`truncated` 或截断提示；子进程超时或超限返回结构化错误：

| 项目 | 上限 | 执行位置 |
| --- | --- | --- |
| 单会话初始仓库根 / 附加工作树数 | 各 50 | Host `discoverRepositories` / `groupRepositories` |
| 全景：每仓库检出 / 指针 / 贮藏；未登记仓库的列举深度 / 列举次数 / 仓库数 | 51 / 2,000 / 200；6 层 / 20,000 / 50 | Host `overview.js` |
| 全景栏宽度 / 抽屉阈值；平铺每列历史 / 并发读取 | 320–600px（默认 400）/ 余宽 360px；300 个提交 / 4 | Client `state.ts`、`VcsView`、`useTileHistories` |
| 仓库发现标记检查 / 配置文件 / 每组配置路径与后端偏好 | 1,000 项 / 64 KiB / 50 项 | Host `repositories.js` / `repository-config.js` |
| 工作树状态读取并发 / 一次历史请求的工作树数 | Git 4、Jujutsu 1 / 51 | Client `VcsView` / Host `log` |
| Jujutsu `.jj/repo` 路径链接 | 16 KiB | Host `jjCommonDirAt` |
| 每组状态文件数（Git）/ 单提交详情文件数 / 未跟踪目录展开条目数 / 本地分支列表 / 远程列表 | 各 500 | Host `status` / `commit` / `untracked` / `branches` / `remotes` |
| 单文件 diff 输出 / 渲染行数 | 2 MB / 5,000 行 | Host `diff`、Client `FileDiff` |
| “全部展开”的 diff 预算 | 单文件 1,000 行；单节点累计 20,000 行 | Client `budgetFolds`、`expandedFileFolds` |
| diff 请求并发 / 视口预载距离 / 结果缓存 | 4 个并发 / 800 px / 最近 300 条 | Client 请求队列与缓存 |
| 历史分页 / 最多加载提交数 | 300 条/页，最多 10,000 条 | Host `log` |
| 单会话保留的轮末头指针 / 客户端空闲轮次摘要缓存 | 2,000 轮 / 500 条 | Host `TurnTracker`、Client `turn-summary` |
| 单条后端命令 | 30 s 超时（远程抓取与推送 120 s，含钩子），stdout 8 MB，stderr 尾部 16 KB，终止宽限 2 s | Host `CommandRunner`、`lib/sync.js`、`lib/branch-ops.js`、`lib/tag-ops.js`、`lib/commit-ops.js` |
| Jujutsu 快照频率 | 手动刷新每棵勾选树一次，有变更的 Agent 回合快照所在工作区 | Jujutsu 后端与 Host 订阅 |
| 加载轮廓与进度线的淡入延迟 | 180 ms（`--vcs-skeleton-delay`） | Client `styles.css` |
| 转动图标：巡航周期 / 起转 / 收尾滑行 | 900 ms 一圈（减少动效 2,400 ms）/ 加速 90° / 250–1,000 ms | Client `turning.js` |
| 进度线淡出 | 240 ms（`PROGRESS_FADE`） | Client `TopBar.jsx`、`styles.css` |

变更树当前一次渲染全部可见行，仅按需加载 diff 本体。

## Client 构建、宿主接缝与状态

### 构建与类型

源码是 TypeScript：宿主半在 `src/host/`，私有宿主模块在 `src/lib/`，客户端半在 `src/client/`。
[构建工具](scripts/build.mts)用 esbuild 从这些源码生成四组产物。

| 源码 | 产物 | 形态 |
| --- | --- | --- |
| `src/host/index.ts` | `index.js` | ESM，Node；`../lib/*.js` 说明符改写为 `./lib/*.js` 并保持 external |
| `src/client/index.tsx` | `client.js` | 单文件 CommonJS，外套 `window.__ModuleLoader__.load({ id, factory })` |
| `src/lib/**/*.ts` | `lib/**/*.js` | 每个模块单独产出，相对说明符保留 |
| `src/client/**/*.ts` | `lib/client/**/*.js` | 客户端纯模块镜像，供 `node --test` 直接 import |

`--check` 比对磁盘上的全部产物与源码，文件缺失或落后均会失败。
`client.js` 只把宿主模块表提供的 `react`、`react/jsx-runtime` 与 `@deepseek-ai/*` 设为 external，其余内联。
CSS 以文本打入 bundle，挂载时注入单个 `<style>`，类名统一使用 `vcs-` 前缀。
Git 忽略这四组产物。安装依赖和 `npm test` 都会生成它们，打包时 `lib/client/` 随 `lib/` 一并收录。
Node 原生擦除 `test/*.test.mts` 的类型，测试从客户端镜像导入纯模块。
[键盘测试](test/keyboard.test.mts)用 esbuild 在内存里编译 `.tsx` 组件。

`npm run build:tools` 按 [tsconfig.tools.json](tsconfig.tools.json) 严格检查 `scripts/*.mts` 并在同目录生成 `.mjs`。
`npm run build` 和 `npm run check` 都先编译工具。
npm 包收录工具的 `.mjs` 入口、`.mts` 源码及编译配置，供源码重建。
`tsc -p tsconfig.json` 以 `strict` 检查 `src/`。DSH 类型包只以 `import type` 使用：服务声明集中在 `src/dsh.d.ts`，
`Context` 来自 `@deepseek-ai/cordis`，产物里没有 `@deepseek-ai/*` 的运行时 import。
类型包版本由[版本同步工具](scripts/sync-types.mts)钉到运行中的 DSH 与 cordis。

八种界面语言各自保存在 `src/client/locales/{zh,en,ja,es,fr,de,ru,pt}.ts` 并由 `src/client/locales.ts` 导出，
注册到 `vcs` 命名空间；宿主 locale 服务只做扁平 `{name}` 插值，
需要按数量变化词形的键以 CLDR 复数类别后缀（`.one` / `.few` / `.many` / `.other`）存放，
由 `format.ts` 的 `formatPlural` / `pluralKey` 按 `Intl.PluralRules` 与各语言提供的类别集合（`PLURAL_CATEGORIES`：
`zh`/`ja` 为 `other`，`en`/`de`/`es`/`fr`/`pt` 为 `one`/`other`，`ru` 为 `one`/`few`/`many`/`other`）选键并格式化数字，
未知 locale 跟随宿主回退到英文，未声明的类别（如 `es`/`fr`/`pt` 面向简写词的 `many`）回落到 `other`。
插件列表展示名与描述位于 `locale/*.json`。

### 宿主接缝

Client 顶层注入 `['slots', 'locale', 'uiConversation', 'sidebarRight', 'sidebarRightTabs']`。
以下宿主接缝均设有明确的恢复或降级边界：

- **页签注册与崩溃隔离**：注册右侧栏页签类型 `{ id: 'dsh-vcs-panel', kind: 'vcs', guide: [...] }`，
  正文与标题分别注册到 `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title`，key 均为 `dsh-vcs-panel`。
  引导卡片用 `view.label` 作标题、`sidebar.guide` 作说明、轮末横幅的 `GitBranchIcon` 作图标，
  并显示快捷键；`order: 15` 让卡片紧跟在文件卡片（10）之后、终端（20）之前。
  正文内包 `ViewErrorBoundary`：捕获渲染错误后展示重试页，将时间、
  错误与截断至 12,000 字符的调用栈写入 `sessionStorage` 的 `vcs:last-error`，重试时保留原会话状态重新挂载。
- **Turn 改动判定与每轮摘要缓存**：`createTurnChangesDefinition` 注册 `vcs-changes` 事件定义，
  聚合每轮最新的 `workspace/changes` 事件序号（`seq`）与成功的文件写入工具结果；
  Conversation 引擎要求 Location 数据键与定义 `kind` 完全同名，因此键固定为 `vcs-changes`。
  `conversation.chat.turnTail` 条目（`order: -10`）仅在该标志为真时按 `(sessionId, turn, seq)`
  从 `turn-summary.js` 读取一次 `/api/vcs.turn`：已解析结果在客户端按 LRU 缓存，
  切回 Chat 直接同步渲染；`404`/`400`/`409` 记为 `missing` 不再重复请求（回退展示“打开版本管理”）；
  净改动文件数为 0 的轮次隐藏横幅；连接重置（`connection/reset`）时仅重拉未就绪条目。
  点击横幅调用 `ctx.sidebarRight.openTab('vcs')`。
- **入口与键盘焦点**：轮末横幅与全局快捷键打开同一个右侧栏页签。
  快捷键 `vcs.view.toggle` 在可选的 `['shortcuts', 'sessions']` 作用域注册（默认键位冲突时回退为空绑定），
  用 `mainSessionId` 与 `sidebar.mounted` 确认控制器作用在屏幕上的会话；
  右侧栏正展开且活动页签是 VCS 时 `hide(tab.id)` 收起右侧栏——页签与正文保持挂载，宿主滑走的是面板本身，
  避免关闭页签后先卸载内容再收起造成的跳变；否则 `openTab('vcs')` 打开或显示页签。
  正文通过框架注入的 `useTabInfo()` 读取 `tab`：`SidebarVcsView` 跟踪 `tab.visible` 与 `tab.navigation.revision`，
  从隐藏切为可见时即使 `revision === 0` 也递增 `focusRequest`；`VcsView` 在面板首次/恢复可见、
  `window` `'focus'` 与 `document` `'visibilitychange'` 时通过 `canClaimFocusFrom` 确认焦点闲置且无外部输入框、
  其他窗格或模态遮挡后把焦点放到当前活动停靠点（`timeline` 或 `tree`）。
  `.vcs-root` 通过 `onMouseDown`/`onClick`/`onKeyDown` 与 `isDiscreteActionButton` 让离散按钮点击与分支/Ref
  操作完成后无缝回归导航流（`Tab` 聚焦按钮按移动键也可回归，取消由键盘/详情徽标打开的菜单或弹窗仍归还给原控件），
  保留非空文本选区，并通过渲染期间焦点快照与 `useLayoutEffect` 同步恢复因渲染卸载停靠点而丢失的焦点。
- **全景与平铺的全屏与命令**：`SidebarVcsView` 从 `useTabInfo()` 读取 `sidebar.fullscreen` 与 `panel.isFloating`，
  需要宽度时用 `ctx.sidebarRight.commandTarget(.vcs-root)` 取得本页签所在窗格，再调用 `toggleFullscreen(target)`，
  与右侧栏自己的全屏按钮走同一个动作，不需要 `ctx.shortcuts.invoke()`。
  全景栏要求面板宽于“全景栏宽度 + 760px”，平铺要求 900px；浮动窗格、已全屏或足够宽时不请求，面板只归还自己请求过的全屏。
  「切换全景」`vcs.view.overview` 与「切换平铺」`vcs.view.tile` 在同一可选作用域注册，`defaults: {}`；
  命令解析出屏幕上的会话后，必要时先打开页签，再经 `commands.ts` 按会话投递，面板尚未挂载时命令等它订阅。
- **隐藏宿主改动卡片**：`workspace-changes` 拒绝 `maxFiles: 0`，因此 `cordis.patch.yml` 不改动宿主配置，
  改由样式规则 `[data-turn-tail] [data-changed-files] { display: none !important; }` 仅隐藏文件卡片，
  保留改动记录器与 `present` 交付卡片。
  宿主 DOM 标记变更时仅退化为重新显示原卡片。

### 状态持久化与锚点恢复

会话状态保存在 `sessionStorage` 的 `vcs:<sessionId>`，包含 `repo`、`worktrees`、`node`、
`nodeChosen`、`ref`（默认 `all`）、`dirs`、`collapsed`、`folds`、`anchor`（`{ key, offset }`）、`split`、`wrap`、
`mergeStaging`、`twoColumns`（`wrap`、`mergeStaging`、`twoColumns` 均默认 `true`，只有显式 `false` 才关闭）、
`sidebarWidth`、`timelineScroll`，以及全景与平铺的 `overview`、`overviewWidth`（320–600，默认 400）、`tiled`、
`overviewBeforeTile`、`tileOrder`（默认 `attention`，保留已保存的 `directory`）与展开的窄条 `tileExpanded`。
切换仓库时，`perRepoRef` 在内存按仓库保留勾选、选中节点、历史范围、详情锚点与展开状态。
`repositoryScrollRef` 单独保留各仓库时间线的滚动偏移；恢复时重读之前已加载的历史页，让偏移仍有对应的内容。
页签身份与右侧栏布局由宿主的 `sidebarRight` 存储按会话保存，应用重启后恢复；面板自己的阅读状态（含时间线宽度）单独保存。

`repo` 保存仓库入口。 `pickRepository` 保留仍可用的入口；入口消失时先找包含会话目录的仓库，再取发现列表第一项。
`worktrees` 保存当前仓库勾选的路径。
恢复时只保留目录仍可用的项，选集为空则回到入口树。 Git 工作区行与 Jujutsu 工作副本提交都可用 `worktree:<path>` 选中。
旧的单工作区节点 `worktree` / `@` 在恢复时归一为对应的工作树节点。 工作区状态和 diff 分别按根路径加载；
详情跨工作树切换时取消旧目录展开请求并重置目录阅读状态，避免串用同名文件和目录。

`folds` 只为用户显式操作过的文件保存布尔值：空记录表示文件全部收起，也就是详情的默认形态。
行键前缀白名单为 `staged|`、`unstaged|`、`merged|`、`merged-dir|`、`commit|`；
`sanitizeState` 在读取时丢弃未知字段与旧版遗留的 `untracked|` 键。 仓库范围、
仓库勾选与时间线分组的旧字段也按未知字段忽略。
数据刷新、折叠全部文件或收起吸顶文件头时，统一先记录锚点行与行内像素偏移，重排后恢复；
锚点行未渲染时沿“文件行 → 父目录链 → 分组行”降级。

顶部栏的仓库按钮写当前仓库名，按下开合[全景栏](#全景栏与平铺)，平铺时按下则退出平铺并打开全景栏。
工作树菜单由 `HeaderPicker` 打开，本地分支菜单每次打开时重读，期间保留上一份列表。
这两个菜单共用 `PickerHeader` 顶栏（`.vcs-picker-header`）：`.vcs-picker-header-title` 名称、可选的
`.vcs-picker-range` 分段胶囊（支持 `←`/`→` 与 `↑`/`↓` 导航）和 `.vcs-picker-actions` 里的 `PickerAction` 图标操作。
工作树菜单为 `提交` 配 `全部`/`仅所选` 与 `+ 新建`（`.vcs-worktree-create`）；
单工作树 Git 分支菜单为 `提交` 配 `全部`/`仅 HEAD`。
提交范围的选项来自 `capabilities.ranges` 并同步更新同一个 `ref`；
偏离 `defaultRange` 时仅在当前主入口触发按钮（单工作树 Git 为 `.vcs-branch-button`，
其余为 `.vcs-worktree-button`）标出 `data-filtered` 并附带 `FilterIcon`。 Jujutsu 按工作树路径索引工作副本节点，
将多个指向同一提交的工作区标记合并到该提交行，不生成虚拟节点。 顶部栏菜单与 `RefActionsMenu` 共用 `useFloatingMenu.js`，
统一处理外部指针按下、窗口尺寸变化、失焦退出与键盘移动。 菜单内部滚动不触发关闭；工作树菜单也忽略外部滚动，
以免调整视图引起的时间线重排打断连续操作。 `RefActionsMenu` 在 `useLayoutEffect` 实测宽高后做视口边界夹紧并设最大宽度。

工作树、分支、远程分支、标签与提交操作状态均收敛在 `useRepoActions.js`（由 `VcsView` 持有），维护单一 `menu`、
单一 `dialog`、共享的 `disabledActions` 禁用文案与按仓库区分的 `inFlight` 单飞映射（切换仓库时不丢失原仓库写入态）：
弹窗自身写入中进行时传入 `busy` 锁定关闭，
同仓库存在其他写入时传入 `blocked` 只禁用确认并显示 `error.busy` 而不阻断取消；
同步写操作结束时在同一渲染批次先启动刷新再释放单飞锁，保持同步图标连贯转动。
提交菜单打开前由 `reachableCommits` 与 `commitBranchRelation` 按已加载祖先关系裁剪不适用动作；
提交历史中的分支/远程分支/标签徽标与提交行、顶部栏分支控件及详情头部可交互引用按钮（`RefBadge` `onRefActivate`，
补充时间线每行最多 3 个徽标、超出展示 `+N` 的限制）均只上报目标与焦点归还元素。
标签推送对话框打开时加载 `/api/vcs.remotes` 并在关闭或切换仓库时中止。
检出（含创建分支立即检出）、远程检出、分支切换与 Hard 重置成功后清空旧 `HEAD` 阅读状态；
其他写操作保留当前阅读位置，若节点已被改写则由详情的 `onMissing` 回退。

### 图布局与变更树管线

- **时间线图布局**：`buildGraph` 接收勾选的工作树虚节点与一份拓扑序提交，按 `pass / goto / end` 遍历活动 lane，
  输出路径与圆点坐标，与虚拟列表共用滚动容器渲染。 每个 Git 工作树虚节点的虚线路径终止在它自己的 `HEAD`；
  多个虚线可终止于同一圆点。
  提交第二父等真实祖先边只复用实线。
  分页追加时重算整图并按提交锚点恢复位置。
- **时间线、详情缓存与变更树请求调度**：
  `Timeline` 在虚拟窗口 `[first, last)` 之外额外保留 `focusRow` 挂载以防止大幅滚动丢焦，
  通过 `useLayoutEffect` 同步滚入选中行，并支持 `PageUp`/`PageDown`/`Home`/`End`；
  `.vcs-ref` 使用 `inline-block` 以保证长引用省略号生效，
  时间线 `.vcs-timeline-meta` 让非 `HEAD` 徽标与作者/时间优先收缩以保住 `HEAD`（上限 110px）、
  `+N` 与短 SHA，详情工具栏的 `.vcs-detail-refs` 仅在有引用时渲染并横向滚动不压缩徽标；
  对话框 `<select>` 采用 `appearance: none` 单行截断并配 `.vcs-dialog-select-caret` 居中箭头与右缘渐隐遮罩。
  `DetailPane` 用 `${repo}|${node}|${revision}` 键缓存已读提交详情（`commitCache`，
  上限 `COMMIT_CACHE_LIMIT = 200`），避免反复切换提交重复请求，并在刷新或切仓时清空。
  时间线工作区行、详情工具栏与「未暂存」分组用灰色 `+N` 显示 `untrackedAdded`（`.vcs-untracked-stat`）。
  `0` 时隐藏灰标，无法取得完整行数时显示 `+…` 并在详情说明。
  灰标的悬停提示与读屏文本均说明行数口径。
  `untrackedTotal` 仍用于条目数，未跟踪目录按 Git 返回的条目算一项。
  窄栏可在工具栏下方显示同一组统计。
  变更树客户端将 Git 的 `untracked` 条目并入 `unstaged` 分组（可按需展开的未跟踪目录不参与单子目录链压缩），
  生成单一扁平行列表供渲染、roving tabindex 键盘导航与滚动锚点共用；文件默认收起，只有展开的行才请求 `vcs.diff`。
  发起请求时仍按条目自身的 `untracked` 标记还原 `scope`（未跟踪项走 `untracked`，重命名带 `oldPath`）。
  展开文件以 `<section class="vcs-tree-file" data-open>` 渲染为卡片（吸顶头部外框 `.vcs-tree-file-head-wrap`
  保留不透明底与暂存列，`flowTop` 按语义容器查找静态位置避免吸顶偏移干扰）。
  变更树的横向几何只在样式表里：目录、文件与加载行只写 `--vcs-level`（分组视图下为 `depth + 1`），
  样式表据此算出 `--vcs-indent` 与光标底左缘 `--vcs-pill-left`，
  暂存列宽 `--vcs-gutter` 由 `.vcs-tree[data-gutter]` 给出。
  行内容的左内边距、光标底 `::before` 的 `inset-inline`、
  卡片头框 `.vcs-card-head::before` 与 `.vcs-card-body` 的左右边距都取这组变量，
  因此展开不改动行本身的几何，卡片头框只在行下方绘制，不参与布局；
  变更树窄于 640 px（`SPLIT_MIN_WIDTH`）时将 `FileDiff` 的 `split` 置为 `false` 单栏渲染。
  展开文件由 `IntersectionObserver` 入队请求，离开视口时经 `AbortController` 取消。
  `.vcs-diff-surface` 启用 `container-type: inline-size`，
  非折行 hunk 标题以 `position: sticky; left: 0; width: 100cqi`（左右对比 `50cqi`）贴齐可视卡宽，
  避免含超长行时聚焦 hunk 将视野横向拖离行号列。
  `↑` / `↓` 或 `j` / `k` 沿一条纵向列表移动：分组、目录、文件行与展开文件的 hunk header 共用同一光标，
  hunk header 设 `tabIndex=-1` 以便程序聚焦但仍沿用行的 roving tabindex（整棵树只占一个 Tab 停靠点）；
  在可暂存工作树中，`FileDiff` 经 `onRegisterHunks` / `onRegisterSelectionClear` 向 `ChangeTree` 注册 hunk 操作与
  选区清理回调（`FileBody` 在合并视图多源退化时按序拼接），`s` / `u` 既作用于当前聚焦的分组/目录/文件行，
  也直接作用于当前聚焦的 hunk，并在刷新后优先恢复到同文件当前或相邻 hunk 标题；
  第 0 行按 `↑`/`k` 或 `[` 滚回 `scrollTop = 0` 查看提交头部；`[` / `]` 只按树行移动，
  `PageUp`/`PageDown`/`Home`/`End` 翻页并对齐光标与滚动；`→`/`l` 在已展开文件上进入首个 hunk，
  `←`/`h` 先收起展开文件再回到时间线，`Esc` 先清空行选区再返回时间线。
  滚动或点击 hunk 与无选区 diff 正文时同步光标、焦点与吸顶阅读位置；横向滚动保持 `overflow-x: auto` 零跳动，
  通过默认透明滑块与 `:hover` / `data-h-scrolling` 仅在悬停或横滚时显露滚动条。
  键盘匹配排除 `AltGraph`，保证需要 AltGr 输入 `[` / `]` 的键盘布局可用。
- **右侧栏布局**：`VcsView` 按自身宽度与 `twoColumns` 偏好决定栏数：
  `singleColumn = narrow || !twoColumns`，`narrow` 为根节点宽度 `< 760px`（`NARROW_WIDTH`）；
  不为对话输入框预留底部空间。 单栏时 `singleView`（`'timeline'` / `'detail'`）决定显示哪一栏，
  选中时间线节点或进入它时切到详情，返回按钮与 `Esc` 回到时间线。
  切换仓库或会话回到时间线。 根节点的 `data-narrow` 只管窄栏顶部栏换行与高度自适应（避免右端控件被裁掉），
  `data-single-column` 让时间线在单栏时占满整宽。
  顶部栏开关（`.vcs-columns-toggle`）调用 `setTwoColumns`：宽栏里关掉时有选中节点则切到详情；
  窄栏只改偏好，不改正在显示的栏。

### 全景栏与平铺

规则集中在 `overview/model.ts`，不依赖 React 与 DOM：

- **状态。** `repositoryView` 把 Host 的计数合成一个状态：检出有进行中操作或书签冲突时为 `op`，
  远程指针有本地对应时为 `shadow`（Git 的候选主线也算）、否则为 `foreign`，检出有改动为 `unsaved`，
  贮藏为 `stash`；其余按独有、领先与落后判为 `unique`、`diverged`、`behind`、`merged` 或 `synced`。
  Git 的候选主线本身带上游时改用 `%(upstream:track)` 计数；Jujutsu 始终保留与仓库基线的距离。
  列表省略 `shadow`；仓库按最重的状态排序，最重状态不重于 `foreign` 的仓库视为安静。
  七个筛选依次是未保存、独有（含分叉）、分叉、落后、已汇入、贮藏、进行中，也是平铺状态按钮与数字键 `1`–`7` 的顺序。
- **刻度。** 以基线为中心，每侧 29px，宽度取 `log10(1 + n) / log10(301)`，独有段至少 3px。
- **骨架。** `buildSkeleton` 用一列的已加载历史（`/api/vcs.log` 的 `all` 首页 300 个提交）保留指针所在的提交，
  以及沿第一父提交有两条以上通向指针的线经过的提交；之间的提交折成计数，连续的仅含标签的行合为一行，
  与本地分支同位的远程分支并入该分支，提交不在已加载历史里的指针列在列尾。
  lane 布局移植自原型的 `layoutLanes`。
- **遍历。** `traversal` 按列序、列内按骨架行序取命中的指针，`stepIndex` 两端循环；命中项所在的列是窄条时先展开。

数据由两个 hook 读取：`useOverview` 在全景或平铺显示时读一次 `vcs.overview` 流，逐行合并，
`done` 时丢弃本轮未报告的仓库；当前仓库的后台刷新信号在 400ms 防抖后只重读这一个仓库，
整轮读取期间到达的信号在读完后补读。
`useTileHistories` 在平铺时每次按发现顺序读 4 个仓库的历史首页，列序由 `tileOrder` 另行决定。
手动刷新时，两者等待 Jujutsu 的勾选工作区快照完成再读。

`OverviewPane` 以发现列表为切换入口：读取中的仓库按发现顺序显示指针行的轮廓，
读取失败的仓库带错误说明并排在「需要处理」末尾。
两类行都可以选中；时间线只读当前仓库，独立报告历史与工作树的读取结果。 栏头只用发现列表计数，
齿轮打开同一个 `RepositoryConfigDialog`，没有仓库时仍可进入，关闭对话框后焦点回到齿轮。
仓库行以 `repo:<path>` 为键，流式读取重排时光标与焦点留在原行；
当前仓库或光标所在的仓库进入一致组时自动展开该组。 用户打开全景时聚焦当前仓库，恢复已展开的布局时只设置默认停靠点，
不移动焦点；从时间线向左则回到全景上次的停靠点。

`overview/directActions.ts` 的 `tileDirectActions` 按[直接按钮的规则](DESIGN.md#操作条的直接按钮)从指针、仓库视图、
后端能力和该仓库的写入状态选出动作；移除工作树时再用工作树清单中的保护信息。 平铺沿用指针菜单的仓库切换和状态读取，
就绪后把显式目标交给 `useRepoActions.openAction`；
菜单选择也走同一入口。 依赖当前分支的合并和同步只在主检出同时为已授权仓库入口时提供，
工作树预览保持只读。 写入触发全景与骨架重读，结果按仓库显示；原按钮消失时，焦点留在同列的指针或列头。

布局：全景栏绝对定位在 `.vcs-root` 左侧，打开时根节点获得同宽的 `padding-left`，两者沿同一条曲线移动 280ms；
扣除全景栏后不足 360px 时改为顶部栏下的抽屉，选中仓库或指针后收起。
收起且不平铺时不渲染全景栏，根节点不带新增属性。平铺时 `.vcs-main` 换成 `TiledView`，
列出全部已发现的仓库；顶部栏保留仓库按钮，工作树、分支与同步控件换成状态按钮与列序开关。
「按关注」把需要关注的列排在前面、窄条排在最后；「按目录」始终按发现顺序排列。

进出平铺由 `overview/motion.ts` 做 FLIP：当前仓库的列从时间线 `.vcs-sidebar` 的位置展开，
其余列从全景仓库行（或一致组摘要）的位置展开，没有对应行时从面板左缘外 24px 滑入。
位移用 520ms 的 `cubic-bezier(.2,.7,.2,1)`，相邻列错开 26ms，最多错开 16 级。
退出时记录列的位置，时间线从当前列移回；其余列的不可交互副本向恢复的全景行或面板左缘移动，
并在 300ms 内沿 `ease-in` 淡出。
详情面板进平铺时原地淡出右移，退出时从右侧滑回。减少动效时不播放。
指针 id 由仓库路径、种类与名称以 NUL 连接；同名的 Jujutsu 匿名头再用提交 ID 区分。
元素按属性值比较查找，不进 CSS 选择器。

## 复用与来源

- **diff 与语法高亮**：外部插件不能加载 Harness Client 内部包，
  因此源码内嵌并适配 DSH 的 `FileDiff`（`src/client/diff/`），
  配合本地语法 tokenizer 引用宿主 `--shiki-token-*` CSS 变量跟随主题着色。
- **lane 图算法**：
  `src/client/history/layout.ts` 裁剪移植自 `git-graph-plus` 的 `git-graph-builder.ts`（commit `c6c2a9a`，
  源自 SourceGit `PathHelper`），移除本面板不使用的 upstream 可达性与分支自定义配色；不引入第三方运行库，
  也不采用禁止再分发的 `vscode-git-graph`。
