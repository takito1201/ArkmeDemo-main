import { AiApiError, callAiJson } from "@/ai/aiClient";
import {
  addDays,
  buildDateKey,
  type ArrangementDraft,
  type ArrangementTimeKind,
} from "@/arrangements/arrangementStorage";
import { hasAiApiSettings } from "@/settings/aiApiSettings";

export type AiArrangementDraft = ArrangementDraft & {
  confidence: number;
  contexts: string[];
};

export type ArrangementRecognitionResult =
  | {
      status: "not_configured";
      message: string;
      drafts: [];
    }
  | {
      status: "success";
      message: string;
      drafts: AiArrangementDraft[];
      source: "ai" | "rules" | "ai_group_chat";
    }
  | {
      status: "empty";
      message: string;
      drafts: [];
      source: "ai" | "rules" | "ai_group_chat";
    }
  | {
      status: "failed";
      message: string;
      drafts: [];
    };

type AiRecognitionResponse = {
  hasArrangement?: unknown;
  drafts?: unknown;
};

const maxDraftCount = 3;

function buildRecognitionPrompt(contextText: string) {
  const today = buildDateKey(new Date());
  const tomorrow = buildDateKey(addDays(new Date(), 1));
  const dayAfterTomorrow = buildDateKey(addDays(new Date(), 2));

  return [
    "请从下面的微信私聊内容中判断是否包含需要后续执行的安排。",
    "只返回 JSON，不要输出 Markdown。",
    "返回结构：",
    "{",
    '  "hasArrangement": boolean,',
    '  "drafts": [',
    "    {",
    '      "title": "安排标题",',
    '      "timeText": "自然语言时间",',
    '      "dateKey": "YYYY-MM-DD 或空字符串",',
    '      "startTime": "HH:mm 或空字符串",',
    '      "endTime": "HH:mm 或空字符串",',
    '      "timeKind": "none | allDay | time | timeRange",',
    '      "peopleText": "相关人或空字符串",',
    '      "locationText": "地点或空字符串",',
    '      "locationName": "地点名或空字符串",',
    '      "note": "补充说明或空字符串",',
    '      "confidence": 0.0',
    "    }",
    "  ]",
    "}",
    `今天是 ${today}，明天是 ${tomorrow}，后天是 ${dayAfterTomorrow}。`,
    "AI 只生成待确认草稿，不要假装已经保存安排。",
    "如果没有安排，返回 hasArrangement=false 且 drafts=[]。",
    "私聊内容：",
    contextText,
  ].join("\n");
}

function buildGroupRecognitionPrompt(contextText: string) {
  const today = buildDateKey(new Date());
  const tomorrow = buildDateKey(addDays(new Date(), 1));
  const dayAfterTomorrow = buildDateKey(addDays(new Date(), 2));

  return [
    "请从下面的模拟微信群聊内容中识别“需要我自己完成”的安排。",
    "只返回 JSON，不要输出 Markdown。",
    "重要规则：",
    "1. 只识别和“我”有关、且需要我执行的事项。",
    "2. 别人提出请求 + 我明确答应、认领、说我来/可以/好的，才算我的安排。",
    "3. 别人自己的安排、别人互相约定、只是通知我但不需要我做的事，不要输出。",
    "4. 多个相近请求可以聚合成同一个草稿，不要重复输出。",
    "5. 你只生成待确认草稿，不允许假装已经写入安排。",
    "返回结构：",
    "{",
    '  "hasArrangement": boolean,',
    '  "drafts": [',
    "    {",
    '      "title": "安排标题",',
    '      "timeText": "自然语言时间",',
    '      "dateKey": "YYYY-MM-DD 或空字符串",',
    '      "startTime": "HH:mm 或空字符串",',
    '      "endTime": "HH:mm 或空字符串",',
    '      "timeKind": "none | allDay | time | timeRange",',
    '      "peopleText": "相关人或空字符串",',
    '      "locationText": "地点或空字符串",',
    '      "locationName": "地点名或空字符串",',
    '      "note": "说明为什么这是我的安排，或空字符串",',
    '      "confidence": 0.0',
    "    }",
    "  ]",
    "}",
    `今天是 ${today}，明天是 ${tomorrow}，后天是 ${dayAfterTomorrow}。`,
    "群聊内容：",
    contextText,
  ].join("\n");
}

function normalizeText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeConfidence(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0.72;
  return Math.min(1, Math.max(0, value));
}

