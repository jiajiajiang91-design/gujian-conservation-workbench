// 通用 SSE 读取：与三个作业 client 内手写的解析同构，先只供助手回合使用。
// 收口后可选地把作业 client 迁移过来（计划阶段 6 可选项）。
export async function readSseStream(
  response: Response,
  onEvent: (event: unknown) => void,
): Promise<void> {
  if (!response.body) throw new Error("SSE_BODY_MISSING");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const consume = (line: string) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data) return;
    onEvent(JSON.parse(data));
  };
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) consume(line);
  }
  if (buffer.trim()) consume(buffer);
}
