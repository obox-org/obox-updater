/**
 * Obox 更新提供者扩展（非内置）。
 * 从 GitHub Release（obox-org/obox-release）拉取 obox 更新：
 * - 经 manifest contributes.updater.feedUrl 提供更新源
 * - 在"设置-更新"选中本扩展后生效（只能一个更新提供者）
 * - 提供命令"检查 Obox 更新"与状态栏项，调用 api.update 检查/下载/安装
 *
 * 注意：用户扩展入口为纯 ESM JavaScript（宿主动态 import，无构建转换）。
 */

// GitHub Release 的 latest.yml 与安装包（与 manifest feedUrl 对应）
const FEED_URL = 'https://github.com/obox-org/obox-release/releases/latest/download/'

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
      const result = await api.update.check(FEED_URL)
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
