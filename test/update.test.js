/**
 * obox-updater 更新功能单元测试（node:test + mock api，零依赖）。
 * 运行：npm test（node --test test/）
 *
 * 原理：扩展入口只与注入的 api 对象交互（不依赖 Electron/网络），
 * 用 mock api 捕获状态栏文本、命令处理器与更新事件监听器，验证各分支行为。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import oboxUpdater from '../index.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
const STATUS_ID = 'obox-updater.status'

/** 等一个宏任务，确保所有 pending 微任务（含 getVersion 的 then）已执行 */
const flush = () => new Promise((resolve) => setImmediate(resolve))

/**
 * 构造 mock api。
 * overrides 可注入：version、resolveFeed(repo)、check(feedUrl)、download()、install(opts)（可返回/抛错）；
 * noResolveFeed: true 模拟旧宿主（api.update 无 resolveFeed）。
 */
function createMockApi(overrides = {}) {
  const state = {
    statusText: null,
    statusHistory: [],
    tooltip: null,
    /** 命令 id → handler（扩展注册的全部命令） */
    commands: new Map(),
    eventListener: null,
    disposed: { off: false },
    checkCalls: [],
    downloadCalls: 0,
    resolveFeedCalls: [],
    installCalls: []
  }
  const api = {
    statusBar: {
      setText: (id, text) => {
        assert.equal(id, STATUS_ID)
        state.statusText = text
        state.statusHistory.push(text)
      },
      setTooltip: (id, tooltip) => {
        assert.equal(id, STATUS_ID)
        state.tooltip = tooltip
      }
    },
    update: {
      getVersion: async () => overrides.version ?? '1.0.0',
      ...(overrides.noResolveFeed
        ? {}
        : {
            resolveFeed: async (repo) => {
              state.resolveFeedCalls.push(repo)
              return overrides.resolveFeed
                ? await overrides.resolveFeed(repo)
                : {
                    ok: true,
                    tag: 'v1.1.0',
                    feedUrl: 'https://github.com/obox-org/obox/releases/download/v1.1.0/'
                  }
            }
          }),
      check: async (feedUrl) => {
        state.checkCalls.push(feedUrl)
        return overrides.check ? await overrides.check(feedUrl) : { ok: true, available: false }
      },
      download: async () => {
        state.downloadCalls++
        return overrides.download ? await overrides.download() : { ok: true }
      },
      install: async (opts) => {
        state.installCalls.push(opts)
        return overrides.install
          ? await overrides.install(opts)
          : { ok: true, version: '1.0.1', filePath: 'C:\\tmp\\obox-setup.exe' }
      },
      onEvent: (listener) => {
        state.eventListener = listener
        return { dispose: () => { state.disposed.off = true } }
      }
    },
    registerCommand: (id, handler) => {
      state.commands.set(id, handler)
      return {
        dispose: () => {
          state.disposed[id] = true
          state.commands.delete(id)
        }
      }
    }
  }
  return { api, state }
}

/** 激活扩展，返回 { api, state, cleanup } */
function activate(overrides) {
  const { api, state } = createMockApi(overrides)
  const cleanup = oboxUpdater(api)
  return { api, state, cleanup }
}

/** 激活并执行检查命令（等待完成与微任务刷完），返回 ctx */
async function runCheck(overrides) {
  const ctx = activate(overrides)
  await ctx.state.commands.get('obox-updater.check')()
  await flush()
  return ctx
}

/** 激活并执行强制重装命令，返回 ctx */
async function runForce(overrides) {
  const ctx = activate(overrides)
  await ctx.state.commands.get('obox-updater.forceReinstall')()
  await flush()
  return ctx
}

test('激活：注册全部 manifest 声明的命令、订阅事件、设置状态栏初始文案，并显示当前版本', async () => {
  const { state } = activate({ version: '1.0.0' })
  await flush()
  assert.ok(state.commands.has('obox-updater.check'), '应注册检查命令')
  assert.ok(state.commands.has('obox-updater.forceReinstall'), '应注册强制重装命令')
  assert.ok(typeof state.eventListener === 'function', 'onEvent 应捕获监听器')
  assert.equal(state.tooltip, 'Obox 更新提供者')
  assert.equal(state.statusText, 'Obox v1.0.0')
})

test('注册的命令集合与 manifest 声明完全一致', async () => {
  const { state } = activate()
  await flush()
  const declared = manifest.contributes.commands.map((c) => c.command).sort()
  assert.deepEqual([...state.commands.keys()].sort(), declared)
})

