# @aiwayds/dsh-cron

## Unreleased

### Added
- **内附 skill 默认安装（dsh-cron-config）**：`skill/cron` 更名 `skill/dsh-cron-config`（生态惯例 skill 名一律 -config 结尾），插件 boot 时经 `ctx.skills.registerProvider` 挂载进宿主 skill 注册表（bundled rank 600，model+user 双可调用）——装插件即装 skill，卸载即消失零残留，旧的手动 `cp` 到 `$DSH_HOME/skills` 路径废弃（残留的旧 `skills/cron` 目录会遮蔽包内指南，README 提示清理）。`stripFrontmatter` 让 provider 供出剥掉 frontmatter 的正文（与 filesystem provider 同形）；dsh-skill 仅 type-only import（其发布 lib 会拖宿主 closure 兄弟包），`BUNDLED_SKILL_RANK` 本地拷贝。测试 +5（provider 注册/描述与 frontmatter 逐字节一致/名称 -config 惯例/正文剥离/stripFrontmatter 边界）。

## 0.6.0 (2026-10-21)

> Versions 0.4.0–0.5.1 shipped from this repo without CHANGELOG entries; see `git tag -l` and npm for those.

### Changed
- **任务必须绑定会话，禁止全局投递（ADR 0010，推翻 ADR 0001 的投递半边）**：`cron_create` 新增 `attach` 参数——`creator`（默认，绑定创建时的会话，即 `agent.id`）| `new`（插件当场 `ctx.agents.create()` 开专属会话 `session-<uuid>`，cwd 继承创建者；后台监控与对话隔离）。引擎 `targets()`（投给任意首个活 root）删除，改为 per-task `resolveTarget`：活查 `ctx.agents.get(sessionId)` → 冷走 `ctx.sessionController.resolveAgent` 按需恢复会话投递 → 查无/子代理拒 → 按 ADR 0002 skip。生命周期对齐官方 dsh-schedule：`workspace/session-stop` 取消该会话全部任务（归档 cancelled）、带活跃任务的会话经 `workspace/session-activity` waterfall 拒绝归档、boot 时对绑定会话查无（活表+持久化都没有）的任务一次性归档 cancelled。子代理会话双侧拒绝（创建即拒；投递侧 `delegationDepthOf` 对齐 dsh-subagent 公式内联）。存量升级：pre-0010 无绑定任务文件宽松读入、rehydrate 时全部归档 cancelled（store 不静默丢弃）。/cron 命令面：`--new-session` 旗标、list/describe 展示 `attach`+`session`。新增 `src/attach.ts`（结构切片依赖注入，可离宿主单测）；devDeps 加 `@deepseek-ai/dsh-workspace`（type-only augment：SessionActivityKindMap `cron: true` + workspace 事件），cordis dev pin 4.0.4→4.0.5（dsh-workspace peer 要求 ~4.0.5）。测试 55→75（scheduler 绑定/专属会话/unbound 迁移 + attach 模块 9 例 + tools 子代理拒绝/绑定字段 + store 旧格式兼容读）；真实宿主 boot smoke 过。
- **0.2.1-rc.2 wave**: devDeps `@deepseek-ai/*` pins `0.2.0-rc.2` → `0.2.1-rc.2` (pnpm lockfile advanced; peer floors unchanged — pre-flight `includePrerelease` already matches 0.2.1-rc.2), CI closure tower restored to newest-of(latest,next) with a prerelease-aware compare (10-17 pin undone); boot-smoke fix: the scratch consumer profile now disables npm peer auto-install (`legacy-peer-deps=true`) so foreign-tower `@deepseek-ai` copies cannot shadow the host closure — on a 0.2.1-rc.2 host npm resolved the hard `>=0.2.0-rc.2` peers to `0.2.0-rc.2`, the host compat gate disabled the shadowed rows and a required plugin never activated (the failure mode the optional-peer contract exists for); verified against a 0.2.1-rc.2 closure: typecheck clean, 55/0 test assertions + packaged-install pass, boot smoke pass.

