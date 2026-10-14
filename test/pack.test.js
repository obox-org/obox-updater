/**
 * 打包产物门禁：`out/obox-updater-<version>.oix` **必须是合法的 zip**，且条目恰好是分发文件。
 *
 * 为什么单独立一条测试：这个扩展原有的 26 个单测全绿，但**打包脚本**曾用
 * `tar -a -cf out/<name>.oix`（bsdtar 按扩展名定格式 ⇒ `.oix` 不是已知后缀 ⇒ 写出 tar 包），
 * 于是 out/ 里长期躺着一个宿主拒绝安装的坏包（`invalid-package`），而没有任何测试发现它。
 * 本用例直接跑 `npm run pack` 的脚本再回读产物，坏包不可能再悄悄产出。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
const oix = join(root, 'out', `${manifest.name}-${manifest.version}.oix`)

const LOCAL_SIG = 0x04034b50
const CENTRAL_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50

/**
 * 解析中央目录条目名。
 * ⚠️ 不能用 `buf.includes('test/')` 之类字节搜索：stored（不压缩）zip 里文件内容与条目名
 * 混在同一段字节中，内容里恰好出现的字符串会被误判成条目（本用例第一版就踩了）。
 */
function centralNames(buf) {
  const eocdOffset = buf.length - 22
  const count = buf.readUInt16LE(eocdOffset + 10)
  let p = buf.readUInt32LE(eocdOffset + 16)
  const names = []
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), CENTRAL_SIG, '中央目录记录签名错误')
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    names.push(buf.subarray(p + 46, p + 46 + nameLen).toString('utf8'))
    p += 46 + nameLen + extraLen + commentLen
  }
  return names
}

/** 期望的分发文件（与 pack 脚本同一份规则：manifest + 入口必需，图标/LICENSE 有则带） */
const expected = ['manifest.json', 'index.js', 'icon.svg', 'icon.png', 'LICENSE'].filter((f) =>
  existsSync(join(root, f))
)

test('pack：脚本成功产出 .oix', () => {
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'pack.mjs')], {
    cwd: root,
    encoding: 'utf8'
  })
  assert.equal(r.status, 0, `pack 退出码 ${r.status}：${r.stderr}`)
  assert.ok(existsSync(oix), `未产出 ${oix}`)
})

test('pack：产物是 zip（PK\\x03\\x04 开头 + 结尾 EOCD），不是 tar', () => {
  const buf = readFileSync(oix)
  // 这条正是那个坑的判据：tar 包的头 4 字节是条目名（如 "mani"），只有 zip 才是 PK\x03\x04
  assert.equal(
    buf.readUInt32LE(0),
    LOCAL_SIG,
    `产物不是 zip：头 4 字节 = ${buf.subarray(0, 4).toString('hex')}（应为 504b0304）`
  )
  assert.equal(buf.readUInt32LE(buf.length - 22), EOCD_SIG, '缺少 zip 结尾的 EOCD 记录')
})

test('pack：中央目录条目名与分布文件集合逐一一致（manifest.json 在最前）', () => {
  const buf = readFileSync(oix)
  const names = centralNames(buf)
  assert.deepEqual([...names].sort(), [...expected].sort(), '包内条目与预期分发文件不一致')
  // 本地文件头紧跟的第一个文件名必须是 manifest.json（人工查看方便，与 pack 脚本承诺一致）
  const firstNameLen = buf.readUInt16LE(26)
  const firstName = buf.subarray(30, 30 + firstNameLen).toString('utf8')
  assert.equal(firstName, 'manifest.json', `首个条目应为 manifest.json，实际 ${firstName}`)
})

test('pack：产物不得含 test/ 或 scripts/ 等非分发目录', () => {
  const names = centralNames(readFileSync(oix))
  for (const name of names) {
    assert.ok(!name.startsWith('test/'), `产物含 test/ 条目：${name}`)
    assert.ok(!name.startsWith('scripts/'), `产物含 scripts/ 条目：${name}`)
    assert.ok(!name.startsWith('out/'), `产物含 out/ 条目：${name}`)
    assert.ok(!name.startsWith('node_modules/'), `产物含 node_modules/ 条目：${name}`)
  }
})