test('检查：检查失败（ok:false）→ 状态栏显示错误信息', async () => {
  const { state } = await runCheck({
    check: async () => ({ ok: false, error: 'latest.yml 404' })
  })
  assert.equal(state.statusText, '更新失败: latest.yml 404')
  assert.equal(state.downloadCalls, 0, '失败时不应触发下载')
})

test('检查：无可用更新 → 显示已是最新', async () => {
  const { state } = await runCheck({
    check: async () => ({ ok: true, available: false })
  })
  assert.equal(state.statusText, '已是最新')
  assert.equal(state.downloadCalls, 0)
})

test('检查：发现新版且下载成功 → 提示重启安装', async () => {
  const { state } = await runCheck({
    check: async () => ({ ok: true, available: '1.1.0' }),
    download: async () => ({ ok: true })
  })
  assert.equal(state.downloadCalls, 1)
  assert.equal(state.statusText, '已下载，重启安装')
})

test('检查：下载失败 → 显示下载失败', async () => {
  const { state } = await runCheck({
    check: async () => ({ ok: true, available: '1.1.0' }),
    download: async () => ({ ok: false, error: '网络中断' })
  })
  assert.equal(state.statusText, '下载失败: 网络中断')
})

test('检查：未选中为更新提供者（api 抛错）→ 提示去设置-更新选择', async () => {
  const { state } = await runCheck({
    check: async () => {
      throw new Error('当前扩展不是生效的更新提供者（需在设置-更新中选择）')
    }
  })
  assert.equal(state.statusText, '未选择为更新提供者')
})

test('检查：其他异常 → 显示更新失败', async () => {
  const { state } = await runCheck({
    check: async () => {
      throw new Error('boom')
    }
  })
  assert.equal(state.statusText, '更新失败')
})

test('事件：download-progress → 显示下载百分比（四舍五入）', () => {
  const { state } = activate()
  state.eventListener({ type: 'download-progress', percent: 45.6, bytesPerSecond: 0, transferred: 0, total: 0 })
  assert.equal(state.statusText, '下载 46%')
  state.eventListener({ type: 'download-progress', percent: 99.4, bytesPerSecond: 0, transferred: 0, total: 0 })
  assert.equal(state.statusText, '下载 99%')
})

test('事件：update-downloaded → 提示重启安装', () => {
  const { state } = activate()
  state.eventListener({ type: 'update-downloaded', version: '1.1.0' })
  assert.equal(state.statusText, '已下载 v1.1.0，重启安装')
})

test('事件：update-available → 显示发现新版', () => {
  const { state } = activate()
  state.eventListener({ type: 'update-available', version: '1.1.0' })
  assert.equal(state.statusText, '发现新版 v1.1.0')
})

test('事件：error → 显示更新错误', () => {
  const { state } = activate()
  state.eventListener({ type: 'error', message: '签名校验失败' })
  assert.equal(state.statusText, '更新错误: 签名校验失败')
})

test('检查：resolveFeed 以 obox-org/obox 解析，成功时用其返回的 feedUrl', async () => {
  const feedUrl = 'https://github.com/obox-org/obox/releases/download/v1.1.0/'
  const { state } = await runCheck({
    resolveFeed: async (repo) => ({ ok: true, tag: 'v1.1.0', feedUrl }),
    check: async () => ({ ok: true, available: false })
  })
  assert.deepEqual(state.resolveFeedCalls, ['obox-org/obox'])
  assert.equal(state.checkCalls.length, 1)
  assert.equal(state.checkCalls[0], feedUrl)
})

test('检查：resolveFeed 返回 ok:false 时回落 latest 兜底源', async () => {
  const { state } = await runCheck({
    resolveFeed: async () => ({ ok: false, error: '仓库无 release' }),
    check: async () => ({ ok: true, available: false })
  })
  assert.deepEqual(state.resolveFeedCalls, ['obox-org/obox'])
  assert.equal(state.checkCalls.length, 1)
  assert.equal(state.checkCalls[0], 'https://github.com/obox-org/obox/releases/latest/download/')
  assert.equal(state.statusText, '已是最新')
})

test('检查：解析成功但已是最新 → 显示已是最新且不下载', async () => {
  const feedUrl = 'https://github.com/obox-org/obox/releases/download/v1.0.0/'
  const { state } = await runCheck({
    resolveFeed: async () => ({ ok: true, tag: 'v1.0.0', feedUrl }),
    check: async () => ({ ok: true, available: false })
  })
  assert.equal(state.checkCalls[0], feedUrl)
  assert.equal(state.statusText, '已是最新')
  assert.equal(state.downloadCalls, 0)
})

