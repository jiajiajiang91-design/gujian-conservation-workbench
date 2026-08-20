export interface ModelUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
}

export interface GatewayResult {
  content: string;
  usage: ModelUsage;
  attempt: number;
}

export class RunCancelledError extends Error {
  constructor() { super("MODEL_RUN_CANCELLED"); }
}

export class KimiGateway {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #model: string;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;
  readonly #maxOutputTokens: number;
  readonly #fetch: typeof fetch;

  constructor(input: {
    apiKey?: string; baseUrl?: string; model?: string; timeoutMs?: number;
    maxAttempts?: number; maxOutputTokens?: number; fetchImpl?: typeof fetch;
  } = {}) {
    this.#apiKey = input.apiKey ?? process.env.KIMI_API_KEY ?? "";
    this.#baseUrl = (input.baseUrl ?? process.env.KIMI_BASE_URL ?? "https://api.moonshot.ai/v1").replace(/\/$/, "");
    this.#model = input.model ?? process.env.KIMI_MODEL ?? "kimi-k2.6";
    this.#timeoutMs = input.timeoutMs ?? Number(process.env.KIMI_TIMEOUT_MS ?? 45_000);
    this.#maxAttempts = input.maxAttempts ?? Number(process.env.KIMI_MAX_ATTEMPTS ?? 2);
    this.#maxOutputTokens = input.maxOutputTokens ?? Number(process.env.KIMI_MAX_OUTPUT_TOKENS ?? 1_024);
    this.#fetch = input.fetchImpl ?? fetch;
  }

