/**
 * Obox 更新提供者扩展（非内置）。
 * 从 GitHub Release（obox-org/obox）拉取 obox 更新：
 * - 先经 api.update.resolveFeed 解析"最后一次编译"的 release（按创建时间最新，不依赖 latest 标记）
 * - 再用解析出的更新源调 api.update.check 检查/下载/安装
 * - 在"设置-更新"选中本扩展后生效（只能一个更新提供者）
 * - 提供命令"检查 Obox 更新"与状态栏项
 *
 * 注意：用户扩展入口为纯 ESM JavaScript（宿主动态 import，无构建转换）。
 */

// obox 发布仓库（release 资产：x64/arm64 安装包 + latest.yml / latest-arm64.yml）
const REPO = 'obox-org/obox'
// 兜底更新源：仅当宿主无 api.update.resolveFeed（旧版本 obox）时使用（依赖 latest 标记）
const FALLBACK_FEED_URL = 'https://github.com/obox-org/obox/releases/latest/download/'

export default function oboxUpdater(api) {
  // 状态栏：显示当前 obox 版本
  api.statusBar.setText('obox-updater.status', 'Obox')
  api.statusBar.setTooltip('obox-updater.status', 'Obox 更新提供者')
  void api.update.getVersion().then((v) => {
    api.statusBar.setText('obox-updater.status', `Obox v${v}`)
  })

  // 命令：检查更新（下载完成后提示重启安装）
  const check = api.registerCommand('obox-updater.check', async () => {
    api.statusBar.setText('obox-updater.status', '检查更新…')
    try {
      // 1) 解析最后一次编译的 release 更新源（旧宿主无 resolveFeed 时回退 latest/download）
      let feedUrl = FALLBACK_FEED_URL
      if (typeof api.update.resolveFeed === 'function') {
        const resolved = await api.update.resolveFeed(REPO)
        if (!resolved.ok) {
          api.statusBar.setText('obox-updater.status', `解析更新源失败: ${resolved.error}`)
          return
        }
        feedUrl = resolved.feedUrl
      }
      // 2) 检查更新
      const result = await api.update.check(feedUrl)
      if (!result.ok) {
        api.statusBar.setText('obox-updater.status', `更新失败: ${result.error}`)
        return
      }
      if (!result.available) {
        api.statusBar.setText('obox-updater.status', '已是最新')
        return
      }
      api.statusBar.setText('obox-updater.status', `发现新版 ${result.available}`)
      // 自动下载
      const dl = await api.update.download()
      if (!dl.ok) {
        api.statusBar.setText('obox-updater.status', `下载失败: ${dl.error}`)
        return
      }
      api.statusBar.setText('obox-updater.status', '已下载，重启安装')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      api.statusBar.setText(
        'obox-updater.status',
        message.includes('不是生效的更新提供者') ? '未选择为更新提供者' : '更新失败'
      )
      console.error('[obox-updater] check failed', err)
    }
  })

  // 订阅更新事件（进度/完成）
  const off = api.update.onEvent((e) => {
    if (e.type === 'download-progress') {
      api.statusBar.setText('obox-updater.status', `下载 ${Math.round(e.percent)}%`)
    } else if (e.type === 'update-downloaded') {
      api.statusBar.setText('obox-updater.status', `已下载 v${e.version}，重启安装`)
    } else if (e.type === 'update-available') {
      api.statusBar.setText('obox-updater.status', `发现新版 v${e.version}`)
    } else if (e.type === 'error') {
      api.statusBar.setText('obox-updater.status', `更新错误: ${e.message}`)
    }
  })

  return () => {
    check.dispose()
    off.dispose()
  }
}
