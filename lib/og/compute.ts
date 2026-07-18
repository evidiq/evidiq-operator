/**
 * 0G Compute Router integration (GPT-5.6-Terra).
 * Adapted from Evidiq main lib/og/compute.ts — generalized for browser-action
 * planning instead of trust analysis.
 */

export type OgComputeConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

const DEFAULTS = {
  computeBaseUrl: "https://router-api.0g.ai/v1",
  computeModel: "gpt-5.6-terra",
};

export function getOgComputeConfig(): OgComputeConfig | null {
  const apiKey = process.env.OG_COMPUTE_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: process.env.OG_COMPUTE_BASE_URL?.trim() || DEFAULTS.computeBaseUrl,
    model: process.env.OG_COMPUTE_MODEL?.trim() || DEFAULTS.computeModel,
  };
}

/** Budget for the inference so it never hangs a paid call. */
const COMPUTE_TIMEOUT_MS = 120_000;

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string | Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  >;
};

export type ChatResponse = {
  content: string;
  model: string;
  requestId?: string;
};

/**
 * Run a single chat completion against 0G Compute Router (OpenAI-compatible).
 * Throws on timeout / non-2xx / missing config.
 */
export async function runInference(
  messages: ChatMessage[],
  opts: { temperature?: number; maxTokens?: number; signal?: AbortSignal } = {}
): Promise<ChatResponse> {
  const cfg = getOgComputeConfig();
  if (!cfg) throw new Error("0G Compute not configured: OG_COMPUTE_API_KEY missing");

  const body = {
    model: cfg.model,
    messages,
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? 1024,
    stream: false,
  };

  const signal = opts.signal ?? AbortSignal.timeout(COMPUTE_TIMEOUT_MS);

  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`0G Compute HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  const json = (await res.json()) as Record<string, unknown>;
  const choices = json?.choices as Array<{ message?: { content?: string } }> | undefined;
  const content = choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content) {
    throw new Error("0G Compute: empty or invalid response");
  }

  return {
    content,
    model: cfg.model,
    requestId: json?.id as string | undefined,
  };
}

/**
 * Helper: run a vision-enabled inference (screenshot + prompt).
 * `screenshotBase64` is a raw base64 PNG (no data: prefix).
 */
export async function runVisionInference(
  systemPrompt: string,
  userText: string,
  screenshotBase64: string,
  opts: { temperature?: number; maxTokens?: number; signal?: AbortSignal } = {}
): Promise<ChatResponse> {
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: [
        { type: "text", text: userText },
        {
          type: "image_url",
          image_url: { url: `data:image/png;base64,${screenshotBase64}` },
        },
      ],
    },
  ];
  return runInference(messages, opts);
}
