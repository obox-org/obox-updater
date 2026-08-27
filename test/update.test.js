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
 * overrides 可注入：version、resolveFeed(repo)、check(feedUrl)、download()（可返回/抛错）；
 * noResolveFeed: true 模拟旧宿主（api.update 无 resolveFeed）。
 */
function createMockApi(overrides = {}) {
  const state = {
    statusText: null,
    tooltip: null,
    commandId: null,
    commandHandler: null,
    eventListener: null,
    disposed: { check: false, off: false },
    checkCalls: [],
    downloadCalls: 0,
    resolveFeedCalls: []
  }
  const api = {
    statusBar: {
      setText: (id, text) => {
        assert.equal(id, STATUS_ID)
        state.statusText = text
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
      onEvent: (listener) => {
        state.eventListener = listener
        return { dispose: () => { state.disposed.off = true } }
      }
    },
    registerCommand: (id, handler) => {
      state.commandId = id
      state.commandHandler = handler
      return { dispose: () => { state.disposed.check = true } }
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
  await ctx.state.commandHandler()
  await flush()
  return ctx
}

test('激活：注册命令、订阅事件、设置状态栏初始文案，并显示当前版本', async () => {
  const { state } = activate({ version: '1.0.0' })
  await flush()
  assert.equal(state.commandId, 'obox-updater.check')
  assert.ok(typeof state.eventListener === 'function', 'onEvent 应捕获监听器')
  assert.equal(state.tooltip, 'Obox 更新提供者')
  assert.equal(state.statusText, 'Obox v1.0.0')
})

test('注册的命令 id 与 manifest 声明一致', async () => {
  const { state } = activate()
  await flush()
  assert.equal(state.commandId, manifest.contributes.commands[0].command)
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

test('检查：先解析最后一次编译的 release，再用其 feedUrl 检查更新', async () => {
  const { state } = await runCheck()
  assert.equal(state.resolveFeedCalls.length, 1)
  assert.equal(state.resolveFeedCalls[0], 'obox-org/obox')
  assert.equal(state.checkCalls.length, 1)
  assert.equal(state.checkCalls[0], 'https://github.com/obox-org/obox/releases/download/v1.1.0/')
})

test('检查：解析更新源失败 → 状态栏提示且不执行检查', async () => {
  const { state } = await runCheck({
    resolveFeed: async () => ({ ok: false, error: 'GitHub API 返回 403' })
  })
  assert.equal(state.statusText, '解析更新源失败: GitHub API 返回 403')
  assert.equal(state.checkCalls.length, 0)
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

test('清理：返回的函数同时注销命令与事件订阅', async () => {
  const { state, cleanup } = await runCheck()
  cleanup()
  assert.equal(state.disposed.check, true)
  assert.equal(state.disposed.off, true)
})
