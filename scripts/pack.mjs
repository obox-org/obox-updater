/**
 * 打包 .oix：把扩展分发文件（manifest + 入口 + 图标）zip 成 <name>-<version>.oix。
 * 产物输出到 out/。用法：npm run pack（本扩展无构建步骤，入口即 index.js）。
 */
import AdmZip from 'adm-zip'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
const name = manifest.name
const version = manifest.version

// 入口固定文件（图标缺失时自动跳过）
const rootFiles = ['manifest.json', 'index.js', 'icon.svg', 'icon.png'].filter((f) =>
  existsSync(join(root, f))
)

for (const f of ['manifest.json', 'index.js']) {
  if (!existsSync(join(root, f))) {
    throw new Error(`缺少分发文件 ${f}（扩展根目录下必须存在）`)
  }
}

const zip = new AdmZip()
for (const f of rootFiles) zip.addLocalFile(join(root, f))

const outDir = join(root, 'out')
mkdirSync(outDir, { recursive: true })
const outPath = join(outDir, `${name}-${version}.oix`)
zip.writeZip(outPath)
console.log(`已打包: ${outPath}（${rootFiles.join(', ')}）`)
