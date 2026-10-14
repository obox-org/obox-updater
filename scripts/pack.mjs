/**
 * 打包 .oix：把扩展分发文件（manifest + 入口 + 图标）zip 成 <name>-<version>.oix。
 * 产物输出到 out/。用法：npm run pack（本扩展无构建步骤，入口即 index.js）。
 *
 * **零依赖**：不安装任何 npm 包，也**不调用系统 `zip`/`tar`**——直接用 Node 手写 stored（不压缩）zip。
 *
 * ⚠️ 历史坑（v1.1.0 修复）：本脚本原先在 Windows 上回落到 `tar -a -cf out/<name>.oix`。
 * bsdtar 的 `-a` 是**按文件扩展名**决定归档格式，而 `.oix` 不是已知后缀 ⇒ 它写出的是 **tar 包**，
 * 产物根本不是 zip。宿主安装时报 `invalid-package`（"不是有效的 .oix（zip）包"），
 * 而本扩展的测试完全覆盖不到打包产物，于是这个坏包**一直静静躺在 out/ 里**。
 * 现在改为自写 zip + **回读自检**（PK 签名 / EOCD / 条目数），坏包不可能再被写出来。
 */
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
const name = manifest.name
const version = manifest.version

// 入口固定文件（图标/LICENSE 缺失时自动跳过）
const rootFiles = ['manifest.json', 'index.js', 'icon.svg', 'icon.png', 'LICENSE'].filter((f) =>
  existsSync(join(root, f))
)

for (const f of ['manifest.json', 'index.js']) {
  if (!existsSync(join(root, f))) {
    throw new Error(`缺少分发文件 ${f}（扩展根目录下必须存在）`)
  }
}

// manifest.json 放最前（阅读方便；zip 顺序不影响宿主安装）
const entryNames = [...rootFiles].sort((a, b) => {
  if (a === 'manifest.json') return -1
  if (b === 'manifest.json') return 1
  return a < b ? -1 : 1
})

// ---------------------------------------------------------------------------
// stored zip（无压缩）实现——与 rdp / webapp 的 pack 脚本同一套做法
// ---------------------------------------------------------------------------

/** CRC32 表（IEEE 802.3，zip 用） */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** JS Date → DOS 日期/时间（zip 只支持 1980–2107，早于 1980 的按 1980-01-01 存） */
function dosDateTime(date) {
  const year = date.getFullYear()
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 }
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  }
}

const LOCAL_SIG = 0x04034b50
const CENTRAL_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50
/** 通用标志位 bit 11：文件名是 UTF-8（中文文件名/路径安全） */
const FLAG_UTF8 = 0x0800

/**
 * 从 zip 字节里**解析中央目录的条目名**。
 * ⚠️ 不能用 `buf.includes('test/')` 这类字节搜索代替：stored（不压缩）zip 里文件内容与
 * 条目名混在同一段字节中，内容里恰好出现的字符串会造成误判。这里按 EOCD → 中央目录逐条读。
 * @param {Buffer} buf
 * @returns {string[]}
 */
function centralNames(buf) {
  const eocdOffset = buf.length - 22
  const count = buf.readUInt16LE(eocdOffset + 10)
  let p = buf.readUInt32LE(eocdOffset + 16)
  const names = []
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CENTRAL_SIG) throw new Error('中央目录记录签名错误')
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    names.push(buf.subarray(p + 46, p + 46 + nameLen).toString('utf8'))
    p += 46 + nameLen + extraLen + commentLen
  }
  return names
}

/** @param {Array<{ name: string, data: Buffer, mtime: Date }>} files */
function buildZip(files) {
  const locals = []
  const centrals = []
  let offset = 0

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8')
    const crc = crc32(file.data)
    const { time, date } = dosDateTime(file.mtime)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL_SIG, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(FLAG_UTF8, 6)
    local.writeUInt16LE(0, 8) // method: stored
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(file.data.length, 18)
    local.writeUInt32LE(file.data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28) // extra length
    locals.push(local, nameBuf, file.data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(CENTRAL_SIG, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(FLAG_UTF8, 8)
    central.writeUInt16LE(0, 10) // method: stored
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(file.data.length, 20)
    central.writeUInt32LE(file.data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk number start
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0, 38) // external attrs
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuf)

    offset += local.length + nameBuf.length + file.data.length
  }

  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIG, 0)
  eocd.writeUInt16LE(0, 4) // this disk
  eocd.writeUInt16LE(0, 6) // disk with central dir
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20) // comment length

  return Buffer.concat([...locals, centralBuf, eocd])
}

const files = entryNames.map((entryName) => {
  const abs = join(root, entryName)
  return { name: entryName, data: readFileSync(abs), mtime: statSync(abs).mtime }
})

const outDir = join(root, 'out')
mkdirSync(outDir, { recursive: true })
const outPath = join(outDir, `${name}-${version}.oix`)
rmSync(outPath, { force: true })
const zip = buildZip(files)
writeFileSync(outPath, zip)

// 回读自检：**必须是 zip**（PK\x03\x04 开头 + 结尾 EOCD + 条目数与名称逐一一致）。
// 这条就是上面那个坑的闸门：`tar -a` 会写出 tar 包，头 4 字节是条目名而不是 PK\x03\x04。
if (zip.length < 22 || zip.readUInt32LE(0) !== LOCAL_SIG) {
  throw new Error('自检失败：产物不是 zip（缺少 PK\\x03\\x04 本地文件头）')
}
const eocd = zip.subarray(zip.length - 22)
if (eocd.readUInt32LE(0) !== EOCD_SIG) throw new Error('自检失败：EOCD 缺失')
if (eocd.readUInt16LE(10) !== files.length) throw new Error('自检失败：条目数不一致')
for (const entryName of entryNames) {
  if (entryName.startsWith('out/') || entryName.startsWith('test/')) {
    throw new Error(`自检失败：产物含非分发条目 ${entryName}`)
  }
}
const names = centralNames(zip)
const missing = entryNames.filter((n) => !names.includes(n))
if (missing.length) throw new Error(`自检失败：中央目录缺少条目 ${missing.join('、')}`)
const extra = names.filter((n) => !entryNames.includes(n))
if (extra.length) throw new Error(`自检失败：中央目录含多余条目 ${extra.join('、')}`)

console.log(`已打包: ${outPath}（${zip.length} 字节，${files.length} 个条目）`)
console.log(`条目: ${entryNames.join(', ')}`)