  get configured(): boolean { return this.#apiKey.length > 0; }
  get model(): string { return this.#model; }

  async execute(input: {
    userContent: string;
    // 系统提示来自任务注册表（technical 架构 7.2）。留空时用资料整理任务的提示，
    // 保持既有调用方行为不变。
    systemPrompt?: string;
    // 输出上限按任务定，缺省时用网关的全局值
    maxOutputTokens?: number;
    // 图像输入。本机文件按 data URI 传，浏览器不提交模型标识、提示或密钥。
    images?: readonly { readonly mediaType: string; readonly base64: string }[];
    signal: AbortSignal;
    onStatus: (type: "running" | "retrying", attempt: number, detail: string | null) => void;
    onChunk: (content: string, attempt: number) => void;
  }): Promise<GatewayResult> {
    if (!this.configured) throw new Error("KIMI_API_KEY_NOT_CONFIGURED");
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      if (input.signal.aborted) throw new RunCancelledError();
      input.onStatus(attempt === 1 ? "running" : "retrying", attempt, attempt === 1 ? null : "受控重试");
      const timeout = AbortSignal.timeout(this.#timeoutMs);
      const signal = AbortSignal.any([input.signal, timeout]);
      try {
        const response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${this.#apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({
            model: this.#model,
            messages: [
              {
                role: "system",
                content: input.systemPrompt
                  ?? "你是古建保护项目资料整理助手。只根据输入资料生成候选，不补写缺失的测量、年代、材料或病害结论。输出 JSON 对象，字段为 summary、findings、missingInformation，后两项为字符串数组。",
              },
              {
                role: "user",
                // 纯文本任务保持字符串形式，带图时才改成内容块数组
                content: input.images?.length
                  ? [
                    { type: "text", text: input.userContent },
                    ...input.images.map((image) => ({
                      type: "image_url",
                      image_url: { url: `data:${image.mediaType};base64,${image.base64}` },
                    })),
                  ]
                  : input.userContent,
              },
            ],
            response_format: { type: "json_object" },
            thinking: { type: "disabled" },
            stream: true,
            stream_options: { include_usage: true },
            // 架构 v1.4 §7.3 口径：max_completion_tokens，不显式设置 temperature
            max_completion_tokens: input.maxOutputTokens ?? this.#maxOutputTokens,
          }),
          signal,
        });
        if (!response.ok) {
          const detail = (await response.text()).slice(0, 1_000);
          const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
          if (retryable && attempt < this.#maxAttempts) continue;
          throw new Error(`KIMI_HTTP_${response.status}:${detail}`);
        }
        if (!response.body) throw new Error("KIMI_STREAM_MISSING");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let content = "";
        let usage: ModelUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 };
        const consumeLine = (line: string) => {
          if (!line.startsWith("data:")) return;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") return;
          const parsed = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string } }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cached_tokens?: number };
          };
          const text = parsed.choices?.[0]?.delta?.content ?? "";
          if (text) {
            content += text;
            input.onChunk(text, attempt);
          }
          if (parsed.usage) {
            usage = {
              promptTokens: parsed.usage.prompt_tokens ?? 0,
              completionTokens: parsed.usage.completion_tokens ?? 0,
              totalTokens: parsed.usage.total_tokens ?? 0,
              cachedTokens: parsed.usage.cached_tokens ?? 0,
            };
          }
        };
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (input.signal.aborted) throw new RunCancelledError();
          buffer += decoder.decode(chunk.value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";
          for (const line of lines) consumeLine(line);
        }
        if (buffer.trim()) consumeLine(buffer);
        if (!content.trim()) throw new Error("KIMI_EMPTY_OUTPUT");
        return { content, usage, attempt };
      } catch (error) {
        if (input.signal.aborted) throw new RunCancelledError();
        const retryable = timeout.aborted || error instanceof TypeError;
        if (retryable && attempt < this.#maxAttempts) continue;
        if (timeout.aborted) throw new Error("KIMI_TIMEOUT");
        throw error;
      }
    }
    throw new Error("KIMI_RETRY_EXHAUSTED");
  }

  // 动作分发调用：带 tools 的非流式请求，返回工具调用或文本回复。
  // 与 execute 相互独立，tools 只含名称、描述、参数三字段（由调用方投影保证）。
  async executeWithTools(input: {
    systemPrompt: string;
    userContent: string;
    tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
    signal: AbortSignal;
  }): Promise<ToolDispatchResult> {
    if (!this.configured) throw new Error("KIMI_API_KEY_NOT_CONFIGURED");
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      if (input.signal.aborted) throw new RunCancelledError();
      const timeout = AbortSignal.timeout(this.#timeoutMs);
      const signal = AbortSignal.any([input.signal, timeout]);
      try {
        const response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${this.#apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({
            model: this.#model,
            messages: [
              { role: "system", content: input.systemPrompt },
              { role: "user", content: input.userContent },
            ],
            tools: input.tools.map((tool) => ({
              type: "function",
              function: { name: tool.name, description: tool.description, parameters: tool.parameters },
            })),
            thinking: { type: "disabled" },
            stream: false,
            // 架构 v1.4 §7.3 口径：max_completion_tokens，不显式设置 temperature
            // （kimi-k2.6 对显式 temperature 仅接受 0.6，省略由服务端取默认）
            max_completion_tokens: this.#maxOutputTokens,
          }),
          signal,
        });
        if (!response.ok) {
          const detail = (await response.text()).slice(0, 1_000);
          const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
          if (retryable && attempt < this.#maxAttempts) continue;
          throw new Error(`KIMI_HTTP_${response.status}:${detail}`);
        }
        const raw = await response.text();
        const parsed = JSON.parse(raw) as {
          choices?: Array<{
            message?: {
              content?: string | null;
              tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
            };
          }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cached_tokens?: number };
        };
        const usage: ModelUsage = {
          promptTokens: parsed.usage?.prompt_tokens ?? 0,
          completionTokens: parsed.usage?.completion_tokens ?? 0,
          totalTokens: parsed.usage?.total_tokens ?? 0,
          cachedTokens: parsed.usage?.cached_tokens ?? 0,
        };
        const message = parsed.choices?.[0]?.message;
        const toolCall = message?.tool_calls?.[0]?.function;
        if (toolCall?.name) {
          return {
            kind: "tool_call",
            name: toolCall.name,
            argumentsJson: toolCall.arguments ?? "{}",
            raw,
            usage,
            attempt,
          };
        }
        const content = message?.content ?? "";
        if (!content.trim()) throw new Error("KIMI_EMPTY_OUTPUT");
        return { kind: "text", content, raw, usage, attempt };
      } catch (error) {
        if (input.signal.aborted) throw new RunCancelledError();
        const retryable = timeout.aborted || error instanceof TypeError;
        if (retryable && attempt < this.#maxAttempts) continue;
        if (timeout.aborted) throw new Error("KIMI_TIMEOUT");
        throw error;
      }
    }
    throw new Error("KIMI_RETRY_EXHAUSTED");
  }
}

export type ToolDispatchResult =
  | { kind: "tool_call"; name: string; argumentsJson: string; raw: string; usage: ModelUsage; attempt: number }
  | { kind: "text"; content: string; raw: string; usage: ModelUsage; attempt: number };
