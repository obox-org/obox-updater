# Obox 更新（obox-updater）

从 GitHub Release（`obox-org/obox`）拉取并安装 obox 更新的**更新提供者扩展**：在「设置 → 更新」里选中本扩展后生效（更新提供者只能有一个）。

- 形态：**用户扩展**（`.oix` 分发，源码即本仓库）；与 obox 只有扩展 API 依赖
- 界面：只有一个**状态栏项 + 两个命令**，没有 App 卡片/页面（因此入口不生成 HTML、不碰 DOM）
- 运行期零第三方依赖：除注入的 `api` 外只用标准 JavaScript，不 `import` 任何裸模块

## 1. 运行位置（obox 2.0 起：Extension Host Process）

obox `v2.0.0` 起用户扩展默认在 **Extension Host Process**（主进程用 Electron `utilityProcess` 拉起的独立 **Node 进程**，入口按 `file://` 动态 `import()`）里执行：**没有 DOM / `window` / `document` / `localStorage`**。可在「设置 → 通用 → 在独立进程中运行扩展」关掉（**需重启**），此后扩展回到渲染进程执行。宿主模式默认开。

本扩展**两种模式写法一致**，因此两边都能跑：

- 只用 `api.statusBar` / `api.registerCommand` / `api.update`（`getVersion` / `resolveFeed` / `check` / `download` / `install` / `onEvent`），以及「下载离线安装包」用到的 `api.net.get` / `api.net.download`（**obox 2.2.0 起**，老宿主上该命令给出明确提示而不是报网络错）
- 不用 `document` / `window` / `localStorage` / `navigator` / `Image` / 全局 `fetch`（网络全在 obox 主进程里，走 `api.update` / `api.net`）
- 不 `require('electron')`、不用 `import.meta.url` 拼 `app://` URL、不做 `fs` 读写、不用 `setInterval`
- 状态栏文案只是**普通字符串**（宿主生成、渲染侧渲染），不含 HTML/SVG

## 2. apiVersion 与激活时机（宿主模式适配的结论）

| 项 | 值 | 结论与理由 |
| --- | --- | --- |
| `apiVersion` | `1`（**不变**） | 本扩展**不依赖宿主专有能力**——不需要完整 Node、也不要求"无 DOM 才成立"：用到的 `api.update.*` 在扩展宿主进程与渲染进程里是**同签名**实现。保持 `1` 可同时在 **obox 1.0.x 与 2.0.x** 上加载（写 `3` 会被 `apiVersion ≤ 2` 的旧宿主直接拒绝加载，见 obox `manifest-reference.md` 的 `apiVersion` 行）。**兼容 1.0.x 与 2.0.x。** 「下载离线安装包」依赖的 `api.net.get` / `api.net.download` 是 **obox 2.2.0 的纯加法能力**（`apiVersion` 仍为 4），因此那条命令用**特性检测**降级，而不是把整个扩展的加载门槛抬到 2.2.0。 |
| `activationEvents` | **不声明**（缺省 = `*`，启动后立即激活） | 本扩展是更新提供者，必须**启动后随时**响应"检查更新"；而且状态栏项要立刻显示版本、`api.update.onEvent` 要先订阅上（下载进度/完成都靠它）。若改成 `onCommand:`/`onView:`，首次点击前状态栏是空的、更新事件也收不到——这不是"更现代的懒激活"，是换来了功能缺失。只有"完全由命令/视图触发"的扩展才该改，本扩展不是。 |

## 3. 命令与状态栏

| 贡献 | id | 说明 |
| --- | --- | --- |
| 命令 | `obox-updater.check` | 检查 Obox 更新：解析更新源 → 检查 → 有新版本自动下载 → 提示重启安装 |
| 命令 | `obox-updater.forceReinstall` | 强制重装 / 降级：直接下载安装包、校验 sha512、启动安装向导（绕开 electron-updater 的版本门控；应用不退出） |
| 命令 | `obox-updater.downloadInstaller` | **下载离线安装包**：用 `api.net.get` 读 `latest.yml`、`api.net.download` 把安装包流式下到本扩展 data 目录的 `installers/`（**obox 2.2.0 起**） |
| 状态栏项 | `obox-updater.status` | 右对齐、priority 5；文本显示当前版本 / 进度 / 结果，点击 = 执行"检查 Obox 更新" |

