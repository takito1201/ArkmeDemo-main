export type AiApiSettings = {
  baseUrl: string;
  apiKey: string;
  model: string;
  updatedAt: number;
};

const aiApiSettingsStorageKey = "arkme-demo.aiApiSettings";

function normalizeSettingText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStoredAiApiSettings(value: unknown): AiApiSettings | null {
  if (!value || typeof value !== "object") return null;

  const settings = value as Partial<AiApiSettings>;
  const baseUrl = normalizeSettingText(settings.baseUrl);
  const apiKey = normalizeSettingText(settings.apiKey);
  const model = normalizeSettingText(settings.model);
  const updatedAt =
    typeof settings.updatedAt === "number" && Number.isFinite(settings.updatedAt)
      ? settings.updatedAt
      : 0;

  if (!baseUrl && !apiKey && !model) return null;

  return { baseUrl, apiKey, model, updatedAt };
}

export function getAiApiSettings(): AiApiSettings | null {
  if (typeof window === "undefined") return null;

  try {
    const storedValue = window.localStorage.getItem(aiApiSettingsStorageKey);
    if (!storedValue) return null;
    return normalizeStoredAiApiSettings(JSON.parse(storedValue));
  } catch {
    return null;
  }
}

export function hasAiApiSettings() {
  const settings = getAiApiSettings();
  return Boolean(settings?.baseUrl && settings.apiKey && settings.model);
}

export function saveAiApiSettings(settings: Pick<AiApiSettings, "baseUrl" | "apiKey" | "model">) {
  if (typeof window === "undefined") return null;

  const nextSettings: AiApiSettings = {
    baseUrl: settings.baseUrl.trim(),
    apiKey: settings.apiKey.trim(),
    model: settings.model.trim(),
    updatedAt: Date.now(),
  };

  window.localStorage.setItem(
    aiApiSettingsStorageKey,
    JSON.stringify(nextSettings)
  );

  return nextSettings;
}

export function clearAiApiSettings() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(aiApiSettingsStorageKey);
}

export function maskAiApiKey(apiKey: string) {
  const normalizedApiKey = apiKey.trim();
  if (!normalizedApiKey) return "";

  if (normalizedApiKey.length <= 8) {
    return `${normalizedApiKey.slice(0, 2)}****${normalizedApiKey.slice(-2)}`;
  }

  return `${normalizedApiKey.slice(0, 3)}****${normalizedApiKey.slice(-4)}`;
}
