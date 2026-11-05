/**
 * Obox 更新提供者扩展（非内置）。
 * 从 GitHub Release（obox-org/obox）拉取 obox 更新：
 * - 优先经 api.update.resolveFeed('obox-org/obox') 动态解析"最后一次编译"的 release 更新源
 * - 解析失败（或旧宿主无 resolveFeed）时回落 latest 兜底源（releases/latest/download/）
 * - 在"设置-更新"选中本扩展后生效（只能一个更新提供者）
 * - 提供命令"检查 Obox 更新"与状态栏项，调用 api.update 检查/下载/安装
 * - 另提供命令"强制重装 Obox"：调用 `api.update.install({ force: true, feedUrl })`，
 *   由宿主**直接下载安装包并运行安装程序**（绕开 electron-updater 的版本门控）——
 *   用于修复损坏安装，或从更新的本地构建回退到发布版（见宿主 docs/update-and-release-verification.md）
 *
 * 注意：用户扩展入口为纯 ESM JavaScript（宿主动态 import，无构建转换）。
 */

// obox 发布仓库（release 资产：x64/arm64 安装包 + latest.yml）
const REPO = 'obox-org/obox'
// 兜底更新源：动态解析失败（或旧宿主无 resolveFeed）时使用 GitHub 的 latest 下载目录
const FALLBACK_FEED_URL = 'https://github.com/obox-org/obox/releases/latest/download/'
// 离线安装包的落盘目录（**相对本扩展 data 目录**，由宿主注入上下文，扩展不需要也不该知道绝对路径）
const INSTALLER_DIR = 'installers'

/** 归一化版本号显示：统一带 v 前缀（tag 通常已是 v1.2.3，available 可能不带） */
function withV(version) {
  return typeof version === 'string' && version.startsWith('v') ? version : `v${version}`
}

/**
 * 极简 `latest.yml` 解析：只取**顶层** `key: value`。
 *
 * electron-builder 生成的 latest.yml 是扁平的（version / files / path / sha512 / releaseDate），
 * 本扩展运行期**零第三方依赖**（不引 YAML 库），也不该为了两个字段引一个解析器。
 * `files:` 下的列表项以 `-` 开头（`- url: …`），不会被当成顶层键，因此不会污染结果。
 */
function parseLatestYml(text) {
  const out = {}
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line.trim())
    if (!match) continue
    out[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '')
  }
  return out
}

/** 体积显示（状态栏要短，不要抖出小数点后一堆 0） */
function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const shown = unit === 0 || value >= 100 ? Math.round(value) : value.toFixed(1)
  return `${shown} ${units[unit]}`
}