function normalizeTimeKind(value: unknown): ArrangementTimeKind {
  return value === "allDay" || value === "time" || value === "timeRange"
    ? value
    : "none";
}

function normalizeAiDraft(value: unknown, contextText: string): AiArrangementDraft | null {
  if (!value || typeof value !== "object") return null;

  const draft = value as Partial<AiArrangementDraft>;
  const title = normalizeText(draft.title);
  if (!title) return null;

  const locationText = normalizeText(draft.locationText);
  const locationName = normalizeText(draft.locationName) || locationText;

  return {
    title,
    timeText: normalizeText(draft.timeText),
    dateKey: normalizeText(draft.dateKey),
    startTime: normalizeText(draft.startTime),
    endTime: normalizeText(draft.endTime),
    timeKind: normalizeTimeKind(draft.timeKind),
    peopleText: normalizeText(draft.peopleText),
    locationText,
    locationName,
    note: normalizeText(draft.note),
    confidence: normalizeConfidence(draft.confidence),
    contexts: [contextText],
  };
}

function normalizeAiResponse(value: unknown, contextText: string): AiArrangementDraft[] {
  if (!value || typeof value !== "object") return [];

  const response = value as AiRecognitionResponse;
  if (response.hasArrangement === false || !Array.isArray(response.drafts)) {
    return [];
  }

  return response.drafts
    .map((draft) => normalizeAiDraft(draft, contextText))
    .filter((draft): draft is AiArrangementDraft => Boolean(draft))
    .slice(0, maxDraftCount);
}

function buildReadableDate(dateKey: string) {
  const [, month, day] = dateKey.split("-");
  return `${Number(month)}月${Number(day)}日`;
}

function recognizeByRules(contextText: string): AiArrangementDraft[] {
  const normalizedText = contextText.trim();
  if (!normalizedText) return [];

  const mentionsBreakfast = /早餐|早饭|早点/.test(normalizedText);
  const mentionsBring = /带|拿|买|捎/.test(normalizedText);
  const mentionsCompany = /公司|办公室/.test(normalizedText);
  const mentionsTomorrow = /明天/.test(normalizedText);
  const mentionsDayAfterTomorrow = /后天/.test(normalizedText);

  if (!(mentionsBreakfast && mentionsBring) && !mentionsCompany) {
    return [];
  }

  const dateKey = mentionsDayAfterTomorrow
    ? buildDateKey(addDays(new Date(), 2))
    : mentionsTomorrow
      ? buildDateKey(addDays(new Date(), 1))
      : "";
  const timeText = dateKey
    ? `${buildReadableDate(dateKey)}${mentionsBreakfast ? " 早上" : ""}`
    : "";

  return [
    {
      title: mentionsBreakfast ? "到公司帮对方带早餐" : "跟进私聊里的安排",
      timeText,
      dateKey,
      startTime: "",
      endTime: "",
      timeKind: dateKey ? "allDay" : "none",
      peopleText: normalizedText.includes("A：") ? "A" : "",
      locationText: mentionsCompany ? "公司" : "",
      locationName: mentionsCompany ? "公司" : "",
      note: "AI 调用失败后由本地规则生成，请确认后再加入安排。",
      confidence: 0.58,
      contexts: [contextText],
    },
  ];
}

function recognizeGroupByRules(contextText: string): AiArrangementDraft[] {
  const normalizedText = contextText.trim();
  if (!normalizedText) return [];

  const hasCommitment =
    /我[：:][\\s\\S]*(好的|好呀|可以|没问题|我来|我去|我带|我买|我拿|我处理|我负责|交给我)/.test(
      normalizedText
    ) ||
    /(好的|好呀|可以|没问题|我来|我去|我带|我买|我拿|我处理|我负责|交给我)/.test(
      normalizedText
    );
  const hasRequest = /(谁|能不能|可以|帮|麻烦|记得|需要|安排|带|买|拿|处理|整理)/.test(
    normalizedText
  );
  if (!hasCommitment || !hasRequest) return [];

  const mentionsBreakfast = /早餐|早饭|早点/.test(normalizedText);
  const mentionsDocument = /资料|文档|文件|表格/.test(normalizedText);
  const mentionsCompany = /公司|办公室/.test(normalizedText);
  const mentionsTomorrow = /明天/.test(normalizedText);
  const mentionsDayAfterTomorrow = /后天/.test(normalizedText);
  const dateKey = mentionsDayAfterTomorrow
    ? buildDateKey(addDays(new Date(), 2))
    : mentionsTomorrow
      ? buildDateKey(addDays(new Date(), 1))
      : "";
  const timeText = dateKey
    ? `${buildReadableDate(dateKey)}${mentionsBreakfast ? " 早上" : ""}`
    : "";

  return [
    {
      title: mentionsBreakfast
        ? "在群聊中答应帮忙带早餐"
        : mentionsDocument
          ? "处理群聊中认领的资料事项"
          : "跟进群聊中我答应的安排",
      timeText,
      dateKey,
      startTime: "",
      endTime: "",
      timeKind: dateKey ? "allDay" : "none",
      peopleText: "",
      locationText: mentionsCompany ? "公司" : "",
      locationName: mentionsCompany ? "公司" : "",
      note: "AI 调用失败后由本地规则生成，请确认后再加入安排。",
      confidence: 0.56,
      contexts: [contextText],
    },
  ];
}