### Fixed
- **The published tarball is npm-installable** — `postinstall` runs `node scripts/link-dsh-closure.mjs`, but the `files` allow-list never shipped `scripts/`, so every non-link install (plugin manager, plain `npm install`) died in the lifecycle step with `MODULE_NOT_FOUND` — the same defect class as fan56/dsh-subagent-registry#2. `scripts/` now ships, and the linker's stand-down guard swapped the fragile marker check for `tsconfig.json` + `.git`. `test/packaged-install.test.mjs` packs, installs the tarball under npm with lifecycle scripts on, and asserts the linker stood down; the boot smoke installs via npm for the same reason and asserts the stand-down against the real host.


### Changed
- **dsh host floor 抬至 0.2.0-rc.2**：peer floors `>=0.2.0-rc.2`、dev pins exact `0.2.0-rc.2`（README support floor 随动）。零代码变更：`MessageSourceMap{cron}` 契约在 0.2.0 不变（单元测试 7 文件 55 例全绿 + `tsc --noEmit` 对 0.2.0-rc.2 闭包零错）。cron 容器 e2e 本波跳过（零代码变更记档）。
- **README 定位口径更新（docs-only）**：官方 dsh 0.2.0 把官方自动化 schedule 变成 OPTIONAL_BUNDLE 默认关闭——升级后既有官方定时任务静默停摆，须手动开启；"Why not dsh-schedule?" 节补一段差异化：dsh-cron 是独立常驻的定时任务插件，注册自有 cordis 插件与时钟、不依赖官方 bundle，安装即生效（开箱即用 vs 官方默认关），两者作用域不重叠（session 级提醒 vs profile 级 cron）可共存。不发版。
- dsh closure 升至 0.1.7-rc.1（peer floors `>=0.1.7-rc.1`、dev pins exact、README support floor；cordis 4.0.4 / schemastery 3.18.4 随动）。
- settings 迁到 0.1.7 新体系（`SettingsScope`/`register` 已删，编译所需）：`Config` schema 以模块级导出声明（四键全部 volatile），`apply(ctx, config)` 经 volatile 引用读值；ns 语义从旧命名空间 `cron` 变为 profile entry id `dsh-cron`——旧 settings.yaml 的 `cron:` 段被宿主一次性导入静默丢弃（自动迁移见下条），原文留在 `settings.yaml.imported`。
- **旧 settings 段一次性自动迁移（0.1.5→0.1.7 升级无感知）**：宿主把旧 settings.yaml 按「section 名 = entry id」一次性导入并改名 `settings.yaml.imported`，而本插件旧段名是 `cron` ≠ entry id `dsh-cron`——用户的旧配置被静默丢弃。新增 `src/legacy-import.ts`：boot 时读 `settings.yaml.imported`（兜底 `settings.yaml`）的 `cron:` 平铺段（纯函数解析器：只收直接子级标量，剥引号、number/boolean 推断、单行引号包裹的流式 JSON 解析；嵌套块/折叠值保守跳过），仅把「旧值 ≠ 当前生效值」（volatile ref `.get()` 读）的键经 `ctx.settings.update('dsh-cron', patch)` 写回，成功后落审计档 `<home>/storages/dsh-cron/legacy-import.json`（`{at, outcome, source, imported, skipped}`，outcome 含 imported/no-op/no-legacy/no-section）——marker 已存在则整个迁移跳过（幂等防复活）；update 失败不写 marker 下次 boot 重试；settings seam 不可用不读不写；全程 try/catch 只 warn，绝不影响激活。`apply()` 改为 async（import 位于函数体末尾，其上全部注册保持同步；cordis 将返回的 promise 作为 setup barrier 等待）。测试 +18（`legacy-import.test.mjs`：解析器纯函数 7 例 + fake-seam 导入逻辑 11 例）。
- 投递消息 source 从已删除的 `{ kind: 'plugin', plugin: 'cron' }` 改为 `{ kind: 'user' }`（0.1.7 消息源为 merge-extensible sum、无共享 plugin kind；与官方 dsh-acp 桥接外部 prompt 同款写法）。
- `agent/created` 监听器按 0.1.7 串行契约显式返回 `undefined`（监听器抛错会回滚 agent 创建——工具注册路径未变，仍由 agent 本地 effect 承载）。
- boot 链复核：rehydrate 为 `void …catch()` 异步不阻塞、tick 循环 `setInterval(…).unref()`——确认无阻塞点。
- Plugin Manager 展示元数据：新增 icon.svg 与 locale/{en,zh}.json（`meta.title`/`meta.description`，官方 readPluginMeta 约定），package.json 声明 `icon` 并将两者入包。
- e2e 配置面迁到 0.1.7 原生形态（10-install 直写 profile patch）：旧 settings.yaml 写法在 0.1.7-rc.1 宿主上与 TUI 冷启 footer seed 存在导入竞态——首启导入完成前 footer 回落宿主内置默认模型，20-boot 的 mock provider 断言在 0.3.0 与迁移树上同样翻红（容器内对照实验定谳：patch 直写即刻恢复 mock 显示）；且旧 `cron:` 段在 Config/entry-id 形态下不再自动导入，tick 1000ms 提速本已失效。mock providers / agent-default-model / dsh-cron tick 三块现都写进 profile 的 cordis.patch.yml。
- e2e 恢复 settings.yaml 导入路径作金丝雀（10-install）：dsh-tui-pi 侧已修复冷启 footer seed 竞态（footer seed 延迟到 settings/document-updated，导入落地后组合默认值补上），mock providers 与 agent-default-model 两块改回 settings.yaml 写法以持续覆盖 0.1.7 首启导入；dsh-cron tick 提速仍留在 profile patch（旧 `cron:` 段 entry-id 形态不导入）。
- 投递消息 source 从 `{ kind: 'user' }` 改为自有 kind `'cron'`（MessageSourceMap 声明于 fire-message.ts）——为下游按 turn 源分类留出 durable 标记（首个消费者 @aiwayds/dsh-approval-policy 的无人值守审批门控）；旧 kind 与人手敲无法区分。

