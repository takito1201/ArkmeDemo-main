import { AiApiError, callAiJson } from "@/ai/aiClient";
import {
  addDays,
  buildDateKey,
  type ArrangementItem,
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

export type ArrangementUpdatePatch = Partial<ArrangementDraft> & {
  arrangementId: string;
  confidence: number;
  noteAppend: string;
  context: string;
  reason?: string;
};

export type ArrangementUpdateRecognitionResult =
  | {
      status: "success";
      message: string;
      updates: ArrangementUpdatePatch[];
      source: "ai" | "rules";
    }
  | {
      status: "empty";
      message: string;
      updates: [];
      source: "ai" | "rules";
    }
  | {
      status: "failed";
      message: string;
      updates: [];
    };

type AiUpdateResponse = {
  hasUpdate?: unknown;
  updates?: unknown;
};

export type ArrangementJudgeActionType =
  | "new_arrangement"
  | "update_existing"
  | "alias_candidate"
  | "unknown_symbol_arrangement"
  | "no_action";

export type ArrangementJudgeMessage = {
  id: string;
  sender: string;
  senderRole: "me" | "other";
  text: string;
  sentAt: number;
  isCurrent?: boolean;
};

export type ArrangementJudgeAliasRule = {
  alias: string;
  meaning: string;
  scope?: "conversation" | "contact" | "global";
};

export type ArrangementJudgeActiveIntent = {
  arrangementId: string;
  topic: string;
  participantIds: string[];
  sourceMessageIds: string[];
} | null;

export type ArrangementJudgeInput = {
  conversationType: "private" | "group";
  currentMessage: ArrangementJudgeMessage;
  messages: ArrangementJudgeMessage[];
  existingArrangements: ArrangementItem[];
  knownAliases: ArrangementJudgeAliasRule[];
  activeConversationIntent: ArrangementJudgeActiveIntent;
  recallReasons: string[];
};

export type ArrangementJudgeAction = {
  type: ArrangementJudgeActionType;
  confidence: number;
  reason: string;
  draft?: AiArrangementDraft;
  update?: ArrangementUpdatePatch;
  aliasText?: string;
  aliasMeaning?: string;
  candidateArrangementIds?: string[];
};

export type ArrangementJudgeResult =
  | {
      status: "success";
      message: string;
      actions: ArrangementJudgeAction[];
    }
  | {
      status: "empty";
      message: string;
      actions: [];
    }
  | {
      status: "not_configured";
      message: string;
      actions: [];
    }
  | {
      status: "failed";
      message: string;
      actions: [];
    };

type AiJudgeResponse = {
  actions?: unknown;
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

function buildUpdateRecognitionPrompt(
  contextText: string,
  arrangements: ArrangementItem[]
) {
  const today = buildDateKey(new Date());
  const tomorrow = buildDateKey(addDays(new Date(), 1));
  const dayAfterTomorrow = buildDateKey(addDays(new Date(), 2));
  const arrangementText = arrangements
    .map((item) =>
      [
        `id=${item.id}`,
        `title=${item.title}`,
        `time=${item.timeText || "空"}`,
        `location=${item.locationName || item.locationText || "空"}`,
        `people=${item.peopleText || "空"}`,
        `note=${item.note || "空"}`,
      ].join("；")
    )
    .join("\n");

  return [
    "请判断新聊天内容是否在补充或修改已有待办/安排。",
    "只返回 JSON，不要输出 Markdown。",
    "如果新消息是在补充已有事项的时间、地点、参与人、备注或准备材料，返回对应已有安排 id 和需要更新的字段。",
    "如果新消息像一个全新安排，或无法确定属于哪个已有安排，返回 hasUpdate=false。",
    "返回结构：",
    "{",
    '  "hasUpdate": boolean,',
    '  "updates": [',
    "    {",
    '      "arrangementId": "已有安排 id",',
    '      "timeText": "自然语言时间或空字符串",',
    '      "dateKey": "YYYY-MM-DD 或空字符串",',
    '      "startTime": "HH:mm 或空字符串",',
    '      "endTime": "HH:mm 或空字符串",',
    '      "timeKind": "none | allDay | time | timeRange",',
    '      "peopleText": "相关人或空字符串",',
    '      "locationText": "地点或空字符串",',
    '      "locationName": "地点名或空字符串",',
    '      "noteAppend": "需要追加到备注的补充信息或空字符串",',
    '      "confidence": 0.0',
    "    }",
    "  ]",
    "}",
    `今天是 ${today}，明天是 ${tomorrow}，后天是 ${dayAfterTomorrow}。`,
    "已有安排：",
    arrangementText || "无",
    "新聊天内容：",
    contextText,
  ].join("\n");
}

function buildJudgePrompt(input: ArrangementJudgeInput) {
  const today = buildDateKey(new Date());
  const tomorrow = buildDateKey(addDays(new Date(), 1));
  const dayAfterTomorrow = buildDateKey(addDays(new Date(), 2));
  const messagesText = input.messages
    .map((message) =>
      [
        message.isCurrent ? "[当前消息]" : "[上下文]",
        `id=${message.id}`,
        `sender=${message.sender}`,
        `role=${message.senderRole}`,
        `text=${message.text}`,
      ].join(" ")
    )
    .join("\n");
  const arrangementText = input.existingArrangements
    .filter((item) => item.status !== "completed")
    .map((item) =>
      [
        `id=${item.id}`,
        `title=${item.title}`,
        `time=${item.timeText || "空"}`,
        `location=${item.locationName || item.locationText || "空"}`,
        `people=${item.peopleText || "空"}`,
        `note=${item.note || "空"}`,
      ].join("；")
    )
    .join("\n");
  const aliasesText = input.knownAliases
    .map(
      (alias) =>
        `alias=${alias.alias}；meaning=${alias.meaning}；scope=${alias.scope ?? "conversation"}`
    )
    .join("\n");
  const activeIntentText = input.activeConversationIntent
    ? [
        `arrangementId=${input.activeConversationIntent.arrangementId}`,
        `topic=${input.activeConversationIntent.topic}`,
        `participants=${input.activeConversationIntent.participantIds.join(",")}`,
        `sourceMessageIds=${input.activeConversationIntent.sourceMessageIds.join(",")}`,
      ].join("；")
    : "无";

  return [
    "你是聊天安排识别器。请只返回 JSON，不要输出 Markdown。",
    "本地规则只提供候选召回线索，不能当作结论。你必须结合上下文做最终判断。",
    "允许的 action type 只有：new_arrangement、update_existing、alias_candidate、unknown_symbol_arrangement、no_action。",
    "每个 action 必须包含 type、confidence、reason。缺少 confidence 或 reason 的结果会被丢弃。",
    "高风险情况必须让用户确认，因此请在 reason 中说明风险：暗语猜测、更新已有待办、多个候选待办相似、抽象符号含义不明确。",
    "如果只是闲聊、天气、泛泛表达，即使命中时间词，也返回 no_action。",
    "返回结构：",
    "{",
    '  "actions": [',
    "    {",
    '      "type": "new_arrangement | update_existing | alias_candidate | unknown_symbol_arrangement | no_action",',
    '      "confidence": 0.0,',
    '      "reason": "中文解释",',
    '      "draft": { "title": "安排标题", "timeText": "自然语言时间", "dateKey": "YYYY-MM-DD 或空字符串", "startTime": "HH:mm 或空字符串", "endTime": "HH:mm 或空字符串", "timeKind": "none | allDay | time | timeRange", "peopleText": "相关人或空字符串", "locationText": "地点或空字符串", "locationName": "地点名或空字符串", "note": "备注或空字符串", "confidence": 0.0 },',
    '      "update": { "arrangementId": "已有安排 id", "timeText": "自然语言时间或空字符串", "dateKey": "YYYY-MM-DD 或空字符串", "startTime": "HH:mm 或空字符串", "endTime": "HH:mm 或空字符串", "timeKind": "none | allDay | time | timeRange", "peopleText": "相关人或空字符串", "locationText": "地点或空字符串", "locationName": "地点名或空字符串", "noteAppend": "追加备注或空字符串", "confidence": 0.0 },',
    '      "aliasText": "暗语文本或空字符串",',
    '      "aliasMeaning": "猜测含义或空字符串",',
    '      "candidateArrangementIds": ["候选待办 id"]',
    "    }",
    "  ]",
    "}",
    `今天是 ${today}，明天是 ${tomorrow}，后天是 ${dayAfterTomorrow}。`,
    `会话类型：${input.conversationType}`,
    "当前消息：",
    JSON.stringify(input.currentMessage),
    "前后聊天记录：",
    messagesText || "无",
    "当前已有待办：",
    arrangementText || "无",
    "已知暗语规则：",
    aliasesText || "无",
    "当前 activeConversationIntent：",
    activeIntentText,
    "本地召回原因：",
    input.recallReasons.join("、") || "无",
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

function normalizeUpdateResponse(
  value: unknown,
  contextText: string,
  arrangements: ArrangementItem[]
): ArrangementUpdatePatch[] {
  if (!value || typeof value !== "object") return [];

  const response = value as AiUpdateResponse;
  if (response.hasUpdate === false || !Array.isArray(response.updates)) {
    return [];
  }

  const arrangementIds = new Set(arrangements.map((item) => item.id));
  return response.updates
    .map((update): ArrangementUpdatePatch | null => {
      if (!update || typeof update !== "object") return null;
      const patch = update as Partial<ArrangementUpdatePatch>;
      const arrangementId = normalizeText(patch.arrangementId);
      if (!arrangementIds.has(arrangementId)) return null;

      return {
        arrangementId,
        timeText: normalizeText(patch.timeText),
        dateKey: normalizeText(patch.dateKey),
        startTime: normalizeText(patch.startTime),
        endTime: normalizeText(patch.endTime),
        timeKind: normalizeTimeKind(patch.timeKind),
        peopleText: normalizeText(patch.peopleText),
        locationText: normalizeText(patch.locationText),
        locationName:
          normalizeText(patch.locationName) || normalizeText(patch.locationText),
        noteAppend: normalizeText(patch.noteAppend),
        confidence: normalizeConfidence(patch.confidence),
        context: contextText,
        reason: normalizeText(patch.reason),
      };
    })
    .filter((item): item is ArrangementUpdatePatch => Boolean(item))
    .slice(0, maxDraftCount);
}

function normalizeJudgeAction(
  value: unknown,
  input: ArrangementJudgeInput
): ArrangementJudgeAction | null {
  if (!value || typeof value !== "object") return null;

  const action = value as Partial<ArrangementJudgeAction> & {
    type?: unknown;
    draft?: unknown;
    update?: unknown;
    confidence?: unknown;
    reason?: unknown;
    aliasText?: unknown;
    aliasMeaning?: unknown;
    candidateArrangementIds?: unknown;
  };
  const type = normalizeText(action.type);
  if (
    type !== "new_arrangement" &&
    type !== "update_existing" &&
    type !== "alias_candidate" &&
    type !== "unknown_symbol_arrangement" &&
    type !== "no_action"
  ) {
    return null;
  }

  const reason = normalizeText(action.reason);
  if (!reason || typeof action.confidence !== "number") return null;

  const confidence = normalizeConfidence(action.confidence);
  const candidateArrangementIds = Array.isArray(action.candidateArrangementIds)
    ? action.candidateArrangementIds
        .map((item) => normalizeText(item))
        .filter(Boolean)
    : [];
  const normalized: ArrangementJudgeAction = {
    type,
    confidence,
    reason,
    aliasText: normalizeText(action.aliasText),
    aliasMeaning: normalizeText(action.aliasMeaning),
    candidateArrangementIds,
  };

  if (type === "new_arrangement" || type === "unknown_symbol_arrangement") {
    const draft = normalizeAiDraft(action.draft, input.currentMessage.text);
    if (!draft) return null;
    normalized.draft = {
      ...draft,
      confidence,
      contexts: [input.currentMessage.text, reason],
    };
  }

  if (type === "update_existing") {
    const updates = normalizeUpdateResponse(
      { hasUpdate: true, updates: [action.update] },
      input.currentMessage.text,
      input.existingArrangements
    );
    if (updates.length === 0) return null;
    normalized.update = {
      ...updates[0],
      confidence,
      reason,
    };
  }

  return normalized;
}

function normalizeJudgeResponse(
  value: unknown,
  input: ArrangementJudgeInput
): ArrangementJudgeAction[] {
  if (!value || typeof value !== "object") return [];

  const response = value as AiJudgeResponse;
  if (!Array.isArray(response.actions)) return [];

  return response.actions
    .map((action) => normalizeJudgeAction(action, input))
    .filter((action): action is ArrangementJudgeAction => Boolean(action))
    .slice(0, maxDraftCount);
}

export async function judgeArrangementIntentFromChat(
  input: ArrangementJudgeInput
): Promise<ArrangementJudgeResult> {
  if (!hasAiApiSettings()) {
    return {
      status: "not_configured",
      message: "请先去“我的 -> 设置 -> AI API 设置”完成配置，AI 会作为安排判断的主入口。",
      actions: [],
    };
  }

  try {
    const output = await callAiJson(buildJudgePrompt(input));
    const actions = normalizeJudgeResponse(output, input).filter(
      (action) => action.type !== "no_action"
    );

    if (actions.length === 0) {
      return {
        status: "empty",
        message: "AI 判断当前候选不是需要处理的安排或暗语。",
        actions: [],
      };
    }

    return {
      status: "success",
      message: "AI 已完成安排与暗语主判定。",
      actions,
    };
  } catch (error) {
    return {
      status: "failed",
      message:
        error instanceof AiApiError
          ? "AI 调用失败，规则只负责召回候选，不会直接创建或更新安排。"
          : "识别服务暂不可用，规则只负责召回候选，不会直接创建或更新安排。",
      actions: [],
    };
  }
}

function buildReadableDate(dateKey: string) {
  const [, month, day] = dateKey.split("-");
  return `${Number(month)}月${Number(day)}日`;
}

export function recognizeByRules(contextText: string): AiArrangementDraft[] {
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

export function recognizeGroupByRules(contextText: string): AiArrangementDraft[] {
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

function parseRuleTimePatch(text: string) {
  const mentionsTomorrow = /明天/.test(text);
  const mentionsDayAfterTomorrow = /后天/.test(text);
  const dateKey = mentionsDayAfterTomorrow
    ? buildDateKey(addDays(new Date(), 2))
    : mentionsTomorrow
      ? buildDateKey(addDays(new Date(), 1))
      : "";
  const afternoonThree = /下午三点|下午3点|15点|15:00/.test(text);
  const morningNine = /上午九点|上午9点|9点|09:00/.test(text);
  const eveningEight = /晚上八点|晚上8点|8点怎么说|八点怎么说|20点|20:00/.test(text);
  const startTime = afternoonThree
    ? "15:00"
    : eveningEight
      ? "20:00"
      : morningNine
        ? "09:00"
        : "";
  const timeText = [mentionsDayAfterTomorrow ? "后天" : mentionsTomorrow ? "明天" : "", startTime]
    .filter(Boolean)
    .join(" ");

  if (!dateKey && !startTime && !/时间|改到|改成|提前|推迟|几点|怎么说/.test(text)) {
    return {};
  }

  return {
    timeText,
    dateKey,
    startTime,
    endTime: "",
    timeKind: startTime ? "time" : dateKey ? "allDay" : "none",
  } satisfies Partial<ArrangementDraft>;
}

function parseRuleLocation(text: string) {
  const match = text.match(
    /(地点|地址|在|改成|改到)([^，。；\n]*(医院|图书馆三楼|图书馆|腾讯会议|线上|会议室|公司|办公室)[^，。；\n]*)/
  );
  if (!match) return "";

  return match[2].replace(/^(在|是|到)/, "").trim();
}

export function recognizeUpdateByRules(
  contextText: string,
  arrangements: ArrangementItem[]
): ArrangementUpdatePatch[] {
  const normalizedText = contextText.trim();
  if (!normalizedText || arrangements.length === 0) return [];

  const hasUpdateSignal =
    /(时间|地点|地址|改到|改成|提前|推迟|线上|腾讯会议|带上|记得带|身份证|图书馆|医院|会议室|几点|怎么说|8点|八点)/.test(
      normalizedText
    );
  if (!hasUpdateSignal) return [];

  const matchedArrangement =
    arrangements.find(
      (item) =>
        (item.locationName && normalizedText.includes(item.locationName)) ||
        (item.locationText && normalizedText.includes(item.locationText)) ||
        item.title
          .split(/[，。；、\s]/)
          .filter((part) => part.length >= 2)
          .some((part) => normalizedText.includes(part))
    ) ?? arrangements[0];
  const location = parseRuleLocation(normalizedText);
  const timePatch = parseRuleTimePatch(normalizedText);
  const noteAppend = /(带上|记得带|身份证)/.test(normalizedText)
    ? normalizedText.replace(/^.*?[：:]/, "").trim()
    : "";

  if (
    !timePatch.timeText &&
    !timePatch.dateKey &&
    !location &&
    !noteAppend
  ) {
    return [];
  }

  return [
    {
      arrangementId: matchedArrangement.id,
      ...timePatch,
      peopleText: "",
      locationText: location,
      locationName: location,
      noteAppend,
      confidence: 0.64,
      context: contextText,
    },
  ];
}

export async function recognizeArrangementUpdateFromChat(
  contextText: string,
  arrangements: ArrangementItem[]
): Promise<ArrangementUpdateRecognitionResult> {
  const normalizedContext = contextText.trim();
  const activeArrangements = arrangements.filter(
    (item) => item.status !== "completed"
  );
  if (!normalizedContext || activeArrangements.length === 0) {
    return {
      status: "empty",
      message: "没有可用于补全的已有安排。",
      updates: [],
      source: "rules",
    };
  }

  if (!hasAiApiSettings()) {
    return {
      status: "failed",
      message: "AI 未配置，规则不会直接更新已有安排。",
      updates: [],
    };
  }

  try {
    const output = await callAiJson(
      buildUpdateRecognitionPrompt(normalizedContext, activeArrangements)
    );
    const updates = normalizeUpdateResponse(
      output,
      normalizedContext,
      activeArrangements
    );
    if (updates.length === 0) {
      return {
        status: "empty",
        message: "AI 未识别到已有安排的补充信息。",
        updates: [],
        source: "ai",
      };
    }

    return {
      status: "success",
      message: "AI 已识别到已有安排的补充信息。",
      updates,
      source: "ai",
    };
  } catch {
    return {
      status: "failed",
      message: "AI 调用失败，规则不会直接更新已有安排。",
      updates: [],
    };
  }
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
    return {
      status: "failed",
      message:
        error instanceof AiApiError
          ? "AI 调用失败，规则不会直接生成待确认草稿。"
          : "识别服务暂不可用，规则不会直接生成待确认草稿。",
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
    return {
      status: "failed",
      message: "AI 调用失败，规则不会直接生成群聊待确认草稿。",
      drafts: [],
    };
  }
}
