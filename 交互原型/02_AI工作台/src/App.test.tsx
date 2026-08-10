import { render, screen } from '@testing-library/react'
import { App } from './App'

describe('App', () => {
  it('以正式项目目录作为新工作台入口', async () => {
    render(<App />)

    expect(await screen.findByRole('heading', { name: '保护成果项目' })).toBeVisible()
    expect(screen.getByRole('button', { name: /导入项目/ })).toBeVisible()
    expect(screen.getAllByRole('button', { name: /新建项目/ })[0]).toBeVisible()
    expect(screen.getByText('代理验证环境')).toBeVisible()
  })
})
