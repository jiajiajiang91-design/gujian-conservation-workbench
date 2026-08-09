import { render, screen } from '@testing-library/react'
import { App } from './App'

describe('App', () => {
  it('清楚标注代理验证环境和旧版保留状态', () => {
    render(<App />)

    expect(screen.getByRole('heading', { name: '古建保护成果工作台' })).toBeVisible()
    expect(screen.getByText('代理验证环境')).toBeVisible()
    expect(screen.getByText('旧版入口').nextElementSibling).toHaveTextContent('保留')
  })
})
