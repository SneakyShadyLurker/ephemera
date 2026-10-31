/**
 * The model providers `./ephemera setup` offers, as README § Model providers
 * lists them (a unit test keeps the two in step). Local servers carry
 * `<host>`, which the wizard fills in.
 */
export interface Provider {
  name: string;
  baseUrl: string;
  /** Whether the provider refuses requests without an API key. */
  keyRequired: boolean;
}

export const PROVIDERS: readonly Provider[] = [
  { name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", keyRequired: true },
  { name: "DeepSeek", baseUrl: "https://api.deepseek.com", keyRequired: true },
  { name: "Groq", baseUrl: "https://api.groq.com/openai/v1", keyRequired: true },
  { name: "Mistral", baseUrl: "https://api.mistral.ai/v1", keyRequired: true },
  { name: "Together AI", baseUrl: "https://api.together.ai/v1", keyRequired: true },
  { name: "Ollama", baseUrl: "http://<host>:11434/v1", keyRequired: false },
  { name: "LM Studio", baseUrl: "http://<host>:1234/v1", keyRequired: false },
  { name: "vLLM", baseUrl: "http://<host>:8000/v1", keyRequired: false },
  { name: "llama.cpp server", baseUrl: "http://<host>:8080/v1", keyRequired: false },
  { name: "CLIProxyAPI", baseUrl: "http://<host>:8317/v1", keyRequired: true },
];

export type ModelsCheck =
  | { ok: true; models: number }
  | { ok: false; reason: "unreachable" | "unauthorized" | "unexpected"; status?: number };

/**
 * Asks the upstream for its model list, as the server does: whether the
 * address answers, the key is accepted and the answer looks like a list.
 */
export async function checkModels(
  baseUrl: string,
  apiKey: string | undefined,
): Promise<ModelsCheck> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    return { ok: false, reason: "unauthorized", status: response.status };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return { ok: false, reason: "unexpected", status: response.status };
  }
  try {
    const body = (await response.json()) as { data?: unknown };
    return Array.isArray(body.data)
      ? { ok: true, models: body.data.length }
      : { ok: false, reason: "unexpected", status: response.status };
  } catch {
    return { ok: false, reason: "unexpected", status: response.status };
  }
}
