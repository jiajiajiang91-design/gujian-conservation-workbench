import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { App, LENGTH_INPUT_STEP } from "./App";

afterEach(cleanup);

describe("App", () => {
  it("建立项目后显示当前建筑和版本", async () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: /古建保护/ })).toBeInTheDocument();
    expect(screen.getByText("密钥不进入浏览器")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "新建项目" }));
    fireEvent.change(screen.getByLabelText("项目名称"), { target: { value: "山门保护记录" } });
    fireEvent.change(screen.getByLabelText("建筑名称"), { target: { value: "山门" } });
    fireEvent.click(screen.getByRole("button", { name: "创建并进入项目" }));

    expect(await screen.findByRole("heading", { name: "山门" })).toBeInTheDocument();
    expect(screen.getByText(/^版本 /)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /问题处理/ }));
    expect(await screen.findByText("问题队列与必要人工节点")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认一次任务设置" }));
    expect(await screen.findByText("人工节点 01 已完成")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /成果交付/ }));
    expect(screen.getByRole("button", { name: "验证 JSON 与 ZIP 空库回导" })).toBeInTheDocument();
  });

  it("长度输入接受图纸换算后的毫米小数", async () => {
    expect(LENGTH_INPUT_STEP).toBe("any");
  });
});
