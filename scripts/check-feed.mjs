/**
 * 真实更新源冒烟检查：请求 obox-release 的 latest.yml，验证可达性与格式。
 * 需要 GitHub 上已发布 v1.0.0 release（setup.exe + latest.yml）。
 * 用法：npm run check:feed
 */
const FEED_URL = 'https://github.com/obox-org/obox/releases/latest/download/latest.yml'

const res = await fetch(FEED_URL, { redirect: 'follow' })
if (!res.ok) {
  console.error(`更新源不可达: HTTP ${res.status} ${FEED_URL}`)
  process.exit(1)
}
const yml = await res.text()
console.log('--- latest.yml ---')
console.log(yml)

const versionOk = /version:\s*\S+/.test(yml)
const assetOk = /url:\s*obox-[\d.]+-setup\.exe/.test(yml)
if (!versionOk || !assetOk) {
  console.error('latest.yml 格式异常（缺 version 或 obox-<version>-setup.exe 条目）')
  process.exit(1)
}
console.log('更新源 OK')