## 0.3.0 (2026-09-11)

### Changed
- dsh closure 升至 0.1.5-rc.2（dev pins、overrides、locks、README support floor；rc.2 无 API/协议变化，纯依赖跟进）。
- dsh closure moved to 0.1.5-rc.1（dev pins、overrides、locks）。
- e2e runner：registry 标志改为标量，bash 3.2 的 `set -u` 不再被空数组展开卡住（与 dsh-tui-pi 的 runner 同款修复）。

## 0.2.1 (2026-09-05)

Clean uninstall, documented and proven:

- README gains an Uninstall section: the removal command, what the host
  auto-cleans (bundles entry + patch layer — schedules silently stop firing),
  what stays on disk and why (`storages/cron/` task files and `_history.json`
  are kept so a reinstall rehydrates them), the purge command, and the ADR
  0002 reinstall semantics (downtime-accrued occurrences are skipped; missed
  one-shots are archived as `missed`, never delivered late).
- The boot smoke (`scripts/smoke-boot.mjs`) adds an uninstall leg: after the
  boot proof it runs `dsh plugin --profile smoke remove` and asserts the
  composed tree is reconciled back to stock (plugin id gone from a fresh
  `--dump-config`).

## 0.2.0 (2026-09-03)

Rides the dsh RC/stable line; the alpha line is retired (policy 2026-09-03):

- CI and release workflows install the dsh CLI by resolving the newest of the
  `latest` (stable) and `next` (rc) dist-tags at runtime — never `@alpha`,
  never hand-pinned. When a stable 0.1.2+ lands on `latest` it wins over the
  rc by plain semver compare.
- Dependencies: peer floors move to `>=0.1.2-rc.1` and the dev closure is
  pinned exactly at 0.1.2-rc.1 (was 0.1.2-alpha.4).
- README now states the plugin targets the dsh RC/stable line only — the
  alpha line is no longer supported.

## 0.1.0 (2026-09-02)

Initial release: bounded cron tasks with calendar & interval rules, per-task
delivery policy (followup | steer), sub-agent execution with cron_report
backfill, per-task fire-record retention (default 7), profile-level
persistence, and /cron command.

Ships with a credential-free podman e2e suite (e2e/) that drives the real
TUI against a scripted mock LLM through the whole chain — create, 60s fire,
followup delivery, cron_report backfill, sub-agent mode, expiry archiving,
and the /cron command surface.
