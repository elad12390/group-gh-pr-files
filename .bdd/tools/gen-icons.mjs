// Render icons/icon.svg to PNGs at the sizes Chrome needs (Chrome rejects SVG
// manifest icons; Firefox accepts PNG too, so one PNG set works for both).
// Run with: bun run icons
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../../')
const svg = fs.readFileSync(path.join(ROOT, 'icons/icon.svg'), 'utf8')
const sizes = [16, 32, 48, 96, 128]

const browser = await chromium.launch()
for (const size of sizes) {
  const sized = svg.replace('width="96" height="96"', `width="${size}" height="${size}"`)
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 2 })
  await page.setContent(`<!doctype html><html><body style="margin:0;padding:0">${sized}</body></html>`)
  await page.locator('svg').screenshot({ path: path.join(ROOT, `icons/icon-${size}.png`), omitBackground: true, scale: 'css' })
  await page.close()
  console.log(`icons/icon-${size}.png`)
}
await browser.close()
console.log('done')
