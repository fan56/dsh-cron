# @aiwayds/dsh-cron

## Unreleased

### Changed
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