三个命令都进了命令面板（`palette: true`）。

## 4. 更新源解析

检查与强制重装共用同一套解析语义（`resolveFeedUrl`）：

1. `api.update.resolveFeed('obox-org/obox')` —— 取最近若干 release 中**第一个可用**（非 draft、非 prerelease、资产含 `latest.yml`）的 `releases/download/<tag>/`；不依赖 GitHub 的 latest 标记；
2. 解析失败（或旧宿主没有 `resolveFeed`）→ 回落 `manifest.contributes.updater.feedUrl`（即 `releases/latest/download/`）。

`forceInstall` 与 `install({force:true})` 会把解析得到的 `feedUrl` 显式传给宿主；省略时宿主回落到 manifest 声明的 `contributes.updater.feedUrl`。

### 4.1 下载离线安装包（`api.net`，obox 2.2.0 起）

命令「下载离线安装包（到本扩展数据目录）」不改动更新链路，只是把安装包**自己**下到磁盘，便于离线/多机安装：

1. 解析更新源（同 §4）→ `api.net.get(<feedUrl>/latest.yml)`；
2. 解析 `latest.yml` 的顶层字段（`version` / `path` / `sha512`；本扩展用极简解析，不引 YAML 依赖）；
3. `api.net.download(<feedUrl>/<path>, 'installers/<文件名>', { onExist: 'overwrite' })` —— 宿主**流式写盘**、不整包进内存、自动使用**设置-网络里的代理与「忽略 SSL」**；
4. 状态栏显示 `已下载安装包 vX.Y.Z：installers/<文件名>（xxx MB）`。

关键约定（obox `api.net.download` 的语义，见 obox `docs/extension-api/api-reference.md`）：