export async function recognizeArrangementFromPrivateChat(
  contextText: string
): Promise<ArrangementRecognitionResult> {
  const normalizedContext = contextText.trim();
  if (!normalizedContext) {
    return {
      status: "empty",
      message: "请输入一段私聊内容后再识别。",
      drafts: [],
      source: "rules",
    };
  }

  if (!hasAiApiSettings()) {
    return {
      status: "not_configured",
      message: "请先去“我的 -> 设置 -> AI API 设置”完成配置。",
      drafts: [],
    };
  }

  try {
    const output = await callAiJson(buildRecognitionPrompt(normalizedContext));
    const drafts = normalizeAiResponse(output, normalizedContext);

    if (drafts.length === 0) {
      return {
        status: "empty",
        message: "AI 未识别到需要加入安排的内容。",
        drafts: [],
        source: "ai",
      };
    }

    return {
      status: "success",
      message: "AI 已生成待确认安排草稿。",
      drafts,
      source: "ai",
    };
  } catch (error) {
    const fallbackDrafts = recognizeByRules(normalizedContext);
    if (fallbackDrafts.length > 0) {
      return {
        status: "success",
        message:
          error instanceof AiApiError
            ? "AI 调用失败，已用本地规则生成待确认草稿。"
            : "识别服务暂不可用，已用本地规则生成待确认草稿。",
        drafts: fallbackDrafts,
        source: "rules",
      };
    }

    return {
      status: "failed",
      message: "AI 调用失败，当前内容也未命中本地规则，请稍后重试。",
      drafts: [],
    };
  }
}

export async function recognizeArrangementFromGroupChat(
  contextText: string
): Promise<ArrangementRecognitionResult> {
  const normalizedContext = contextText.trim();
  if (!normalizedContext) {
    return {
      status: "empty",
      message: "请输入一段群聊内容后再识别。",
      drafts: [],
      source: "ai_group_chat",
    };
  }

  if (!hasAiApiSettings()) {
    const fallbackDrafts = recognizeGroupByRules(normalizedContext);
    if (fallbackDrafts.length > 0) {
      return {
        status: "success",
        message: "AI 未配置，已用本地规则生成群聊待确认草稿。",
        drafts: fallbackDrafts,
        source: "ai_group_chat",
      };
    }

    return {
      status: "not_configured",
      message: "请先去“我的 -> 设置 -> AI API 设置”完成配置。",
      drafts: [],
    };
  }

  try {
    const output = await callAiJson(buildGroupRecognitionPrompt(normalizedContext));
    const drafts = normalizeAiResponse(output, normalizedContext);

    if (drafts.length === 0) {
      return {
        status: "empty",
        message: "AI 未识别到需要我完成的群聊安排。",
        drafts: [],
        source: "ai_group_chat",
      };
    }

    return {
      status: "success",
      message: "AI 已生成群聊待确认安排草稿。",
      drafts,
      source: "ai_group_chat",
    };
  } catch {
    const fallbackDrafts = recognizeGroupByRules(normalizedContext);
    if (fallbackDrafts.length > 0) {
      return {
        status: "success",
        message: "AI 调用失败，已用本地规则生成群聊待确认草稿。",
        drafts: fallbackDrafts,
        source: "ai_group_chat",
      };
    }

    return {
      status: "failed",
      message: "AI 调用失败，当前群聊内容也未命中本地规则，请稍后重试。",
      drafts: [],
    };
  }
}
