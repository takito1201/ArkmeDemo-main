import {
  getAiApiSettings,
  hasAiApiSettings,
} from "@/settings/aiApiSettings";

export type AiApiErrorCode =
  | "AI_API_NOT_CONFIGURED"
  | "AI_API_REQUEST_FAILED"
  | "AI_API_JSON_PARSE_FAILED";

export class AiApiError extends Error {
  code: AiApiErrorCode;

  constructor(code: AiApiErrorCode, message: string) {
    super(message);
    this.name = "AiApiError";
    this.code = code;
  }
}

type ChatCompletionsResponse = {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
};

function buildChatCompletionsUrl(baseUrl: string) {
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(normalizedBaseUrl)) {
    return normalizedBaseUrl;
  }

  return `${normalizedBaseUrl}/chat/completions`;
}

function getContentFromResponse(value: unknown) {
  const response = value as ChatCompletionsResponse;
  const content = response.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : "";
}

export async function callAiJson(prompt: string): Promise<unknown> {
  if (!hasAiApiSettings()) {
    throw new AiApiError(
      "AI_API_NOT_CONFIGURED",
      "AI API settings are not configured."
    );
  }

  const settings = getAiApiSettings();
  if (!settings?.baseUrl || !settings.apiKey || !settings.model) {
    throw new AiApiError(
      "AI_API_NOT_CONFIGURED",
      "AI API settings are not configured."
    );
  }

  let response: Response;

  try {
    response = await fetch(buildChatCompletionsUrl(settings.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.model,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You are a JSON API. Return only a valid JSON object with no markdown.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
    });
  } catch {
    throw new AiApiError(
      "AI_API_REQUEST_FAILED",
      "AI API request failed."
    );
  }

  if (!response.ok) {
    throw new AiApiError(
      "AI_API_REQUEST_FAILED",
      "AI API request failed."
    );
  }

  let responseJson: unknown;

  try {
    responseJson = await response.json();
  } catch {
    throw new AiApiError(
      "AI_API_REQUEST_FAILED",
      "AI API response was not readable."
    );
  }

  const content = getContentFromResponse(responseJson);
  if (!content) {
    throw new AiApiError(
      "AI_API_REQUEST_FAILED",
      "AI API response was missing content."
    );
  }

  try {
    return JSON.parse(content);
  } catch {
    throw new AiApiError(
      "AI_API_JSON_PARSE_FAILED",
      "AI API response was not valid JSON."
    );
  }
}
