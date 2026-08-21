import { expect, test, type Page } from '@playwright/test'

async function loadExamples(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: '加载两套演示项目' }).click()
  await expect(page.getByRole('button', { name: /高都古建保护归档示例/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /东呈五开间资料不足示例/ })).toBeVisible()
}

test('高都完成代理成果与交付包', async ({ page }) => {
  await loadExamples(page)
  await page.getByRole('button', { name: /高都古建保护归档示例/ }).click()
  await page.getByRole('button', { name: /^成果与检查/ }).click()
  await page.getByRole('button', { name: '生成代理成果', exact: true }).click()

  await expect(page.getByRole('button', { name: /^代理立面 SVG / })).toBeVisible()
  await expect(page.getByRole('button', { name: /^代理立面 DXF / })).toBeVisible()
  await expect(page.getByRole('button', { name: /^检查报告 / })).toBeVisible()

  await page.getByRole('button', { name: '交付与归档' }).click()
  await expect(page.getByRole('button', { name: '生成并下载' })).toBeDisabled()
  await page.getByRole('button', { name: '确认代理范围' }).click()
  await expect(page.getByText('可以生成', { exact: true })).toBeVisible()

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '生成并下载' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/proxy-delivery\.gujian\.zip$/)
  await expect(page.getByRole('heading', { name: '交付记录' })).toBeVisible()
  await expect(page.getByText('正式签发未启用', { exact: true })).toBeVisible()
})

test('东呈只生成证据草图并保持交付阻断', async ({ page }) => {
  await loadExamples(page)
  await page.getByRole('button', { name: /东呈五开间资料不足示例/ }).click()
  await page.getByRole('button', { name: /^成果与检查/ }).click()
  await page.getByRole('button', { name: '生成代理成果', exact: true }).click()

  await expect(page.getByRole('button', { name: /^证据草图 SVG / })).toBeVisible()
  await expect(page.getByText('已生成五开间证据草图和资料不足报告；尺寸立面仍保持阻断。')).toBeVisible()

  await page.getByRole('button', { name: '交付与归档' }).click()
  await expect(page.getByText('当前阻断', { exact: true })).toBeVisible()
  await expect(page.getByText(/缺少立面 SVG、DXF 或检查报告/)).toBeVisible()
  await expect(page.getByRole('button', { name: '生成并下载' })).toBeDisabled()
})

test('1280 与 1440 桌面宽度无横向溢出', async ({ page }) => {
  for (const width of [1280, 1440]) {
    await page.setViewportSize({ width, height: 850 })
    await page.goto('/')
    const sizes = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }))
    expect(sizes.scrollWidth).toBe(sizes.clientWidth)
  }
})