test('检查：发现新版时状态栏体现解析得到的 tag（发现新版 v1.1.0）', async () => {
  const { state } = await runCheck({
    resolveFeed: async () => ({
      ok: true,
      tag: 'v1.1.0',
      feedUrl: 'https://github.com/obox-org/obox/releases/download/v1.1.0/'
    }),
    check: async () => ({ ok: true, available: '1.1.0' }),
    download: async () => ({ ok: true })
  })
  assert.ok(state.statusHistory.includes('发现新版 v1.1.0'), '状态栏应出现发现新版 v1.1.0')
  assert.equal(state.statusText, '已下载，重启安装')
})

test('检查：旧宿主无 resolveFeed → 回退 manifest 的 latest/download 更新源', async () => {
  const { state } = await runCheck({ noResolveFeed: true })
  assert.equal(state.resolveFeedCalls.length, 0)
  assert.equal(state.checkCalls.length, 1)
  assert.equal(state.checkCalls[0], 'https://github.com/obox-org/obox/releases/latest/download/')
  assert.equal(
    manifest.contributes.updater.feedUrl,
    'https://github.com/obox-org/obox/releases/latest/download/'
  )
})

test('清理：返回的函数同时注销全部命令与事件订阅', async () => {
  const { state, cleanup } = await runCheck()
  cleanup()
  assert.equal(state.disposed['obox-updater.check'], true)
  assert.equal(state.disposed['obox-updater.forceReinstall'], true)
  assert.equal(state.disposed.off, true)
  assert.equal(state.commands.size, 0)
})

// ---- 强制重装 / 回退到发布版 ----

test('强制重装：以 force:true 与解析得到的 feedUrl 调用 install，并提示已启动安装', async () => {
  const feedUrl = 'https://github.com/obox-org/obox/releases/download/v1.1.0/'
  const { state } = await runForce({
    resolveFeed: async () => ({ ok: true, tag: 'v1.1.0', feedUrl }),
    install: async () => ({ ok: true, version: '1.1.0', filePath: 'C:\\tmp\\obox-setup.exe' })
  })
  assert.deepEqual(state.resolveFeedCalls, ['obox-org/obox'])
  assert.equal(state.installCalls.length, 1)
  assert.equal(state.installCalls[0].force, true, '必须走强制通道（绕开版本门控）')
  assert.equal(state.installCalls[0].feedUrl, feedUrl)
  assert.equal(state.statusText, '已启动安装 v1.1.0（按向导完成）')
})

test('强制重装：resolveFeed 不可用（旧宿主）→ 用 latest 兜底源', async () => {
  const { state } = await runForce({ noResolveFeed: true })
  assert.equal(state.resolveFeedCalls.length, 0)
  assert.equal(state.installCalls.length, 1)
  assert.equal(state.installCalls[0].feedUrl, 'https://github.com/obox-org/obox/releases/latest/download/')
})

test('强制重装：resolveFeed 返回 ok:false → 仍回落兜底源并继续', async () => {
  const { state } = await runForce({
    resolveFeed: async () => ({ ok: false, error: '仓库无 release' })
  })
  assert.equal(
    state.installCalls[0].feedUrl,
    'https://github.com/obox-org/obox/releases/latest/download/'
  )
})

test('强制重装：install 返回 ok:false → 状态栏显示失败原因，且不谎报成功', async () => {
  const { state } = await runForce({
    install: async () => ({ ok: false, error: '安装包校验失败（sha512 不匹配），已删除下载文件' })
  })
  assert.equal(state.statusText, '强制重装失败: 安装包校验失败（sha512 不匹配），已删除下载文件')
})

test('强制重装：未选中为更新提供者（api 抛错）→ 提示去设置-更新选择', async () => {
  const { state } = await runForce({
    install: async () => {
      throw new Error('当前扩展不是生效的更新提供者（需在设置-更新中选择）')
    }
  })
  assert.equal(state.statusText, '未选择为更新提供者')
})

test('强制重装：其他异常 → 显示强制重装失败', async () => {
  const { state } = await runForce({
    install: async () => {
      throw new Error('boom')
    }
  })
  assert.equal(state.statusText, '强制重装失败')
})

test('强制重装：旧宿主忽略 force（install 无 version）→ 提示已触发安装（不显示空版本号）', async () => {
  const { state } = await runForce({
    resolveFeed: async () => ({ ok: true, tag: null, feedUrl: 'https://x/' }),
    install: async () => ({ ok: true })
  })
  assert.equal(state.statusText, '已触发安装（按向导完成）')
})

test('强制重装：状态栏过程可见（准备强制重装 → 下载安装包）', async () => {
  const { state } = await runForce()
  assert.ok(state.statusHistory.includes('准备强制重装…'), '应显示准备状态')
  assert.ok(state.statusHistory.includes('下载安装包…'), '应显示下载状态')
})
