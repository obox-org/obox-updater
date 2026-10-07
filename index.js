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

/** 归一化版本号显示：统一带 v 前缀（tag 通常已是 v1.2.3，available 可能不带） */
function withV(version) {
  return typeof version === 'string' && version.startsWith('v') ? version : `v${version}`
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
  void api.update.getVersion().then((v) => {
    api.statusBar.setText(STATUS_ID, `Obox v${v}`)
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

  // 命令：检查更新（下载完成后提示重启安装）
  const check = api.registerCommand('obox-updater.check', async () => {
    api.statusBar.setText(STATUS_ID, '检查更新…')
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
      // 自动下载
      const dl = await api.update.download()
      if (!dl.ok) {
        api.statusBar.setText(STATUS_ID, `下载失败: ${dl.error}`)
        return
      }
      api.statusBar.setText(STATUS_ID, '已下载，重启安装')
    } catch (err) {
      api.statusBar.setText(STATUS_ID, errorText(err, '更新失败'))
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
      const r = await api.update.install({ force: true, feedUrl })
      if (!r || !r.ok) {
        api.statusBar.setText(STATUS_ID, `强制重装失败: ${(r && r.error) || '未知错误'}`)
        return
      }
      // 旧宿主可能忽略 force 选项（此时 r.version 为空）——一并兼容
      const version = r.version || tag
      api.statusBar.setText(
        STATUS_ID,
        version ? `已启动安装 ${withV(version)}（按向导完成）` : '已触发安装（按向导完成）'
      )
    } catch (err) {
      api.statusBar.setText(STATUS_ID, errorText(err, '强制重装失败'))
      console.error('[obox-updater] force reinstall failed', err)
    }
  })

  // 订阅更新事件（进度/完成）
  const off = api.update.onEvent((e) => {
    if (e.type === 'download-progress') {
      api.statusBar.setText(STATUS_ID, `下载 ${Math.round(e.percent)}%`)
    } else if (e.type === 'update-downloaded') {
      api.statusBar.setText(STATUS_ID, `已下载 v${e.version}，重启安装`)
    } else if (e.type === 'update-available') {
      api.statusBar.setText(STATUS_ID, `发现新版 v${e.version}`)
    } else if (e.type === 'error') {
      api.statusBar.setText(STATUS_ID, `更新错误: ${e.message}`)
    }
  })

  return () => {
    check.dispose()
    forceReinstall.dispose()
    off.dispose()
  }
}