/** `latest.yml` 的 `path` → 安装包 URL（可能是相对路径，也可能已经是绝对 URL） */
function installerUrlOf(feedUrl, filePath) {
  if (/^https?:\/\//i.test(filePath)) return filePath
  try {
    return new URL(filePath, feedUrl).toString()
  } catch {
    return `${feedUrl.replace(/\/+$/, '')}/${String(filePath).replace(/^\/+/, '')}`
  }
}

/**
 * 是否是「宿主 → main 的 RPC ack 超时」（宿主模式特有）。
 *
 * 为什么需要：用户扩展搬进 **Extension Host Process** 后，`api.update.download()` /
 * `api.update.install({force:true})` 变成「宿主进程 → main」的内部 RPC，而宿主 RPC 的 ack 超时
 * 固定 **3 秒**（`ACK_TIMEOUT_MS`，语义是「只观测、不杀」，见 obox 的
 * `docs/extension-api/api-reference.md`「宿主模式的降级与限制」#1 与 `src/extension-host/rpc.ts`）。
 * 这两个调用要等**整段下载**（几分钟），因此**必定**先收到 `EH_TIMEOUT` —— 而 main 的下载仍在继续，
 * 完成/失败经 `download-progress` / `update-downloaded` / `error` 事件（宿主 250ms 轮询）回到本扩展。
 * ⇒ 超时**不是失败**，不能把状态栏改成"失败"。
 *
 * 判据：宿主抛的是 `EhProtocolError`（`code === 'EH_TIMEOUT'`）；若被别的层包成普通 Error，
 * 退化为匹配该错误的固定中文文案。渲染进程模式（设置里关掉「在独立进程中运行扩展」）没有这条
 * ack 超时，走不到这里。
 */
function isAckTimeout(err) {
  if (err !== null && typeof err === 'object' && err.code === 'EH_TIMEOUT') return true
  const message = err instanceof Error ? err.message : String(err)
  return message.includes('超时时间内没有响应')
}

/** 出错时归一化提示：区别"未选中为更新提供者"与其他失败 */
function errorText(err, fallback) {
  const message = err instanceof Error ? err.message : String(err)
  return message.includes('不是生效的更新提供者') ? '未选择为更新提供者' : fallback
}

export default function oboxUpdater(api) {
  const STATUS_ID = 'obox-updater.status'

  // 状态栏：显示当前 obox 版本
  api.statusBar.setText(STATUS_ID, 'Obox')
  api.statusBar.setTooltip(STATUS_ID, 'Obox 更新提供者')
  // 必须带 catch：宿主模式下 `update.getVersion` 是跨进程 RPC，main 回包不合形状时会 reject；
  // 不 catch 就是一个 unhandled rejection（EH-D8a 用真实宿主运行时跑真扩展时实测触发）。
  void api.update
    .getVersion()
    .then((v) => {
      api.statusBar.setText(STATUS_ID, `Obox v${v}`)
    })
    .catch(() => {
      // 拿不到版本就保持「Obox」占位，不影响其它功能
    })

  /**
   * 解析更新源：优先动态解析最后一次编译的 release，失败（或旧宿主无 resolveFeed）回落 latest 兜底源。
   * 检查与强制重装共用同一套解析语义。
   */
  async function resolveFeedUrl() {
    if (typeof api.update.resolveFeed === 'function') {
      try {
        api.statusBar.setText(STATUS_ID, '解析更新源…')
        const r = await api.update.resolveFeed(REPO)
        if (r && r.ok && r.feedUrl) return { feedUrl: r.feedUrl, tag: r.tag || null }
      } catch {
        // 解析抛错（如未选中为提供者）→ 回落兜底源，由后续调用给出最终错误
      }
    }
    return { feedUrl: FALLBACK_FEED_URL, tag: null }
  }

  /**
   * 是否有"强制重装"的下载在路上（宿主模式下可能持续到本命令返回之后）。
   * 用途只有一个：`update-downloaded` 事件在两条路径上含义不同——普通更新是"重启安装"，
   * 强制重装是"安装向导已打开"。宿主模式下命令返回值会被 3 秒 ack 超时截断（见 isAckTimeout），
   * 唯一能到手的信号就是这条事件，所以必须靠这个标记区分文案。
   */
  let forceInstallInFlight = false

  // 命令：检查更新（下载完成后提示重启安装）
  const check = api.registerCommand('obox-updater.check', async () => {
    api.statusBar.setText(STATUS_ID, '检查更新…')
    // 新一轮检查：之前那次强制重装即使还没跑完，之后的 update-downloaded 也应按普通更新解释
    forceInstallInFlight = false
    try {
      const { feedUrl, tag } = await resolveFeedUrl()
      const result = await api.update.check(feedUrl)
      if (!result.ok) {
        api.statusBar.setText(STATUS_ID, `更新失败: ${result.error}`)
        return
      }
      if (!result.available) {
        api.statusBar.setText(STATUS_ID, '已是最新')
        return
      }
      api.statusBar.setText(STATUS_ID, `发现新版 ${withV(tag || result.available)}`)
      // 自动下载。宿主模式下这个 await 会在 3 秒时以 EH_TIMEOUT 结束（整段下载远长于 ack 超时，
      // 见 isAckTimeout）——但 main 的下载**仍在继续**，进度与完成经 update.onEvent 回来，
      // 所以这里保留"下载中…"而不是报失败。
      let dl
      try {
        dl = await api.update.download()
      } catch (err) {
        if (!isAckTimeout(err)) throw err
        api.statusBar.setText(STATUS_ID, '下载中…')
        return
      }
      if (!dl.ok) {
        api.statusBar.setText(STATUS_ID, `下载失败: ${dl.error}`)
        return
      }
      api.statusBar.setText(STATUS_ID, '已下载，重启安装')
    } catch (err) {
      // 慢网络下 check() 自己也可能撞上 3 秒 ack 超时（这条没有事件可等，只能请用户重试）
      api.statusBar.setText(
        STATUS_ID,
        isAckTimeout(err) ? '检查超时，请重试' : errorText(err, '更新失败')
      )
      console.error('[obox-updater] check failed', err)
    }
  })

  /**
   * 命令：强制重装（直接下载并运行安装包）。
   * 绕开 electron-updater 的版本门控，因此同版本重装与"回退到发布版"都能做；
   * 宿主的强制通道会校验安装包 sha512，校验失败不会启动安装程序。
   */
  const forceReinstall = api.registerCommand('obox-updater.forceReinstall', async () => {
    api.statusBar.setText(STATUS_ID, '准备强制重装…')
    try {
      const { feedUrl, tag } = await resolveFeedUrl()
      api.statusBar.setText(STATUS_ID, '下载安装包…')
      forceInstallInFlight = true
      // 宿主模式下这个 await 会在 3 秒时以 EH_TIMEOUT 结束（下载安装包要几分钟），
      // 但 main 仍在下载、成功后会自动打开安装向导 ⇒ 超时按"仍在下载"处理，
      // 由 download-progress / update-downloaded 事件继续更新状态栏。
      let r
      try {
        r = await api.update.install({ force: true, feedUrl })
      } catch (err) {
        if (!isAckTimeout(err)) throw err
        api.statusBar.setText(STATUS_ID, '下载安装包中…（完成后自动打开安装向导）')
        return
      }
      if (!r || !r.ok) {
        forceInstallInFlight = false
        api.statusBar.setText(STATUS_ID, `强制重装失败: ${(r && r.error) || '未知错误'}`)
        return
      }
      // 旧宿主可能忽略 force 选项（此时 r.version 为空）——一并兼容
      const version = r.version || tag
      forceInstallInFlight = false
      api.statusBar.setText(
        STATUS_ID,
        version ? `已启动安装 ${withV(version)}（按向导完成）` : '已触发安装（按向导完成）'
      )
    } catch (err) {
      // 走到这里的只有门控/参数类错误（下载超时已在上面内层 catch 里按"仍在下载"处理）
      forceInstallInFlight = false
      api.statusBar.setText(STATUS_ID, errorText(err, '强制重装失败'))
      console.error('[obox-updater] force reinstall failed', err)
    }
  })

  /**
   * 命令：下载离线安装包（走 `api.net`，自动使用设置里配置的代理）。
   *
   * 为什么单独一条命令、而不是复用 `update.install({force:true})`：那条链路把"下载 + 校验 + 启动安装"
   * 全塞进一次跨进程 RPC（宿主模式 3 秒 ack 超时，见 §5），既看不到进度也拿不到失败原因。
   * 这里用 2.2.0 新增的 `api.net.get` / `api.net.download` 自己把安装包**流式落盘**到本扩展的
   * data 目录（`installers/` 子目录）——下载上下文由宿主按扩展注入，扩展只给相对路径，
   * 因此不需要知道 data 目录的绝对路径。
   */
  const downloadInstaller = api.registerCommand('obox-updater.downloadInstaller', async () => {
    api.statusBar.setText(STATUS_ID, '准备下载安装包…')
    // 纯加法能力：老宿主没有 api.net.download，明确说清"要升到 2.2.0"，不要装作网络失败
    if (typeof api.net?.download !== 'function') {
      api.statusBar.setText(STATUS_ID, '下载离线安装包需要 obox 2.2.0 及以上')
      return
    }
    try {
      const { feedUrl, tag } = await resolveFeedUrl()
      api.statusBar.setText(STATUS_ID, '读取更新源…')
      const meta = await netGet(installerUrlOf(feedUrl, 'latest.yml'))
      if (!meta || !meta.ok) {
        api.statusBar.setText(STATUS_ID, `读取更新源失败: ${(meta && meta.error) || '未知错误'}`)
        return
      }
      const yml = parseLatestYml(meta.data)
      const fileName = String(yml.path || '').split('/').pop()
      if (!fileName) {
        api.statusBar.setText(STATUS_ID, '更新源缺少安装包文件名（latest.yml 的 path）')
        return
      }
      api.statusBar.setText(STATUS_ID, `下载安装包 ${fileName}…`)
      const result = await api.net.download(
        installerUrlOf(feedUrl, yml.path),
        `${INSTALLER_DIR}/${fileName}`,
        // 同一版本重下一次：覆盖即可（`rename` 会堆出一串 `xxx (1).exe`，用户反而找不到最新那个）
        { onExist: 'overwrite' }
      )
      if (!result || !result.ok) {
        api.statusBar.setText(STATUS_ID, `下载安装包失败: ${(result && result.error) || '未知错误'}`)
        return
      }
      const size = formatBytes(result.bytes)
      const version = tag ? withV(tag) : ''
      api.statusBar.setText(
        STATUS_ID,
        version
          ? `已下载安装包 ${version}：${result.path}（${size}）`
          : `已下载安装包 ${result.path}（${size}）`
      )
    } catch (err) {
      api.statusBar.setText(STATUS_ID, errorText(err, '下载安装包失败'))
      console.error('[obox-updater] download installer failed', err)
    }
  })

  /**
   * 读更新源里的文本文件（`latest.yml`）：优先用 2.2.0 的 `api.net.get`，
   * 老宿主没有它时退回一直存在的 `api.net.fetch`（同一条代理链路）。
   */
  async function netGet(url) {
    if (typeof api.net?.get === 'function') return api.net.get(url)
    return api.net.fetch(url, { method: 'GET' })
  }

  // 订阅更新事件（进度/完成）
  const off = api.update.onEvent((e) => {
    if (e.type === 'download-progress') {
      api.statusBar.setText(STATUS_ID, `下载 ${Math.round(e.percent)}%`)
    } else if (e.type === 'update-downloaded') {
      // 强制重装也发这条事件（main 启动安装向导后发）：此时该说的是"按向导完成"，
      // 不是"重启安装"；宿主模式下这是唯一的完成信号（命令返回值已被 3 秒超时截断）。
      if (forceInstallInFlight) {
        forceInstallInFlight = false
        api.statusBar.setText(STATUS_ID, `已启动安装 v${e.version}（按向导完成）`)
      } else {
        api.statusBar.setText(STATUS_ID, `已下载 v${e.version}，重启安装`)
      }
    } else if (e.type === 'update-available') {
      api.statusBar.setText(STATUS_ID, `发现新版 v${e.version}`)
    } else if (e.type === 'error') {
      forceInstallInFlight = false
      api.statusBar.setText(STATUS_ID, `更新错误: ${e.message}`)
    }
  })

  return () => {
    check.dispose()
    forceReinstall.dispose()
    downloadInstaller.dispose()
    off.dispose()
  }
}
