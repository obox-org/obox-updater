/**
 * 打包 .oix：把扩展分发文件（manifest + 入口 + 图标）zip 成 <name>-<version>.oix。
 * 产物输出到 out/。用法：npm run pack（本扩展无构建步骤，入口即 index.js）。
 *
 * **零依赖**：不安装任何 npm 包——zip 用系统自带命令（优先 `zip`，Windows 用系统 `tar`/bsdtar），
 * 因此本扩展项目无需 `npm install` 即可开发/测试/打包（测试用 node 内置 node --test）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
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

const outDir = join(root, 'out')
mkdirSync(outDir, { recursive: true })
const outPath = join(outDir, `${name}-${version}.oix`)
rmSync(outPath, { force: true })

/** 执行系统命令，非零退出码抛错 */
function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] })
  if (r.error) throw new Error(`无法执行 ${cmd}: ${r.error.message}`)
  if (r.status !== 0) throw new Error(`${cmd} 退出码 ${r.status}`)
}

// 优先系统 zip（Linux/macOS/Git Bash 自带）；Windows 无 zip 时用系统 tar（bsdtar）创建 zip。
// 均在扩展根目录下以相对路径打包 → zip 内为扁平结构（manifest.json / index.js / ...）。
const zipAvailable = spawnSync('zip', ['-v'], { stdio: 'ignore' }).status === 0
if (zipAvailable) {
  run('zip', ['-q', '-r', outPath, ...rootFiles])
} else {
  run('tar', ['-a', '-cf', outPath, ...rootFiles])
}
console.log(`已打包: ${outPath}（${rootFiles.join(', ')}）`)