| 项 | 说明 |
| --- | --- |
| 落点 | **本扩展自己的 data 目录**（`%APPDATA%\obox\extensions\obox-updater.obox-org\data\installers\`）；扩展只给相对路径，绝对路径与 `..` 由宿主拒绝 |
| 上下文 | 扩展 id 与 data 目录由**宿主按扩展注入**——扩展不需要（也拿不到）绝对路径 |
| 覆盖 | `onExist: 'overwrite'`：重复下载同一版本是覆盖，不产生 `xxx (1).exe` 副本 |
| 大小 | 流式写盘，无 8MB 响应体上限；整体有 15 分钟兜底超时（不受宿主 RPC 3 秒 ack 限制，见 §5） |
| 校验 | 本命令**只负责下载**，不做 sha512 校验（校验在宿主「强制重装」通道里做）；需要自证时可对照 release 页的资产信息 |

老宿主（< 2.2.0）没有 `api.net.download`：命令直接提示「下载离线安装包需要 obox 2.2.0 及以上」，不会假装网络失败。

## 5. 宿主模式的已知限制（3 秒 ack 超时）

obox 宿主内部 RPC 的 ack 超时是固定 **3 秒**（`ACK_TIMEOUT_MS`，语义是"只观测、不杀"，见 obox `docs/extension-api/api-reference.md` 的「宿主模式的降级与限制」）。这对本扩展的影响与当前处理：

| 调用 | 宿主模式下的实际行为 | 本扩展怎么处理 |
| --- | --- | --- |
| `api.update.download()` | 要等**整段下载**（几分钟）⇒ 必先收到 `EH_TIMEOUT`；main 的下载仍在继续 | **不把超时当失败**：状态栏停在「下载中…」，进度与完成由 `onEvent`（`download-progress` / `update-downloaded`）接管（`index.js` 的 `isAckTimeout`） |
| `api.update.install({force:true})` | 同上（下载安装包 + 校验 + 启动向导比 3 秒长得多） | 同左：超时后提示「下载安装包中…（完成后自动打开安装向导）」，`update-downloaded` 事件到达时显示「已启动安装 vX（按向导完成）」（不是"重启安装"） |
| `api.update.check()` / `resolveFeed()` | 慢网络/慢代理下也可能超过 3 秒 | `resolveFeed` 失败本来就会回落兜底源；`check` 超时提示「检查超时，请重试」（再点一次通常命中 main 侧进行中的检查，见 `updater.ts` 的互斥复用） |
| `api.net.download()`（下载离线安装包） | **不受 3 秒 ack 限制**：宿主给这条内部 RPC 单独放宽到 **15 分钟**（与 main 的下载兜底一致） | 仍然不阻塞状态栏：进度只有"下载中…"→"已下载"，没有百分比（`api.net.download` 只回最终结果） |

**残余缺口（需要宿主侧修）**：强制重装若在 3 秒之后才失败（例如 `latest.yml` 404 之后的长时间下载、sha512 不匹配），main 返回的**具体原因**会被已经超时的 RPC 丢掉（main 的 `forceInstallFromFeed` 失败分支不发 `update` 事件），状态栏只能停在「下载安装包中…」。正解是宿主给 `update.download` / `update.install` 单独放宽 ack 超时（或让 main 立刻返回、只走事件），不是扩展能补的。

另外两条与本扩展相关的宿主差异（记录，不影响功能）：

- **`update.onEvent` 最多晚 250ms**（main → 宿主事件是 250ms 轮询，不是推送）——进度条按"可能延迟一个轮询周期"看；
- **`.oix` 热装卸未与宿主对齐**：清单只在宿主 `init` 时交接一次 ⇒ 安装/覆盖升级本扩展后要**重启应用**才生效（obox 迁移文档技术债 #20）。

## 6. 开发、测试与打包

```bash
npm test            # node --test：入口行为 + 打包产物门禁（零依赖，无 npm install）
npm run pack        # 零依赖手写 stored zip → out/obox-updater-<version>.oix（自带回读自检）
npm run check:feed  # 开发者脚本：直连 GitHub 看最新 release 的 latest.yml 是否可用
npm run release     # test + pack
```

- 本扩展**无构建步骤**：入口就是 `index.js`（纯 ESM，无 Vite 转换），`manifest.main` 指向它
- 打包只收 `manifest.json` / `index.js` / `icon.svg` / `LICENSE`（缺图标/许可证时自动跳过）；`test/`、`scripts/`、`README.md` 不进 `.oix`
- 在 obox 仓库根调本地代码（改完重载窗口生效）：

```bash
npm run dev -- -- --debug-extension obox-updater@C:\绝对\路径\extensions\obox-updater
```

- 调试态扩展的 id 是 `--debug-extension` 里写的那个（`obox-updater`），**不是**安装后的目录名（`<name>.<清洗后 author>`，如 `obox-updater.obox-org`）

## 7. 安装与升级

1. 扩展管理器 →「安装扩展」→ 选 `out/obox-updater-<version>.oix`（或把 `.oix` 拖进管理器）；
2. 打开「设置 → 更新」，把**生效的更新提供者**选为「Obox 更新」（不选则 `api.update.*` 会抛"当前扩展不是生效的更新提供者"）；
3. 升级本扩展 = 覆盖安装同一个 `.oix`；**装完重启应用**（见 §5 的热装卸限制）；
4. 需要重装/回退到某个发布版时，用命令「强制重装 Obox（直接下载并运行安装包）」。

## 8. 相关文档（obox 仓库内）

- 运行模型与降级登记：`docs/extension-api/api-reference.md`（「运行模型」、「宿主模式的降级与限制」）
- 用户扩展开发指南：`docs/extension-api/guides-user.md`
- 清单字段与 `activationEvents`：`docs/extension-api/manifest-reference.md`
- 宿主进程迁移与技术债：`docs/extension-host-migration.md`
