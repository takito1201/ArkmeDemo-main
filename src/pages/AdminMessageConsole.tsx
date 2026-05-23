import React from "react";
import {
  judgeArrangementIntentFromChat,
  type ArrangementUpdatePatch,
  type ArrangementJudgeAction,
  type ArrangementJudgeInput,
  type ArrangementJudgeMessage,
} from "@/ai/aiArrangementRecognition";
import { AiApiError, callAiJson } from "@/ai/aiClient";
import {
  appendArrangement,
  arrangementStorageEvent,
  getInitialArrangements,
  persistArrangements,
  type ArrangementDraft,
  type ArrangementItem,
  type ArrangementTimeKind,
} from "@/arrangements/arrangementStorage";
import {
  createTestGroup,
  createTestGroupMessage,
  createTestIdentity,
  createTestMessage,
  getInitialTestGroups,
  getInitialTestIdentities,
  getInitialTestMessages,
  getPrivateConversationId,
  persistTestGroups,
  persistTestIdentities,
  persistTestMessages,
  testConversationStorageEvent,
  testGroupsStorageKey,
  testIdentitiesStorageKey,
  testMessagesStorageKey,
  type TestConversationType,
  type TestGroup,
  type TestIdentity,
  type TestMessage,
} from "@/data/testConversations";
import { formatBubbleTime, formatTimeLabel } from "@/lib/time";
import { cn } from "@/lib/utils";

const adminMessageModeStorageKey = "arkme-demo.adminMessageMode";
const pushedPrivateRecognitionMessageIdsStorageKey =
  "arkme-demo.pushedPrivateRecognitionMessageIds";
const pushedGroupRecognitionMessageIdsStorageKey =
  "arkme-demo.pushedGroupRecognitionMessageIds";
const chatArrangementConfirmationsStorageKey =
  "arkme-demo.chatArrangementConfirmations";
const activeConversationIntentsStorageKey =
  "arkme-demo.activeConversationIntents";
const chatAliasMapStorageKey = "arkme-demo.chatAliasMap";
const chatAliasMapStorageEvent = "arkme-demo.chatAliasMap.updated";
const arrangementUpdateUndoMs = 6000;
const ambiguousUpdateGapThreshold = 0.12;
const aiTestPrompt =
  "请返回一个 JSON 对象，用于验证 AI API 调用是否正常。字段包括 summary、status、nextStep。summary 用一句中文说明连接正常。";

type AiTestResult =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; output: unknown }
  | { status: "error"; message: string };

type AutoRecognitionStatus =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; message: string }
  | { status: "info"; message: string }
  | { status: "error"; message: string };

type ChatArrangementConfirmation = ArrangementDraft & {
  id: string;
  confidence: number;
  contexts: string[];
  source: "ai" | "rules" | "ai_group_chat";
  sourceConversationId: string;
  sourceConversationType: TestConversationType;
  sourceMessageIds: string[];
  sourceSummary: string;
  createdAt: number;
  sourceType?: "unknown_alias_arrangement";
  unknownAliasText?: string;
  suggestedAliasMeaning?: string;
  aliasLearningStatus?: "suggested" | "confirmed";
  aiActionType?: "new_arrangement" | "unknown_symbol_arrangement";
  aiReason?: string;
  candidateReason?: string;
  candidateArrangementIds?: string[];
};

type ArrangementDraftWithRecognitionMeta = ArrangementDraft & {
  confidence: number;
  contexts: string[];
  source: "ai" | "rules" | "ai_group_chat";
  sourceType?: "unknown_alias_arrangement";
  unknownAliasText?: string;
  suggestedAliasMeaning?: string;
  aliasLearningStatus?: "suggested" | "confirmed";
  aiActionType?: "new_arrangement" | "unknown_symbol_arrangement";
  aiReason?: string;
  candidateReason?: string;
  candidateArrangementIds?: string[];
};

type ArrangementUpdateToast = {
  itemTitle: string;
  previousItems: ArrangementItem[];
};

type ActiveConversationIntent = {
  conversationId: string;
  conversationType: TestConversationType;
  arrangementId: string;
  topic: string;
  participantIds: string[];
  sourceMessageIds: string[];
  updatedAt: number;
};

type ScoredArrangementCandidate = {
  arrangement: ArrangementItem;
  score: number;
  reasons: string[];
};

type AmbiguousArrangementUpdate = {
  patch: ArrangementUpdatePatch;
  candidates: ScoredArrangementCandidate[];
  sourceMessageIds: string[];
  conversationType: TestConversationType;
  aiReason?: string;
};

type AliasCandidateConfirmation = {
  id: string;
  conversationId: string;
  conversationType: TestConversationType;
  aliasText: string;
  aliasMeaning: string;
  confidence: number;
  reason: string;
  sourceMessageIds: string[];
  sourceSummary: string;
};

type ChatAliasEntry = {
  id: string;
  conversationId: string;
  conversationType: TestConversationType;
  alias: string;
  meaning: string;
  scope?: "conversation" | "contact" | "global";
  sourceMessageIds?: string[];
  sourceSummary?: string;
  createdAt?: number;
  updatedAt: number;
};

type RecalledRecognitionCandidate = {
  currentMessage: TestMessage;
  messages: TestMessage[];
  reasons: string[];
};

function getInitialAdminMessageMode(): TestConversationType {
  if (typeof window === "undefined") return "private";

  const savedMode = window.localStorage.getItem(adminMessageModeStorageKey);
  return savedMode === "group" ? "group" : "private";
}

function persistAdminMessageMode(mode: TestConversationType) {
  if (typeof window === "undefined") return;

  window.localStorage.setItem(adminMessageModeStorageKey, mode);
}

function buildDateKey(timestamp: number) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isTodayTimestamp(timestamp: number) {
  return buildDateKey(timestamp) === buildDateKey(Date.now());
}

function getPushedPrivateRecognitionMessageIds() {
  if (typeof window === "undefined") return [];

  try {
    const storedValue = window.localStorage.getItem(
      pushedPrivateRecognitionMessageIdsStorageKey
    );
    const parsedValue = storedValue ? JSON.parse(storedValue) : [];
    return Array.isArray(parsedValue)
      ? parsedValue.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function persistPushedPrivateRecognitionMessageIds(messageIds: string[]) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(
      pushedPrivateRecognitionMessageIdsStorageKey,
      JSON.stringify(Array.from(new Set(messageIds)))
    );
  } catch {
    // Recognition dedupe is a convenience; keep message sending usable.
  }
}

function markPrivateRecognitionMessagesPushed(messageIds: string[]) {
  if (messageIds.length === 0) return;

  persistPushedPrivateRecognitionMessageIds([
    ...getPushedPrivateRecognitionMessageIds(),
    ...messageIds,
  ]);
}

function getPushedGroupRecognitionMessageIds() {
  if (typeof window === "undefined") return [];

  try {
    const storedValue = window.localStorage.getItem(
      pushedGroupRecognitionMessageIdsStorageKey
    );
    const parsedValue = storedValue ? JSON.parse(storedValue) : [];
    return Array.isArray(parsedValue)
      ? parsedValue.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function persistPushedGroupRecognitionMessageIds(messageIds: string[]) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(
      pushedGroupRecognitionMessageIdsStorageKey,
      JSON.stringify(Array.from(new Set(messageIds)))
    );
  } catch {
    // Recognition dedupe is a convenience; keep message sending usable.
  }
}

function markGroupRecognitionMessagesPushed(messageIds: string[]) {
  if (messageIds.length === 0) return;

  persistPushedGroupRecognitionMessageIds([
    ...getPushedGroupRecognitionMessageIds(),
    ...messageIds,
  ]);
}

function normalizeText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeConfidence(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : 0;
}

function normalizeTimeKind(value: unknown): ArrangementTimeKind {
  if (value === "allDay" || value === "time" || value === "timeRange") {
    return value;
  }

  return "none";
}

function normalizeStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function normalizeChatArrangementConfirmation(
  value: unknown
): ChatArrangementConfirmation | null {
  if (!value || typeof value !== "object") return null;

  const item = value as Partial<ChatArrangementConfirmation>;
  const id = normalizeText(item.id);
  const title = normalizeText(item.title);
  const sourceConversationId = normalizeText(item.sourceConversationId);
  if (!id || !title || !sourceConversationId) return null;
  const locationText = normalizeText(item.locationText);
  const locationName = normalizeText(item.locationName) || locationText;

  return {
    id,
    title,
    timeText: normalizeText(item.timeText),
    dateKey: normalizeText(item.dateKey),
    startTime: normalizeText(item.startTime),
    endTime: normalizeText(item.endTime),
    timeKind: normalizeTimeKind(item.timeKind),
    peopleText: normalizeText(item.peopleText),
    locationText,
    locationName,
    note: normalizeText(item.note),
    confidence: normalizeConfidence(item.confidence),
    contexts: normalizeStringArray(item.contexts),
    source:
      item.source === "rules" || item.source === "ai_group_chat"
        ? item.source
        : "ai",
    sourceConversationId,
    sourceConversationType: item.sourceConversationType === "group" ? "group" : "private",
    sourceMessageIds: normalizeStringArray(item.sourceMessageIds),
    sourceSummary: normalizeText(item.sourceSummary),
    sourceType:
      item.sourceType === "unknown_alias_arrangement"
        ? item.sourceType
        : undefined,
    unknownAliasText: normalizeText(item.unknownAliasText),
    suggestedAliasMeaning: normalizeText(item.suggestedAliasMeaning),
    aliasLearningStatus:
      item.aliasLearningStatus === "confirmed" ||
      item.aliasLearningStatus === "suggested"
        ? item.aliasLearningStatus
        : undefined,
    aiActionType:
      item.aiActionType === "new_arrangement" ||
      item.aiActionType === "unknown_symbol_arrangement"
        ? item.aiActionType
        : undefined,
    aiReason: normalizeText(item.aiReason),
    candidateReason: normalizeText(item.candidateReason),
    candidateArrangementIds: normalizeStringArray(item.candidateArrangementIds),
    createdAt:
      typeof item.createdAt === "number" && Number.isFinite(item.createdAt)
        ? item.createdAt
        : Date.now(),
  };
}

function getInitialChatArrangementConfirmations() {
  if (typeof window === "undefined") return [];

  try {
    const storedValue = window.localStorage.getItem(
      chatArrangementConfirmationsStorageKey
    );
    const parsedValue = storedValue ? JSON.parse(storedValue) : [];
    return Array.isArray(parsedValue)
      ? parsedValue
          .map(normalizeChatArrangementConfirmation)
          .filter((item): item is ChatArrangementConfirmation => Boolean(item))
      : [];
  } catch {
    return [];
  }
}

function persistChatArrangementConfirmations(
  confirmations: ChatArrangementConfirmation[]
) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(
      chatArrangementConfirmationsStorageKey,
      JSON.stringify(confirmations)
    );
  } catch {
    // Confirmation cards are a convenience; keep message sending usable.
  }
}

function normalizeActiveConversationIntent(
  value: unknown
): ActiveConversationIntent | null {
  if (!value || typeof value !== "object") return null;

  const item = value as Partial<ActiveConversationIntent>;
  const conversationId = normalizeText(item.conversationId);
  const arrangementId = normalizeText(item.arrangementId);
  if (!conversationId || !arrangementId) return null;

  return {
    conversationId,
    conversationType: item.conversationType === "group" ? "group" : "private",
    arrangementId,
    topic: normalizeText(item.topic),
    participantIds: normalizeStringArray(item.participantIds),
    sourceMessageIds: normalizeStringArray(item.sourceMessageIds),
    updatedAt:
      typeof item.updatedAt === "number" && Number.isFinite(item.updatedAt)
        ? item.updatedAt
        : Date.now(),
  };
}

function getInitialActiveConversationIntents() {
  if (typeof window === "undefined") return [];

  try {
    const storedValue = window.localStorage.getItem(
      activeConversationIntentsStorageKey
    );
    const parsedValue = storedValue ? JSON.parse(storedValue) : [];
    return Array.isArray(parsedValue)
      ? parsedValue
          .map(normalizeActiveConversationIntent)
          .filter((item): item is ActiveConversationIntent => Boolean(item))
      : [];
  } catch {
    return [];
  }
}

function persistActiveConversationIntents(intents: ActiveConversationIntent[]) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(
      activeConversationIntentsStorageKey,
      JSON.stringify(intents)
    );
  } catch {
    // Intent memory is best-effort.
  }
}

function normalizeChatAliasEntry(value: unknown): ChatAliasEntry | null {
  if (!value || typeof value !== "object") return null;

  const item = value as Partial<ChatAliasEntry>;
  const id = normalizeText(item.id);
  const conversationId = normalizeText(item.conversationId);
  const alias = normalizeText(item.alias);
  const meaning = normalizeText(item.meaning);
  if (!id || !conversationId || !alias || !meaning) return null;

  return {
    id,
    conversationId,
    conversationType: item.conversationType === "group" ? "group" : "private",
    alias,
    meaning,
    scope:
      item.scope === "contact" || item.scope === "global"
        ? item.scope
        : "conversation",
    sourceMessageIds: Array.isArray(item.sourceMessageIds)
      ? item.sourceMessageIds.map(normalizeText).filter(Boolean)
      : [],
    sourceSummary: normalizeText(item.sourceSummary),
    createdAt:
      typeof item.createdAt === "number" && Number.isFinite(item.createdAt)
        ? item.createdAt
        : undefined,
    updatedAt:
      typeof item.updatedAt === "number" && Number.isFinite(item.updatedAt)
        ? item.updatedAt
        : Date.now(),
  };
}

function getInitialChatAliases() {
  if (typeof window === "undefined") return [];

  try {
    const storedValue = window.localStorage.getItem(chatAliasMapStorageKey);
    const parsedValue = storedValue ? JSON.parse(storedValue) : [];
    return Array.isArray(parsedValue)
      ? parsedValue
          .map(normalizeChatAliasEntry)
          .filter((item): item is ChatAliasEntry => Boolean(item))
      : [];
  } catch {
    return [];
  }
}

function persistChatAliases(aliases: ChatAliasEntry[]) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(chatAliasMapStorageKey, JSON.stringify(aliases));
    window.dispatchEvent(new Event(chatAliasMapStorageEvent));
  } catch {
    // Alias settings are best-effort.
  }
}

function buildRecognitionSourceSummary(
  messages: TestMessage[],
  identities: TestIdentity[]
) {
  return messages
    .slice(-3)
    .map((message) => {
      const speaker =
        message.sender === "demo"
          ? "我"
          : identities.find((identity) => identity.id === message.identityId)
              ?.name ?? "对方";
      return `${speaker}：${message.text}`;
    })
    .join(" / ");
}

function getMessageSpeaker(message: TestMessage, identities: TestIdentity[]) {
  if (message.sender === "demo") return "我";
  return (
    identities.find((identity) => identity.id === message.identityId)?.name ??
    (message.conversationType === "group" ? "群成员" : "对方")
  );
}

function buildJudgeMessages(
  messages: TestMessage[],
  currentMessageId: string,
  identities: TestIdentity[]
): ArrangementJudgeMessage[] {
  return messages.map((message) => ({
    id: message.id,
    sender: getMessageSpeaker(message, identities),
    senderRole: message.sender === "demo" ? "me" : "other",
    text: message.text,
    sentAt: message.sentAt,
    isCurrent: message.id === currentMessageId,
  }));
}

function getRecallReasons(text: string, aliases: ChatAliasEntry[]) {
  const reasons: string[] = [];
  if (
    /(今天|今晚|明天|后天|周[一二三四五六日天]|星期[一二三四五六日天]|早上|上午|中午|下午|晚上|今晚|[0-2]?\\d[:：点时])/.test(
      text
    )
  ) {
    reasons.push("time-word");
  }
  if (/(去|约|见|一起|安排|记得|提醒|帮|带|买|拿|处理|开会|会议|可以吗|要不要|能不能)/.test(text)) {
    reasons.push("invitation-or-task-word");
  }
  if (/(~~|～～|那个|老样子|老地方|A计划|B计划|暗号|照旧)/i.test(text)) {
    reasons.push("abstract-symbol");
  }
  if (aliases.some((alias) => alias.alias && text.includes(alias.alias))) {
    reasons.push("known-alias");
  }
  if (/^(可以|行|好|好的|可以的|没问题|嗯|对|就这样|那就这样|ok|OK)$/i.test(text.trim())) {
    reasons.push("confirmation-reply");
  }
  return Array.from(new Set(reasons));
}

function buildCandidateWindow(
  conversationMessages: TestMessage[],
  currentMessage: TestMessage
) {
  const sortedMessages = [...conversationMessages].sort((a, b) => a.sentAt - b.sentAt);
  const currentIndex = sortedMessages.findIndex(
    (message) => message.id === currentMessage.id
  );
  if (currentIndex < 0) return [currentMessage];

  const start = Math.max(0, currentIndex - 5);
  const end = Math.min(sortedMessages.length, currentIndex + 6);
  let windowMessages = sortedMessages.slice(start, end);
  if (windowMessages.length > 10) {
    const currentInWindow = windowMessages.findIndex(
      (message) => message.id === currentMessage.id
    );
    const trimStart = Math.max(0, currentInWindow - 5);
    windowMessages = windowMessages.slice(trimStart, trimStart + 10);
  }
  return windowMessages;
}

function recallRecognitionCandidates(
  conversationMessages: TestMessage[],
  candidateMessages: TestMessage[],
  aliases: ChatAliasEntry[]
): RecalledRecognitionCandidate[] {
  return candidateMessages
    .map((message) => ({
      currentMessage: message,
      messages: buildCandidateWindow(conversationMessages, message),
      reasons: getRecallReasons(message.text, aliases),
    }))
    .filter((candidate) => candidate.reasons.length > 0);
}

function getLatestIdentityMessage(messages: TestMessage[], identityId: string) {
  return messages
    .filter((message) => message.identityId === identityId)
    .reduce<TestMessage | null>((latest, message) => {
      if (!latest || message.sentAt > latest.sentAt) return message;
      return latest;
    }, null);
}

function getLatestConversationMessage(messages: TestMessage[], conversationId: string) {
  return messages
    .filter((message) => message.conversationId === conversationId)
    .reduce<TestMessage | null>((latest, message) => {
      if (!latest || message.sentAt > latest.sentAt) return message;
      return latest;
    }, null);
}

export default function AdminMessageConsole() {
  const [identities, setIdentities] = React.useState(getInitialTestIdentities);
  const [groups, setGroups] = React.useState(getInitialTestGroups);
  const [messages, setMessages] = React.useState(getInitialTestMessages);
  const [activeIdentityId, setActiveIdentityId] = React.useState(
    () => getInitialTestIdentities()[0]?.id ?? ""
  );
  const [activeGroupId, setActiveGroupId] = React.useState(
    () => getInitialTestGroups()[0]?.id ?? ""
  );
  const [messageMode, setMessageMode] =
    React.useState<TestConversationType>(getInitialAdminMessageMode);
  const [showCreateIdentityModal, setShowCreateIdentityModal] = React.useState(false);
  const [showCreateGroupModal, setShowCreateGroupModal] = React.useState(false);
  const [showIdentityPicker, setShowIdentityPicker] = React.useState(false);
  const [showGroupPicker, setShowGroupPicker] = React.useState(false);
  const [showAdminInfo, setShowAdminInfo] = React.useState(false);
  const [identityName, setIdentityName] = React.useState("");
  const [identityNote, setIdentityNote] = React.useState("");
  const [groupName, setGroupName] = React.useState("");
  const [groupNote, setGroupNote] = React.useState("");
  const [messageText, setMessageText] = React.useState("");
  const [aiTestResult, setAiTestResult] = React.useState<AiTestResult>({
    status: "idle",
  });
  const [autoRecognitionStatus, setAutoRecognitionStatus] =
    React.useState<AutoRecognitionStatus>({ status: "idle" });
  const [chatArrangementConfirmations, setChatArrangementConfirmations] =
    React.useState(getInitialChatArrangementConfirmations);
  const [arrangementUpdateToast, setArrangementUpdateToast] =
    React.useState<ArrangementUpdateToast | null>(null);
  const [activeConversationIntents, setActiveConversationIntents] =
    React.useState(getInitialActiveConversationIntents);
  const [ambiguousArrangementUpdate, setAmbiguousArrangementUpdate] =
    React.useState<AmbiguousArrangementUpdate | null>(null);
  const [aliasCandidateConfirmation, setAliasCandidateConfirmation] =
    React.useState<AliasCandidateConfirmation | null>(null);
  const [chatAliases, setChatAliases] = React.useState(getInitialChatAliases);
  const [messageTextFocused, setMessageTextFocused] = React.useState(false);
  const messagesEndRef = React.useRef<HTMLDivElement>(null);
  const identityPickerRef = React.useRef<HTMLDivElement>(null);
  const groupPickerRef = React.useRef<HTMLDivElement>(null);
  const adminInfoRef = React.useRef<HTMLDivElement>(null);
  const arrangementUpdateUndoTimerRef = React.useRef<number | null>(null);

  const activeIdentity =
    identities.find((identity) => identity.id === activeIdentityId) ?? identities[0] ?? null;
  const activeGroup =
    groups.find((group) => group.id === activeGroupId) ?? groups[0] ?? null;
  const activeConversationId =
    messageMode === "group"
      ? activeGroup?.id ?? ""
      : activeIdentity
        ? getPrivateConversationId(activeIdentity.id)
        : "";
  const activeAliasCandidateConfirmation =
    aliasCandidateConfirmation?.conversationId === activeConversationId &&
    aliasCandidateConfirmation.conversationType === messageMode
      ? aliasCandidateConfirmation
      : null;
  const activeMessages = React.useMemo(
    () =>
      activeConversationId
        ? messages
            .filter((message) => message.conversationId === activeConversationId)
            .sort((a, b) => a.sentAt - b.sentAt)
        : [],
    [activeConversationId, messages]
  );
  const activeChatArrangementConfirmations = React.useMemo(
    () =>
      chatArrangementConfirmations
        .filter(
          (confirmation) =>
            confirmation.sourceConversationId === activeConversationId &&
            confirmation.sourceConversationType === messageMode
        )
        .sort((a, b) => a.createdAt - b.createdAt),
    [activeConversationId, chatArrangementConfirmations, messageMode]
  );
  const activeAliases = React.useMemo(
    () =>
      chatAliases
        .filter(
          (alias) =>
            alias.scope === "global" ||
            (alias.conversationId === activeConversationId &&
              alias.conversationType === messageMode)
        )
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [activeConversationId, chatAliases, messageMode]
  );
  const activeMessageKey = activeMessages.at(-1)?.id ?? "empty";
  const canSendMessage = Boolean(
    activeIdentity &&
      messageText.trim() &&
      (messageMode === "private" || activeGroup)
  );
  const sortedIdentities = React.useMemo(
    () =>
      [...identities].sort((a, b) => {
        const latestA = getLatestIdentityMessage(messages, a.id)?.sentAt ?? a.createdAt;
        const latestB = getLatestIdentityMessage(messages, b.id)?.sentAt ?? b.createdAt;
        return latestB - latestA;
      }),
    [identities, messages]
  );
  const sortedGroups = React.useMemo(
    () =>
      [...groups].sort((a, b) => {
        const latestA = getLatestConversationMessage(messages, a.id)?.sentAt ?? a.createdAt;
        const latestB = getLatestConversationMessage(messages, b.id)?.sentAt ?? b.createdAt;
        return latestB - latestA;
      }),
    [groups, messages]
  );

  React.useEffect(() => {
    if (activeIdentityId || identities.length === 0) return;
    setActiveIdentityId(identities[0].id);
  }, [activeIdentityId, identities]);

  React.useEffect(() => {
    if (activeGroupId || groups.length === 0) return;
    setActiveGroupId(groups[0].id);
  }, [activeGroupId, groups]);

  React.useEffect(() => {
    if (typeof window === "undefined") return;

    const refreshTestConversations = () => {
      const nextIdentities = getInitialTestIdentities();
      const nextGroups = getInitialTestGroups();
      setIdentities(nextIdentities);
      setGroups(nextGroups);
      setMessages(getInitialTestMessages());
      setActiveIdentityId((currentIdentityId) => {
        if (
          currentIdentityId &&
          nextIdentities.some((identity) => identity.id === currentIdentityId)
        ) {
          return currentIdentityId;
        }
        return nextIdentities[0]?.id ?? "";
      });
      setActiveGroupId((currentGroupId) => {
        if (
          currentGroupId &&
          nextGroups.some((group) => group.id === currentGroupId)
        ) {
          return currentGroupId;
        }
        return nextGroups[0]?.id ?? "";
      });
    };

    const refreshChatAliases = () => {
      setChatAliases(getInitialChatAliases());
    };

    const handleStorage = (event: StorageEvent) => {
      if (event.key === chatAliasMapStorageKey) {
        refreshChatAliases();
        return;
      }
      if (
        event.key !== testIdentitiesStorageKey &&
        event.key !== testGroupsStorageKey &&
        event.key !== testMessagesStorageKey
      ) {
        return;
      }
      refreshTestConversations();
    };

    window.addEventListener("storage", handleStorage);
    window.addEventListener(testConversationStorageEvent, refreshTestConversations);
    window.addEventListener(chatAliasMapStorageEvent, refreshChatAliases);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(testConversationStorageEvent, refreshTestConversations);
      window.removeEventListener(chatAliasMapStorageEvent, refreshChatAliases);
    };
  }, []);

  React.useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [activeMessageKey]);

  React.useEffect(
    () => () => {
      if (arrangementUpdateUndoTimerRef.current) {
        window.clearTimeout(arrangementUpdateUndoTimerRef.current);
      }
    },
    []
  );

  React.useEffect(() => {
    if (!showIdentityPicker) return;

    const closePickerOnOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        identityPickerRef.current?.contains(target)
      ) {
        return;
      }
      setShowIdentityPicker(false);
    };

    document.addEventListener("pointerdown", closePickerOnOutsidePointerDown);
    return () => {
      document.removeEventListener("pointerdown", closePickerOnOutsidePointerDown);
    };
  }, [showIdentityPicker]);

  React.useEffect(() => {
    if (!showGroupPicker) return;

    const closePickerOnOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && groupPickerRef.current?.contains(target)) {
        return;
      }
      setShowGroupPicker(false);
    };

    document.addEventListener("pointerdown", closePickerOnOutsidePointerDown);
    return () => {
      document.removeEventListener("pointerdown", closePickerOnOutsidePointerDown);
    };
  }, [showGroupPicker]);

  React.useEffect(() => {
    if (!showAdminInfo) return;

    const closeInfoOnOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && adminInfoRef.current?.contains(target)) {
        return;
      }
      setShowAdminInfo(false);
    };

    document.addEventListener("pointerdown", closeInfoOnOutsidePointerDown);
    return () => {
      document.removeEventListener("pointerdown", closeInfoOnOutsidePointerDown);
    };
  }, [showAdminInfo]);

  const handleCreateIdentity = () => {
    const normalizedName = identityName.trim();
    if (!normalizedName) return;

    setIdentities((prev) => {
      const nextIdentities = [
        ...prev,
        createTestIdentity(normalizedName, identityNote, prev.length),
      ];
      persistTestIdentities(nextIdentities);
      setActiveIdentityId(nextIdentities.at(-1)?.id ?? "");
      return nextIdentities;
    });
    setShowCreateIdentityModal(false);
    setShowIdentityPicker(false);
    setIdentityName("");
    setIdentityNote("");
  };

  const closeCreateIdentityModal = () => {
    setShowCreateIdentityModal(false);
    setIdentityName("");
    setIdentityNote("");
  };

  const handleCreateGroup = () => {
    const normalizedName = groupName.trim();
    if (!normalizedName) return;

    setGroups((prev) => {
      const nextGroups = [
        ...prev,
        createTestGroup(
          normalizedName,
          groupNote,
          identities.map((identity) => identity.id),
          prev.length
        ),
      ];
      persistTestGroups(nextGroups);
      setActiveGroupId(nextGroups.at(-1)?.id ?? "");
      setMessageMode("group");
      persistAdminMessageMode("group");
      return nextGroups;
    });
    setShowCreateGroupModal(false);
    setShowGroupPicker(false);
    setGroupName("");
    setGroupNote("");
  };

  const closeCreateGroupModal = () => {
    setShowCreateGroupModal(false);
    setGroupName("");
    setGroupNote("");
  };

  const handleSendMessage = () => {
    if (!activeIdentity || !messageText.trim()) return;
    if (messageMode === "group" && !activeGroup) return;

    const sendingMode = messageMode;
    setMessages((prev) => {
      const nextMessage =
        sendingMode === "group" && activeGroup
          ? createTestGroupMessage(activeGroup.id, activeIdentity.id, messageText)
          : createTestMessage(activeIdentity.id, messageText);
      const nextMessages = [
        ...prev,
        nextMessage,
      ];
      persistTestMessages(nextMessages);
      if (sendingMode === "private") {
        void recognizePrivateMessageArrangements(
          nextMessages,
          nextMessage.conversationId
        );
      } else if (activeGroup) {
        void recognizeGroupMessageArrangements(
          nextMessages,
          nextMessage.conversationId
        );
      }
      return nextMessages;
    });
    if (sendingMode === "private" || sendingMode === "group") {
      setAutoRecognitionStatus({
        status: "loading",
      });
    }
    setMessageText("");
  };

  const handleMessageKeyDown = (
    event: React.KeyboardEvent<HTMLTextAreaElement>
  ) => {
    if (event.key !== "Enter" || event.shiftKey) return;

    event.preventDefault();
    handleSendMessage();
  };

  const handleTestAiCall = async () => {
    setAiTestResult({ status: "loading" });

    try {
      const output = await callAiJson(aiTestPrompt);
      setAiTestResult({ status: "success", output });
    } catch (error) {
      setAiTestResult({
        status: "error",
        message: getAiTestErrorMessage(error),
      });
    }
  };

  const publishChatArrangementConfirmations = (
    confirmations: ChatArrangementConfirmation[]
  ) => {
    setChatArrangementConfirmations(confirmations);
    persistChatArrangementConfirmations(confirmations);
  };

  const queueChatArrangementConfirmations = (
    drafts: ArrangementDraftWithRecognitionMeta[],
    conversationId: string,
    conversationType: TestConversationType,
    sourceMessageIds: string[],
    sourceSummary: string
  ) => {
    const now = Date.now();
    const nextConfirmations = [
      ...chatArrangementConfirmations,
      ...drafts.map((draft, index) => ({
        ...draft,
        id: `chat-confirmation-${now}-${index}`,
        sourceConversationId: conversationId,
        sourceConversationType: conversationType,
        sourceMessageIds,
        sourceSummary,
        createdAt: now + index,
      })),
    ];
    publishChatArrangementConfirmations(nextConfirmations);
  };

  const removeChatArrangementConfirmation = (confirmationId: string) => {
    publishChatArrangementConfirmations(
      chatArrangementConfirmations.filter(
        (confirmation) => confirmation.id !== confirmationId
      )
    );
  };

  const confirmChatArrangement = (confirmation: ChatArrangementConfirmation) => {
    const now = Date.now();
    const locationName =
      confirmation.locationName.trim() || confirmation.locationText.trim();
    const sourceLabel =
      confirmation.source === "ai_group_chat"
        ? "AI 群聊识别"
        : confirmation.source === "rules"
          ? "规则识别"
          : "AI 私聊识别";
    const arrangement: ArrangementItem = {
      id: `admin-chat-arrangement-${now}`,
      title: confirmation.title.trim(),
      timeText: confirmation.timeText.trim(),
      dateKey: confirmation.dateKey,
      startTime: confirmation.startTime,
      endTime: confirmation.endTime,
      timeKind: confirmation.dateKey ? confirmation.timeKind : "none",
      peopleText: confirmation.peopleText.trim(),
      locationText: locationName,
      locationName,
      note: confirmation.note.trim(),
      source: sourceLabel,
      status: "pending",
      createdAt: now,
      pinned: false,
      contexts: confirmation.contexts,
      sourceConversationId: confirmation.sourceConversationId,
      sourceConversationType: confirmation.sourceConversationType,
      sourceMessageIds: confirmation.sourceMessageIds,
      sourceType: confirmation.sourceType,
      unknownAliasText: confirmation.unknownAliasText,
      suggestedAliasMeaning: confirmation.suggestedAliasMeaning,
      aliasLearningStatus: confirmation.suggestedAliasMeaning
        ? "confirmed"
        : confirmation.aliasLearningStatus,
    };
    const aliasText = confirmation.unknownAliasText?.trim() ?? "";
    const aliasMeaning = confirmation.suggestedAliasMeaning?.trim() ?? "";
    if (
      confirmation.sourceType === "unknown_alias_arrangement" &&
      aliasText &&
      aliasMeaning
    ) {
      const nextAlias: ChatAliasEntry = {
        id: `learned-alias-${now}`,
        conversationId: confirmation.sourceConversationId,
        conversationType: confirmation.sourceConversationType,
        alias: aliasText,
        meaning: aliasMeaning,
        scope: "conversation",
        sourceMessageIds: confirmation.sourceMessageIds,
        sourceSummary: confirmation.sourceSummary,
        createdAt: now,
        updatedAt: now,
      };
      const nextAliases = [
        nextAlias,
        ...getInitialChatAliases().filter(
          (item) =>
            !(
              item.conversationId === nextAlias.conversationId &&
              item.conversationType === nextAlias.conversationType &&
              item.alias === nextAlias.alias
            )
        ),
      ];
      setChatAliases(nextAliases);
      persistChatAliases(nextAliases);
    }
    appendArrangement(arrangement);
    rememberActiveConversationIntent(arrangement, confirmation.sourceMessageIds);
    removeChatArrangementConfirmation(confirmation.id);
    setAutoRecognitionStatus({
      status: "success",
      message: "已添加到安排。",
    });
  };

  const confirmAliasCandidate = (confirmation: AliasCandidateConfirmation) => {
    const now = Date.now();
    const aliasText = confirmation.aliasText.trim();
    const aliasMeaning = confirmation.aliasMeaning.trim();
    if (!aliasText || !aliasMeaning) return;

    const nextAlias: ChatAliasEntry = {
      id: `learned-alias-${now}`,
      conversationId: confirmation.conversationId,
      conversationType: confirmation.conversationType,
      alias: aliasText,
      meaning: aliasMeaning,
      scope: "conversation",
      sourceMessageIds: confirmation.sourceMessageIds,
      sourceSummary: confirmation.sourceSummary,
      createdAt: now,
      updatedAt: now,
    };
    const nextAliases = [
      nextAlias,
      ...getInitialChatAliases().filter(
        (item) =>
          !(
            item.conversationId === nextAlias.conversationId &&
            item.conversationType === nextAlias.conversationType &&
            item.alias === nextAlias.alias
          )
      ),
    ];
    setChatAliases(nextAliases);
    persistChatAliases(nextAliases);
    setAliasCandidateConfirmation(null);
    setAutoRecognitionStatus({
      status: "success",
      message: "已将 AI 猜测的暗语写入 App 暗语设置。",
    });
  };

  const buildJudgeInputFromCandidate = (
    candidate: RecalledRecognitionCandidate,
    conversationType: TestConversationType,
    conversationId: string
  ): ArrangementJudgeInput => {
    const activeIntent =
      activeConversationIntents.find(
        (intent) =>
          intent.conversationId === conversationId &&
          intent.conversationType === conversationType
      ) ?? null;
    const judgeMessages = buildJudgeMessages(
      candidate.messages,
      candidate.currentMessage.id,
      identities
    );
    const currentMessage =
      judgeMessages.find((message) => message.isCurrent) ?? judgeMessages.at(-1);

    return {
      conversationType,
      currentMessage: currentMessage ?? {
        id: candidate.currentMessage.id,
        sender: getMessageSpeaker(candidate.currentMessage, identities),
        senderRole: candidate.currentMessage.sender === "demo" ? "me" : "other",
        text: candidate.currentMessage.text,
        sentAt: candidate.currentMessage.sentAt,
        isCurrent: true,
      },
      messages: judgeMessages,
      existingArrangements: getInitialArrangements().filter(
        (item) => item.status !== "completed"
      ),
      knownAliases: activeAliases.map((alias) => ({
        alias: alias.alias,
        meaning: alias.meaning,
        scope: alias.scope,
      })),
      activeConversationIntent: activeIntent
        ? {
            arrangementId: activeIntent.arrangementId,
            topic: activeIntent.topic,
            participantIds: activeIntent.participantIds,
            sourceMessageIds: activeIntent.sourceMessageIds,
          }
        : null,
      recallReasons: candidate.reasons,
    };
  };

  const buildConfirmationDraftFromJudgeAction = (
    action: ArrangementJudgeAction,
    candidate: RecalledRecognitionCandidate,
    conversationType: TestConversationType,
    sourceSummary: string
  ): ArrangementDraftWithRecognitionMeta | null => {
    if (!action.draft) return null;
    const isUnknownAlias = action.type === "unknown_symbol_arrangement";

    return {
      ...action.draft,
      confidence: action.confidence,
      contexts: Array.from(
        new Set([
          ...(action.draft.contexts ?? []),
          `AI 判断：${action.reason}`,
          `规则召回：${candidate.reasons.join("、")}`,
        ])
      ),
      source: conversationType === "group" ? "ai_group_chat" : "ai",
      sourceType: isUnknownAlias ? "unknown_alias_arrangement" : undefined,
      unknownAliasText: isUnknownAlias ? action.aliasText : undefined,
      suggestedAliasMeaning: isUnknownAlias ? action.aliasMeaning : undefined,
      aliasLearningStatus:
        isUnknownAlias && action.aliasMeaning ? "suggested" : undefined,
      aiActionType: isUnknownAlias ? "unknown_symbol_arrangement" : "new_arrangement",
      aiReason: action.reason,
      candidateReason: candidate.reasons.join("、"),
      candidateArrangementIds: action.candidateArrangementIds,
      note: action.draft.note || sourceSummary,
    };
  };

  const handleJudgeAction = (
    action: ArrangementJudgeAction,
    candidate: RecalledRecognitionCandidate,
    conversationId: string,
    conversationType: TestConversationType,
    sourceMessageIds: string[],
    sourceSummary: string
  ) => {
    const candidateArrangements = getInitialArrangements().filter(
      (item) => item.status !== "completed"
    );
    const scoredCandidates = scoreArrangementCandidates(
      candidateArrangements,
      conversationId,
      conversationType,
      candidate.messages.map((message) => message.text).join("\n"),
      candidate.messages
    );

    if (action.type === "update_existing" && action.update) {
      const didQueueUpdate = resolveArrangementUpdate(
        {
          ...action.update,
          confidence: action.confidence,
          reason: action.reason,
        },
        scoredCandidates,
        sourceMessageIds,
        conversationType
      );
      return didQueueUpdate;
    }

    if (action.type === "alias_candidate") {
      const aliasText = action.aliasText?.trim() ?? "";
      const aliasMeaning = action.aliasMeaning?.trim() ?? "";
      if (!aliasText || !aliasMeaning) return false;

      setAliasCandidateConfirmation({
        id: `alias-candidate-${Date.now()}`,
        conversationId,
        conversationType,
        aliasText,
        aliasMeaning,
        confidence: action.confidence,
        reason: action.reason,
        sourceMessageIds,
        sourceSummary,
      });
      setAutoRecognitionStatus({
        status: "info",
        message: "AI 猜测到一个暗语含义，请先确认是否写入暗语设置。",
      });
      return true;
    }

    if (
      action.type === "new_arrangement" ||
      action.type === "unknown_symbol_arrangement"
    ) {
      const draft = buildConfirmationDraftFromJudgeAction(
        action,
        candidate,
        conversationType,
        sourceSummary
      );
      if (!draft) return false;
      queueChatArrangementConfirmations(
        [draft],
        conversationId,
        conversationType,
        sourceMessageIds,
        sourceSummary
      );
      return true;
    }

    return false;
  };

  const publishActiveConversationIntents = (
    intents: ActiveConversationIntent[]
  ) => {
    setActiveConversationIntents(intents);
    persistActiveConversationIntents(intents);
  };

  const rememberActiveConversationIntent = (
    arrangement: ArrangementItem,
    sourceMessageIds: string[]
  ) => {
    if (!arrangement.sourceConversationId || !arrangement.sourceConversationType) {
      return;
    }

    const nextIntent: ActiveConversationIntent = {
      conversationId: arrangement.sourceConversationId,
      conversationType: arrangement.sourceConversationType,
      arrangementId: arrangement.id,
      topic: [
        arrangement.title,
        arrangement.locationName || arrangement.locationText,
        arrangement.note,
      ]
        .filter(Boolean)
        .join(" "),
      participantIds: arrangement.peopleText
        .split(/[，,、\s]/)
        .map((item) => item.trim())
        .filter(Boolean),
      sourceMessageIds,
      updatedAt: Date.now(),
    };
    const nextIntents = [
      nextIntent,
      ...activeConversationIntents.filter(
        (intent) =>
          !(
            intent.conversationId === nextIntent.conversationId &&
            intent.conversationType === nextIntent.conversationType
          )
      ),
    ].slice(0, 12);
    publishActiveConversationIntents(nextIntents);
  };

  const publishArrangements = (items: ArrangementItem[]) => {
    persistArrangements(items);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event(arrangementStorageEvent));
    }
  };

  const undoArrangementUpdate = (previousItems: ArrangementItem[]) => {
    const previousMap = new Map(previousItems.map((item) => [item.id, item]));
    const restoredItems = getInitialArrangements().map((item) =>
      previousMap.get(item.id) ?? item
    );
    publishArrangements(restoredItems);
    setArrangementUpdateToast(null);
    if (arrangementUpdateUndoTimerRef.current) {
      window.clearTimeout(arrangementUpdateUndoTimerRef.current);
      arrangementUpdateUndoTimerRef.current = null;
    }
    setAutoRecognitionStatus({
      status: "info",
      message: "已撤销本次自动补全。",
    });
  };

  const applyArrangementUpdates = (
    updates: ArrangementUpdatePatch[],
    sourceMessageIds: string[]
  ) => {
    if (!Array.isArray(updates) || updates.length === 0) return false;

    const currentArrangements = getInitialArrangements();
    const previousItems = currentArrangements.filter((item) =>
      updates.some((update) => update.arrangementId === item.id)
    );
    if (previousItems.length === 0) return false;

    const updateMap = new Map(updates.map((update) => [update.arrangementId, update]));
    const nextArrangements = currentArrangements.map((item) => {
      const update = updateMap.get(item.id);
      if (!update) return item;
      const locationName =
        update.locationName?.trim() ||
        update.locationText?.trim() ||
        item.locationName;
      const noteAppend = update.noteAppend?.trim();
      const nextContexts = [...(item.contexts ?? []), update.context].filter(Boolean);
      const nextSourceMessageIds = [
        ...(item.sourceMessageIds ?? []),
        ...sourceMessageIds,
      ];

      return {
        ...item,
        timeText: update.timeText?.trim() || item.timeText,
        dateKey: update.dateKey?.trim() || item.dateKey,
        startTime: update.startTime?.trim() || item.startTime,
        endTime: update.endTime?.trim() || item.endTime,
        timeKind:
          update.timeKind && update.timeKind !== "none"
            ? update.timeKind
            : item.timeKind,
        peopleText: update.peopleText?.trim() || item.peopleText,
        locationText: locationName,
        locationName,
        note: noteAppend
          ? item.note
            ? `${item.note}\n${noteAppend}`
            : noteAppend
          : item.note,
        contexts: Array.from(new Set(nextContexts)),
        sourceMessageIds: Array.from(new Set(nextSourceMessageIds)),
      };
    });

    publishArrangements(nextArrangements);
    setArrangementUpdateToast({
      itemTitle: previousItems[0]?.title ?? "安排",
      previousItems,
    });
    if (arrangementUpdateUndoTimerRef.current) {
      window.clearTimeout(arrangementUpdateUndoTimerRef.current);
    }
    arrangementUpdateUndoTimerRef.current = window.setTimeout(() => {
      setArrangementUpdateToast(null);
      arrangementUpdateUndoTimerRef.current = null;
    }, arrangementUpdateUndoMs);
    return true;
  };

  const scoreArrangementCandidates = (
    arrangements: ArrangementItem[],
    conversationId: string,
    conversationType: TestConversationType,
    contextText: string,
    latestMessages: TestMessage[]
  ): ScoredArrangementCandidate[] => {
    const activeIntent = activeConversationIntents.find(
      (intent) =>
        intent.conversationId === conversationId &&
        intent.conversationType === conversationType
    );
    const normalizedContext = contextText.toLowerCase();
    const latestText = latestMessages.at(-1)?.text.trim() ?? "";
    const isShortReply =
      /^(可以|行|好|好的|可以的|那就这样|8点|八点)$/i.test(
        latestText
      ) ||
      /(几点|怎么说)$/.test(latestText) ||
      latestText.length <= 4;

    return arrangements
      .map<ScoredArrangementCandidate>((arrangement) => {
        let score = 0;
        const reasons: string[] = [];

        if (
          arrangement.sourceConversationId === conversationId &&
          arrangement.sourceConversationType === conversationType
        ) {
          score += 0.3;
          reasons.push("same-conversation");
        }

        if (activeIntent?.arrangementId === arrangement.id) {
          score += isShortReply ? 0.42 : 0.28;
          reasons.push("active-intent");
        }

        const topicTokens = [
          arrangement.title,
          arrangement.locationName,
          arrangement.locationText,
          arrangement.note,
          activeIntent?.arrangementId === arrangement.id ? activeIntent.topic : "",
        ]
          .join(" ")
          .split(/[，。；、\s]/)
          .map((item) => item.trim().toLowerCase())
          .filter((item) => item.length >= 2);
        const matchedTopicCount = topicTokens.filter((token) =>
          normalizedContext.includes(token)
        ).length;
        if (matchedTopicCount > 0) {
          score += Math.min(0.24, matchedTopicCount * 0.08);
          reasons.push("topic");
        }

        const peopleTokens = arrangement.peopleText
          .split(/[，,、\s]/)
          .map((item) => item.trim().toLowerCase())
          .filter((item) => item.length >= 2);
        if (peopleTokens.some((token) => normalizedContext.includes(token))) {
          score += 0.12;
          reasons.push("people");
        }

        const lastArrangementMessageAt = latestMessages.some((message) =>
          arrangement.sourceMessageIds?.includes(message.id)
        );
        if (lastArrangementMessageAt) {
          score += 0.08;
          reasons.push("source-message");
        }

        const messageDistanceMs =
          latestMessages.at(-1)?.sentAt && arrangement.createdAt
            ? Math.abs((latestMessages.at(-1)?.sentAt ?? 0) - arrangement.createdAt)
            : Number.POSITIVE_INFINITY;
        if (messageDistanceMs < 1000 * 60 * 60 * 6) {
          score += 0.08;
          reasons.push("time-distance");
        }

        if (isShortReply && activeIntent?.arrangementId !== arrangement.id) {
          score -= 0.18;
          reasons.push("short-reply-penalty");
        }

        return {
          arrangement,
          score: Math.max(0, Math.min(1, score)),
          reasons,
        };
      })
      .sort((a, b) => b.score - a.score);
  };

  const resolveArrangementUpdate = (
    update: ArrangementUpdatePatch,
    candidates: ScoredArrangementCandidate[],
    sourceMessageIds: string[],
    conversationType: TestConversationType
  ) => {
    const aiSelectedCandidate =
      candidates.find((candidate) => candidate.arrangement.id === update.arrangementId) ??
      candidates[0];
    const topCandidate = candidates[0];
    const selectedCandidate =
      topCandidate && aiSelectedCandidate && topCandidate.score - aiSelectedCandidate.score > 0.2
        ? topCandidate
        : aiSelectedCandidate;
    if (!selectedCandidate) return false;

    const secondCandidate = candidates.find(
      (candidate) => candidate.arrangement.id !== selectedCandidate.arrangement.id
    );
    const effectiveConfidence = Math.min(
      1,
      update.confidence * 0.6 + selectedCandidate.score * 0.5
    );

    const hasSimilarCandidate =
      secondCandidate &&
      Math.abs(selectedCandidate.score - secondCandidate.score) <=
        ambiguousUpdateGapThreshold;
    setAmbiguousArrangementUpdate({
      patch: {
        ...update,
        arrangementId: selectedCandidate.arrangement.id,
        confidence: effectiveConfidence,
      },
      candidates: hasSimilarCandidate ? candidates.slice(0, 3) : [selectedCandidate],
      sourceMessageIds,
      conversationType,
      aiReason: update.reason,
    });
    setAutoRecognitionStatus({
      status: "info",
      message: hasSimilarCandidate
        ? "AI 找到多个可能相关的事项，请先选择要更新哪一个。"
        : "这条消息可能在补充已有事项，请先确认。",
    });
    return true;
  };

  const confirmAmbiguousArrangementUpdate = (arrangementId: string) => {
    if (!ambiguousArrangementUpdate) return;

    const target = ambiguousArrangementUpdate.candidates.find(
      (candidate) => candidate.arrangement.id === arrangementId
    );
    if (!target) return;

    const didUpdate = applyArrangementUpdates(
      [
        {
          ...ambiguousArrangementUpdate.patch,
          arrangementId,
          confidence: Math.max(
            ambiguousArrangementUpdate.patch.confidence,
            target.score
          ),
        },
      ],
      ambiguousArrangementUpdate.sourceMessageIds
    );
    if (didUpdate) {
      rememberActiveConversationIntent(
        target.arrangement,
        ambiguousArrangementUpdate.sourceMessageIds
      );
      if (ambiguousArrangementUpdate.conversationType === "group") {
        markGroupRecognitionMessagesPushed(
          ambiguousArrangementUpdate.sourceMessageIds
        );
      } else {
        markPrivateRecognitionMessagesPushed(
          ambiguousArrangementUpdate.sourceMessageIds
        );
      }
      setAmbiguousArrangementUpdate(null);
      setAutoRecognitionStatus({
        status: "success",
        message: "已按选择更新事项安排。",
      });
    }
  };

  const createNewFromAmbiguousUpdate = () => {
    if (!ambiguousArrangementUpdate) return;

    const patch = ambiguousArrangementUpdate.patch;
    const now = Date.now();
    const title = patch.noteAppend || patch.context.split("\n").at(-1) || "新的事项安排";
    const locationName = patch.locationName?.trim() || patch.locationText?.trim() || "";
    const arrangement: ArrangementItem = {
      id: `admin-chat-arrangement-${now}`,
      title,
      timeText: patch.timeText?.trim() || "",
      dateKey: patch.dateKey?.trim() || "",
      startTime: patch.startTime?.trim() || "",
      endTime: patch.endTime?.trim() || "",
      timeKind: patch.dateKey ? patch.timeKind ?? "none" : "none",
      peopleText: patch.peopleText?.trim() || "",
      locationText: locationName,
      locationName,
      note: patch.noteAppend?.trim() || "",
      source: "来自聊天确认",
      status: "pending",
      createdAt: now,
      pinned: false,
      contexts: [patch.context],
      sourceMessageIds: ambiguousArrangementUpdate.sourceMessageIds,
    };
    appendArrangement(arrangement);
    if (ambiguousArrangementUpdate.conversationType === "group") {
      markGroupRecognitionMessagesPushed(ambiguousArrangementUpdate.sourceMessageIds);
    } else {
      markPrivateRecognitionMessagesPushed(
        ambiguousArrangementUpdate.sourceMessageIds
      );
    }
    setAmbiguousArrangementUpdate(null);
    setAutoRecognitionStatus({
      status: "success",
      message: "已新建事项安排。",
    });
  };

  const recognizePrivateMessageArrangements = async (
    nextMessages: TestMessage[],
    conversationId: string
  ) => {
    const pushedMessageIds = new Set(getPushedPrivateRecognitionMessageIds());
    const recognitionMessages = nextMessages
      .filter(
        (message) =>
          message.conversationId === conversationId &&
          message.conversationType === "private" &&
          message.sender === "identity" &&
          isTodayTimestamp(message.sentAt) &&
          !pushedMessageIds.has(message.id)
      )
      .sort((a, b) => a.sentAt - b.sentAt)
      .slice(-8);

    if (recognitionMessages.length === 0) {
      setAutoRecognitionStatus({
        status: "info",
        message: "今天没有新的未推送私聊内容需要识别。",
      });
      return;
    }

    const conversationMessages = nextMessages.filter(
      (message) =>
        message.conversationId === conversationId &&
        message.conversationType === "private"
    );
    const candidates = recallRecognitionCandidates(
      conversationMessages,
      recognitionMessages,
      activeAliases
    );

    if (candidates.length === 0) {
      setAutoRecognitionStatus({
        status: "info",
        message: "本地规则没有召回候选消息，未提交给 AI 做最终判断。",
      });
      return;
    }

    let handledCount = 0;
    const judgedMessageIds: string[] = [];
    for (const candidate of candidates) {
      const result = await judgeArrangementIntentFromChat(
        buildJudgeInputFromCandidate(candidate, "private", conversationId)
      );
      const sourceMessageIds = candidate.messages.map((message) => message.id);
      const sourceSummary = buildRecognitionSourceSummary(
        candidate.messages,
        identities
      );

      if (result.status === "not_configured" || result.status === "failed") {
        setAutoRecognitionStatus({ status: "info", message: result.message });
        return;
      }

      for (const action of result.actions) {
        if (
          handleJudgeAction(
            action,
            candidate,
            conversationId,
            "private",
            sourceMessageIds,
            sourceSummary
          )
        ) {
          handledCount += 1;
        }
      }
      judgedMessageIds.push(candidate.currentMessage.id);
    }

    markPrivateRecognitionMessagesPushed(judgedMessageIds);
    setAutoRecognitionStatus({
      status: handledCount > 0 ? "success" : "info",
      message:
        handledCount > 0
          ? `已识别到 ${handledCount} 条需要确认的结果。`
          : "AI 判断候选消息无需创建、更新安排或学习暗语。",
    });
  };

  const recognizeGroupMessageArrangements = async (
    nextMessages: TestMessage[],
    conversationId: string
  ) => {
    const pushedMessageIds = new Set(getPushedGroupRecognitionMessageIds());
    const recognitionMessages = nextMessages
      .filter(
        (message) =>
          message.conversationId === conversationId &&
          message.conversationType === "group" &&
          isTodayTimestamp(message.sentAt) &&
          !pushedMessageIds.has(message.id)
      )
      .sort((a, b) => a.sentAt - b.sentAt)
      .slice(-12);

    if (recognitionMessages.length === 0) {
      setAutoRecognitionStatus({
        status: "info",
        message: "今天没有新的未推送群聊内容需要识别。",
      });
      return;
    }

    const conversationMessages = nextMessages.filter(
      (message) =>
        message.conversationId === conversationId &&
        message.conversationType === "group"
    );
    const candidates = recallRecognitionCandidates(
      conversationMessages,
      recognitionMessages,
      activeAliases
    );

    if (candidates.length === 0) {
      setAutoRecognitionStatus({
        status: "info",
        message: "本地规则没有召回群聊候选消息，未提交给 AI 做最终判断。",
      });
      return;
    }

    let handledCount = 0;
    const judgedMessageIds: string[] = [];
    for (const candidate of candidates) {
      const result = await judgeArrangementIntentFromChat(
        buildJudgeInputFromCandidate(candidate, "group", conversationId)
      );
      const sourceMessageIds = candidate.messages.map((message) => message.id);
      const sourceSummary = buildRecognitionSourceSummary(
        candidate.messages,
        identities
      );

      if (result.status === "not_configured" || result.status === "failed") {
        setAutoRecognitionStatus({ status: "info", message: result.message });
        return;
      }

      for (const action of result.actions) {
        if (
          handleJudgeAction(
            action,
            candidate,
            conversationId,
            "group",
            sourceMessageIds,
            sourceSummary
          )
        ) {
          handledCount += 1;
        }
      }
      judgedMessageIds.push(candidate.currentMessage.id);
    }

    markGroupRecognitionMessagesPushed(judgedMessageIds);
    setAutoRecognitionStatus({
      status: handledCount > 0 ? "success" : "info",
      message:
        handledCount > 0
          ? `已识别到 ${handledCount} 条群聊结果，请先确认。`
          : "AI 判断群聊候选消息无需创建、更新安排或学习暗语。",
    });
  };

  return (
    <div
      className="flex h-[calc(100vh-48px)] w-full self-stretch flex-col overflow-hidden bg-[var(--admin-bg)] text-text"
    >
      <main className="mx-auto flex min-h-0 w-full max-w-[600px] flex-1 px-4 py-4 sm:px-0">
        <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[16px] border border-[var(--admin-border)] bg-[var(--admin-panel-bg)] [box-shadow:var(--admin-panel-shadow)]">
          <div className="flex min-h-[52px] shrink-0 items-center justify-between gap-4 border-b border-[var(--admin-border-subtle)] px-5 py-3">
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="truncate text-[17px] font-normal leading-6 text-text">
                发给移动端 Demo
              </h2>
              <div ref={adminInfoRef} className="relative shrink-0">
                <button
                  type="button"
                  className="flex h-5 w-5 items-center justify-center rounded-full border border-[var(--admin-border)] text-[12px] font-medium leading-none text-text-tertiary transition hover:border-primary hover:text-primary focus:outline-none focus-visible:[box-shadow:var(--admin-input-focus-shadow)]"
                  onClick={() => setShowAdminInfo((open) => !open)}
                  aria-label="查看消息测试说明"
                  aria-expanded={showAdminInfo}
                >
                  i
                </button>
                {showAdminInfo && (
                  <div className="absolute left-0 top-7 z-30 w-[260px] rounded-[12px] border border-[var(--admin-border)] bg-[var(--admin-dialog-bg)] px-3 py-2.5 text-[12px] leading-5 text-text-muted [box-shadow:var(--admin-floating-shadow)]">
                    在此后台可以向移动端 Demo 发消息，方便测试那边的消息接收、AI 对消息上下文的处理等。
                  </div>
                )}
              </div>
            </div>
            <a
              href="/"
              target="_blank"
              rel="noreferrer"
              className="shrink-0 text-[13px] leading-5 text-text-tertiary underline decoration-[var(--admin-border)] underline-offset-4 transition hover:text-primary hover:decoration-primary focus:outline-none focus-visible:[box-shadow:var(--admin-input-focus-shadow)]"
            >
              打开移动端 Demo ↗
            </a>
          </div>

          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-[var(--admin-border-subtle)] px-5 py-3">
            <div className="inline-flex rounded-[10px] bg-[var(--admin-panel-muted-bg)] p-1">
              {(["private", "group"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={cn(
                    "h-8 rounded-[8px] px-3 text-[13px] transition focus:outline-none focus-visible:[box-shadow:var(--admin-input-focus-shadow)]",
                    messageMode === mode
                      ? "bg-[var(--admin-dialog-bg)] text-text [box-shadow:var(--shadow-sm)]"
                      : "text-text-tertiary hover:text-text"
                  )}
                  onClick={() => {
                    setMessageMode(mode);
                    persistAdminMessageMode(mode);
                    setShowGroupPicker(false);
                    setShowIdentityPicker(false);
                  }}
                >
                  {mode === "private" ? "私聊" : "群聊"}
                </button>
              ))}
            </div>
            {messageMode === "group" && (
              <div ref={groupPickerRef} className="relative min-w-0">
                <button
                  type="button"
                  className="inline-flex max-w-[260px] items-center rounded-[10px] border border-[var(--admin-border)] bg-[var(--admin-input-bg)] px-3 py-2 text-[12px] leading-4 text-text-tertiary transition hover:border-primary hover:bg-[var(--admin-input-hover-bg)] hover:text-text focus:outline-none focus-visible:[box-shadow:var(--admin-input-focus-shadow)]"
                  onClick={() => {
                    setShowGroupPicker((open) => !open);
                    setShowIdentityPicker(false);
                  }}
                  aria-expanded={showGroupPicker}
                >
                  <span className="mr-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />
                  <span className="truncate">
                    发到 {activeGroup?.name ?? "选择群聊"}
                  </span>
                  <span className="ml-1 shrink-0 text-[14px] leading-none">⌄</span>
                </button>
                {showGroupPicker && (
                  <GroupPickerDropdown
                    align="right"
                    groups={sortedGroups}
                    messages={messages}
                    activeGroup={activeGroup}
                    onSelect={(groupId) => {
                      setActiveGroupId(groupId);
                      setShowGroupPicker(false);
                    }}
                    onCreate={() => {
                      setShowGroupPicker(false);
                      setShowCreateGroupModal(true);
                    }}
                  />
                )}
              </div>
            )}
            {activeAliases.length > 0 && (
              <span className="inline-flex items-center rounded-[10px] border border-[var(--admin-border)] bg-[var(--admin-input-bg)] px-3 py-2 text-[12px] leading-4 text-text-tertiary">
                App 暗语 {activeAliases.length}
              </span>
            )}
          </div>

          {ambiguousArrangementUpdate && (
            <div className="shrink-0 border-b border-[var(--admin-border-subtle)] bg-[var(--admin-panel-bg)] px-5 py-3">
              <AmbiguousArrangementUpdatePanel
                update={ambiguousArrangementUpdate}
                onChoose={confirmAmbiguousArrangementUpdate}
                onCreateNew={createNewFromAmbiguousUpdate}
                onIgnore={() => setAmbiguousArrangementUpdate(null)}
              />
            </div>
          )}

          {activeChatArrangementConfirmations.length > 0 && (
            <div className="shrink-0 border-b border-[var(--admin-border-subtle)] bg-[var(--admin-panel-bg)] px-5 py-3">
              <ChatArrangementConfirmationCard
                confirmation={activeChatArrangementConfirmations[0]}
                queueCount={activeChatArrangementConfirmations.length}
                onConfirm={confirmChatArrangement}
                onIgnore={removeChatArrangementConfirmation}
              />
            </div>
          )}

          {activeAliasCandidateConfirmation && (
            <div className="shrink-0 border-b border-[var(--admin-border-subtle)] bg-[var(--admin-panel-bg)] px-5 py-3">
              <AliasCandidateConfirmationCard
                confirmation={activeAliasCandidateConfirmation}
                onConfirm={confirmAliasCandidate}
                onIgnore={() => setAliasCandidateConfirmation(null)}
              />
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-4">
            <div className="mx-auto flex min-h-full w-full flex-col">
              {activeMessages.length > 0 ? (
                <AdminConversationMessages
                  identity={activeIdentity}
                  identities={identities}
                  mode={messageMode}
                  messages={activeMessages}
                />
              ) : (
                <div className="flex flex-1 items-center justify-center px-4 text-center">
                  <div>
                    <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-fill-4 text-[18px] text-text-tertiary">
                      +
                    </div>
                    <p className="mt-3 text-[14px] leading-5 text-text-muted">
                      暂无发送记录
                    </p>
                    <p className="mt-1 text-[12px] leading-5 text-text-tertiary">
                      {messageMode === "group"
                        ? "选择群聊和发送身份后，从下方输入框发送第一条群聊测试消息。"
                        : "选择或创建身份后，从下方输入框发送第一条私聊测试消息。"}
                    </p>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          </div>

          <div className="shrink-0 bg-[var(--admin-panel-bg)] px-5 pb-4 pt-3">
            <ArrangementUpdateToastPanel
              toast={arrangementUpdateToast}
              onUndo={undoArrangementUpdate}
            />
            <AutoRecognitionStatusPanel status={autoRecognitionStatus} />
            <AiTestResultPanel result={aiTestResult} />
            {activeIdentity ? (
              <div
                className="admin-message-input-shell mx-auto w-full rounded-[14px] border bg-[var(--admin-input-bg)] transition hover:bg-[var(--admin-input-hover-bg)]"
                style={{
                  borderColor: messageTextFocused
                    ? "var(--primary)"
                    : "var(--admin-border)",
                  boxShadow: messageTextFocused
                    ? "var(--admin-input-focus-shadow)"
                    : undefined,
                }}
              >
                <textarea
                  value={messageText}
                  onChange={(event) => setMessageText(event.target.value)}
                  onKeyDown={handleMessageKeyDown}
                  onFocus={() => setMessageTextFocused(true)}
                  onBlur={() => setMessageTextFocused(false)}
                  placeholder=""
                  className="admin-message-textarea block min-h-[78px] w-full resize-none rounded-t-[14px] border-0 bg-transparent px-4 py-3 text-[15px] leading-[1.55] text-text outline-none placeholder:text-input-placeholder focus-visible:shadow-none"
                  rows={3}
                />
                <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 pb-3">
                  <div className="flex min-w-0 flex-1 items-center gap-1.5">
                    <div ref={identityPickerRef} className="relative min-w-0">
                      <button
                        type="button"
                        className="inline-flex max-w-full items-center rounded-full px-2 py-1 text-[12px] leading-4 text-text-tertiary transition hover:bg-hover-overlay focus:outline-none focus-visible:[box-shadow:var(--admin-input-focus-shadow)]"
                        onClick={() => {
                          setShowIdentityPicker((open) => !open);
                          setShowGroupPicker(false);
                        }}
                        aria-expanded={showIdentityPicker}
                      >
                        <span className="mr-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />
                        <span className="truncate">以 {activeIdentity.name} 的身份发送</span>
                        <span className="ml-1 shrink-0 text-[14px] leading-none">⌄</span>
                      </button>
                      {showIdentityPicker && (
                        <IdentityPickerDropdown
                          identities={sortedIdentities}
                          messages={messages}
                          activeIdentity={activeIdentity}
                          onSelect={(identityId) => {
                            setActiveIdentityId(identityId);
                            setShowIdentityPicker(false);
                          }}
                          onCreate={() => {
                            setShowIdentityPicker(false);
                            setShowCreateIdentityModal(true);
                          }}
                        />
                      )}
                    </div>
                  </div>
                  <div className="ml-auto flex shrink-0 items-center gap-3">
                    <button
                      type="button"
                      className="h-8 rounded-[8px] border border-[var(--admin-border)] px-3 text-[12px] font-medium text-text transition hover:border-primary hover:text-primary active:scale-[0.98] disabled:cursor-wait disabled:opacity-50 focus:outline-none focus-visible:[box-shadow:var(--admin-input-focus-shadow)]"
                      onClick={handleTestAiCall}
                      disabled={aiTestResult.status === "loading"}
                    >
                      {aiTestResult.status === "loading"
                        ? "测试中..."
                        : "测试 AI 调用"}
                    </button>
                    <span className="text-[12px] leading-5 text-text-tertiary">
                      Enter发送 / Shift+Enter换行
                    </span>
                    <button
                      type="button"
                      className="flex h-9 w-9 items-center justify-center rounded-full bg-text text-bg transition hover:opacity-[0.88] active:scale-[0.92] disabled:cursor-not-allowed disabled:opacity-35 focus:outline-none focus-visible:[box-shadow:var(--admin-input-focus-shadow)]"
                      onClick={handleSendMessage}
                      disabled={!canSendMessage}
                      aria-label="发送消息"
                    >
                      <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <path
                          d="M4.7 12.5 18.8 5.6c.7-.35 1.42.34 1.08 1.05l-6.7 14.2c-.31.66-1.27.55-1.42-.16l-1.18-5.66a1.3 1.3 0 0 0-1.02-1.01l-4.7-.92c-.76-.15-.88-1.16-.16-1.5Z"
                          fill="currentColor"
                        />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex min-h-[176px] items-center justify-center rounded-[12px] bg-[var(--admin-panel-muted-bg)] text-sm text-text-tertiary">
                请先在上方创建一个发送身份。
              </div>
            )}
          </div>
        </section>
      </main>
      {showCreateIdentityModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
          <button
            type="button"
            className="absolute inset-0 bg-[var(--admin-overlay)] backdrop-blur-[2px]"
            onClick={closeCreateIdentityModal}
            aria-label="关闭新增身份弹窗"
          />
          <form
            className="relative z-10 w-full max-w-[420px] rounded-[14px] border border-[var(--admin-border)] bg-[var(--admin-dialog-bg)] p-5 text-text [box-shadow:var(--admin-floating-shadow)]"
            onSubmit={(event) => {
              event.preventDefault();
              handleCreateIdentity();
            }}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">新增身份</h2>
              <button
                type="button"
                className="rounded-[8px] px-2 py-1 text-sm text-text-tertiary transition hover:bg-hover-overlay focus:outline-none focus-visible:[box-shadow:var(--admin-input-focus-shadow)]"
                onClick={closeCreateIdentityModal}
              >
                关闭
              </button>
            </div>
            <label className="mt-4 block text-xs font-medium text-text-tertiary">
              昵称
              <input
                value={identityName}
                onChange={(event) => setIdentityName(event.target.value)}
                placeholder="例如：产品经理、用户B"
                autoFocus
                className="mt-1 h-10 w-full rounded-[10px] border border-[var(--admin-border)] bg-[var(--admin-input-bg)] px-3 text-sm text-text outline-none transition placeholder:text-input-placeholder focus:border-primary focus:[box-shadow:var(--admin-input-focus-shadow)]"
              />
            </label>
            <label className="mt-3 block text-xs font-medium text-text-tertiary">
              备注
              <input
                value={identityNote}
                onChange={(event) => setIdentityNote(event.target.value)}
                placeholder="例如：模拟需求反馈"
                className="mt-1 h-10 w-full rounded-[10px] border border-[var(--admin-border)] bg-[var(--admin-input-bg)] px-3 text-sm text-text outline-none transition placeholder:text-input-placeholder focus:border-primary focus:[box-shadow:var(--admin-input-focus-shadow)]"
              />
            </label>
            <div className="mt-5 flex justify-end gap-3">
              <button
                type="button"
                className="h-10 rounded-[10px] border border-[var(--admin-border)] px-4 text-sm font-medium text-text transition hover:bg-hover-overlay focus:outline-none focus-visible:[box-shadow:var(--admin-input-focus-shadow)]"
                onClick={closeCreateIdentityModal}
              >
                取消
              </button>
              <button
                type="submit"
                className="h-10 rounded-[10px] bg-primary px-4 text-sm font-semibold text-on-primary transition hover:bg-primary-hover active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:[box-shadow:var(--admin-input-focus-shadow)]"
                disabled={!identityName.trim()}
              >
                创建身份
              </button>
            </div>
          </form>
        </div>
      )}
      {showCreateGroupModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
          <button
            type="button"
            className="absolute inset-0 bg-[var(--admin-overlay)] backdrop-blur-[2px]"
            onClick={closeCreateGroupModal}
            aria-label="关闭新增群弹窗"
          />
          <form
            className="relative z-10 w-full max-w-[420px] rounded-[14px] border border-[var(--admin-border)] bg-[var(--admin-dialog-bg)] p-5 text-text [box-shadow:var(--admin-floating-shadow)]"
            onSubmit={(event) => {
              event.preventDefault();
              handleCreateGroup();
            }}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">新增测试群</h2>
              <button
                type="button"
                className="rounded-[8px] px-2 py-1 text-sm text-text-tertiary transition hover:bg-hover-overlay focus:outline-none focus-visible:[box-shadow:var(--admin-input-focus-shadow)]"
                onClick={closeCreateGroupModal}
              >
                关闭
              </button>
            </div>
            <label className="mt-4 block text-xs font-medium text-text-tertiary">
              群名称
              <input
                value={groupName}
                onChange={(event) => setGroupName(event.target.value)}
                placeholder="例如：产品讨论群"
                autoFocus
                className="mt-1 h-10 w-full rounded-[10px] border border-[var(--admin-border)] bg-[var(--admin-input-bg)] px-3 text-sm text-text outline-none transition placeholder:text-input-placeholder focus:border-primary focus:[box-shadow:var(--admin-input-focus-shadow)]"
              />
            </label>
            <label className="mt-3 block text-xs font-medium text-text-tertiary">
              备注
              <input
                value={groupNote}
                onChange={(event) => setGroupNote(event.target.value)}
                placeholder="例如：模拟多人需求讨论"
                className="mt-1 h-10 w-full rounded-[10px] border border-[var(--admin-border)] bg-[var(--admin-input-bg)] px-3 text-sm text-text outline-none transition placeholder:text-input-placeholder focus:border-primary focus:[box-shadow:var(--admin-input-focus-shadow)]"
              />
            </label>
            <p className="mt-3 text-xs leading-5 text-text-tertiary">
              新群会默认包含当前所有测试身份，后续可用不同身份向群里发消息。
            </p>
            <div className="mt-5 flex justify-end gap-3">
              <button
                type="button"
                className="h-10 rounded-[10px] border border-[var(--admin-border)] px-4 text-sm font-medium text-text transition hover:bg-hover-overlay focus:outline-none focus-visible:[box-shadow:var(--admin-input-focus-shadow)]"
                onClick={closeCreateGroupModal}
              >
                取消
              </button>
              <button
                type="submit"
                className="h-10 rounded-[10px] bg-primary px-4 text-sm font-semibold text-on-primary transition hover:bg-primary-hover active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:[box-shadow:var(--admin-input-focus-shadow)]"
                disabled={!groupName.trim()}
              >
                创建群
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

function ArrangementUpdateToastPanel({
  toast,
  onUndo,
}: {
  toast: ArrangementUpdateToast | null;
  onUndo: (previousItems: ArrangementItem[]) => void;
}) {
  if (!toast) return null;

  return (
    <div className="mb-3 flex items-center justify-between gap-3 rounded-[12px] border border-[rgba(9,184,62,0.22)] bg-primary-soft px-3 py-2.5 text-[12px] leading-5 text-primary">
      <p className="min-w-0 flex-1 truncate">
        已自动补全「{toast.itemTitle}」
      </p>
      <button
        type="button"
        className="shrink-0 rounded-full bg-[var(--admin-input-bg)] px-3 py-1 text-[12px] font-medium text-primary transition hover:bg-[var(--admin-input-hover-bg)] active:scale-[0.98]"
        onClick={() => onUndo(toast.previousItems)}
      >
        撤销
      </button>
    </div>
  );
}

function AmbiguousArrangementUpdatePanel({
  update,
  onChoose,
  onCreateNew,
  onIgnore,
}: {
  update: AmbiguousArrangementUpdate | null;
  onChoose: (arrangementId: string) => void;
  onCreateNew: () => void;
  onIgnore: () => void;
}) {
  if (!update) return null;

  return (
    <div className="rounded-[12px] border border-[rgba(9,184,62,0.22)] bg-primary-soft px-3 py-2.5 text-[12px] leading-5 text-text">
      <p className="font-medium text-text">
        {update.candidates.length > 1
          ? "这条消息要更新哪一个事项？"
          : `要更新“${update.candidates[0]?.arrangement.title ?? "这个事项"}”吗？`}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {update.candidates.slice(0, 2).map((candidate) => (
          <button
            key={candidate.arrangement.id}
            type="button"
            className="rounded-full bg-primary px-3 py-1.5 text-[12px] font-medium text-on-primary transition active:scale-[0.98]"
            onClick={() => onChoose(candidate.arrangement.id)}
          >
            更新“{candidate.arrangement.title}”
          </button>
        ))}
        <button
          type="button"
          className="rounded-full bg-[var(--admin-input-bg)] px-3 py-1.5 text-[12px] font-medium text-text-muted transition hover:bg-[var(--admin-input-hover-bg)] active:scale-[0.98]"
          onClick={onCreateNew}
        >
          新建安排
        </button>
        <button
          type="button"
          className="rounded-full bg-[var(--admin-input-bg)] px-3 py-1.5 text-[12px] font-medium text-text-muted transition hover:bg-[var(--admin-input-hover-bg)] active:scale-[0.98]"
          onClick={onIgnore}
        >
          忽略
        </button>
      </div>
    </div>
  );
}

function AliasCandidateConfirmationCard({
  confirmation,
  onConfirm,
  onIgnore,
}: {
  confirmation: AliasCandidateConfirmation;
  onConfirm: (confirmation: AliasCandidateConfirmation) => void;
  onIgnore: () => void;
}) {
  const [aliasText, setAliasText] = React.useState(confirmation.aliasText);
  const [aliasMeaning, setAliasMeaning] = React.useState(
    confirmation.aliasMeaning
  );

  React.useEffect(() => {
    setAliasText(confirmation.aliasText);
    setAliasMeaning(confirmation.aliasMeaning);
  }, [confirmation]);

  return (
    <div className="rounded-[12px] border border-[rgba(9,184,62,0.22)] bg-primary-soft px-3 py-2 text-text">
      <div className="flex items-start gap-2">
        <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-[9px] font-semibold text-on-primary">
          AI
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium leading-5 text-text">
            是否把“{confirmation.aliasText}”记为“{confirmation.aliasMeaning}”？
          </p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <input
              value={aliasText}
              onChange={(event) => setAliasText(event.target.value)}
              placeholder="暗语"
              className="h-9 rounded-[10px] border border-[rgba(9,184,62,0.22)] bg-[var(--admin-input-bg)] px-3 text-[13px] text-text outline-none focus:border-primary focus:[box-shadow:var(--admin-input-focus-shadow)]"
            />
            <input
              value={aliasMeaning}
              onChange={(event) => setAliasMeaning(event.target.value)}
              placeholder="暗语含义"
              className="h-9 rounded-[10px] border border-[rgba(9,184,62,0.22)] bg-[var(--admin-input-bg)] px-3 text-[13px] text-text outline-none focus:border-primary focus:[box-shadow:var(--admin-input-focus-shadow)]"
            />
          </div>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 pl-7">
        <button
          type="button"
          className="h-7 rounded-full bg-primary px-3 text-[12px] font-semibold text-on-primary transition hover:bg-primary-hover active:scale-[0.98]"
          onClick={() =>
            onConfirm({
              ...confirmation,
              aliasText: aliasText.trim(),
              aliasMeaning: aliasMeaning.trim(),
            })
          }
        >
          写入暗语设置
        </button>
        <button
          type="button"
          className="h-7 rounded-full bg-[var(--admin-input-bg)] px-3 text-[12px] font-medium text-text-muted transition hover:bg-[var(--admin-input-hover-bg)] active:scale-[0.98]"
          onClick={onIgnore}
        >
          忽略
        </button>
      </div>
    </div>
  );
}

function ChatArrangementConfirmationCard({
  confirmation,
  queueCount,
  onConfirm,
  onIgnore,
}: {
  confirmation: ChatArrangementConfirmation;
  queueCount: number;
  onConfirm: (confirmation: ChatArrangementConfirmation) => void;
  onIgnore: (confirmationId: string) => void;
}) {
  const [isEditing, setIsEditing] = React.useState(false);
  const [isDialogOpen, setIsDialogOpen] = React.useState(false);
  const [draft, setDraft] = React.useState(confirmation);
  const compactQuestion = buildArrangementConfirmationQuestion(confirmation);
  const isUnknownAliasArrangement =
    draft.sourceType === "unknown_alias_arrangement";
  const possibleArrangementText = [draft.timeText, draft.title]
    .filter(Boolean)
    .join("");

  React.useEffect(() => {
    setDraft(confirmation);
    setIsEditing(false);
    setIsDialogOpen(false);
  }, [confirmation]);

  const updateDraft = (
    key:
      | "title"
      | "timeText"
      | "locationText"
      | "note"
      | "unknownAliasText"
      | "suggestedAliasMeaning",
    value: string
  ) => {
    setDraft((current) => ({
      ...current,
      [key]: value,
      ...(key === "locationText" ? { locationName: value } : {}),
    }));
  };

  const handleConfirm = () => {
    const title = draft.title.trim();
    if (!title) return;

    onConfirm({
      ...draft,
      title,
      timeText: draft.timeText.trim(),
      locationText: draft.locationText.trim(),
      locationName: draft.locationName.trim() || draft.locationText.trim(),
      note: draft.note.trim(),
      unknownAliasText: draft.unknownAliasText?.trim() ?? "",
      suggestedAliasMeaning: draft.suggestedAliasMeaning?.trim() ?? "",
      aliasLearningStatus: draft.suggestedAliasMeaning?.trim()
        ? "suggested"
        : draft.aliasLearningStatus,
    });
  };

  const openConfirmDialog = () => {
    setDraft(confirmation);
    setIsDialogOpen(true);
  };

  return (
    <>
      <div className="rounded-[12px] border border-[rgba(9,184,62,0.22)] bg-primary-soft px-3 py-2 text-text">
        {isEditing && !isUnknownAliasArrangement ? (
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-on-primary">
              AI
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <p className="text-[13px] font-semibold leading-5 text-primary">
                  编辑确认事项安排
                </p>
                {queueCount > 1 && (
                  <span className="rounded-full bg-[rgba(9,184,62,0.12)] px-2 py-[2px] text-[10px] font-medium leading-3 text-primary">
                    还有 {queueCount - 1} 个
                  </span>
                )}
              </div>
              <div className="mt-2 space-y-2">
                <input
                  value={draft.title}
                  onChange={(event) => updateDraft("title", event.target.value)}
                  placeholder="安排标题"
                  className="h-9 w-full rounded-[10px] border border-[rgba(9,184,62,0.22)] bg-[var(--admin-input-bg)] px-3 text-[13px] text-text outline-none focus:border-primary focus:[box-shadow:var(--admin-input-focus-shadow)]"
                />
                <input
                  value={draft.timeText}
                  onChange={(event) => updateDraft("timeText", event.target.value)}
                  placeholder="时间"
                  className="h-9 w-full rounded-[10px] border border-[rgba(9,184,62,0.22)] bg-[var(--admin-input-bg)] px-3 text-[13px] text-text outline-none focus:border-primary focus:[box-shadow:var(--admin-input-focus-shadow)]"
                />
                <input
                  value={draft.locationName || draft.locationText}
                  onChange={(event) =>
                    updateDraft("locationText", event.target.value)
                  }
                  placeholder="地点"
                  className="h-9 w-full rounded-[10px] border border-[rgba(9,184,62,0.22)] bg-[var(--admin-input-bg)] px-3 text-[13px] text-text outline-none focus:border-primary focus:[box-shadow:var(--admin-input-focus-shadow)]"
                />
                <textarea
                  value={draft.note}
                  onChange={(event) => updateDraft("note", event.target.value)}
                  placeholder="备注"
                  rows={2}
                  className="min-h-[58px] w-full resize-none rounded-[10px] border border-[rgba(9,184,62,0.22)] bg-[var(--admin-input-bg)] px-3 py-2 text-[13px] leading-5 text-text outline-none focus:border-primary focus:[box-shadow:var(--admin-input-focus-shadow)]"
                />
              </div>
            </div>
          </div>
        ) : (
          <div>
            <div className="flex min-w-0 items-start gap-2">
              <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-[9px] font-semibold text-on-primary">
                AI
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium leading-5 text-text">
                  {isUnknownAliasArrangement
                    ? `检测到可能的安排：${
                        possibleArrangementText || draft.title || "这个事项"
                      }`
                    : compactQuestion}
                </p>
                {queueCount > 1 && (
                  <p className="mt-0.5 truncate text-[11px] leading-4 text-text-tertiary">
                    还有 {queueCount - 1} 个待确认
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-2 pl-7">
            <button
              type="button"
              className="h-7 rounded-full bg-primary px-3 text-[12px] font-semibold text-on-primary transition hover:bg-primary-hover active:scale-[0.98]"
              onClick={isUnknownAliasArrangement ? openConfirmDialog : handleConfirm}
            >
              {isEditing ? "保存并添加" : "确认添加"}
            </button>
            <button
              type="button"
              className="h-7 rounded-full bg-[var(--admin-input-bg)] px-3 text-[12px] font-medium text-text-muted transition hover:bg-[var(--admin-input-hover-bg)] active:scale-[0.98]"
              onClick={() => {
                if (isEditing) {
                  setDraft(confirmation);
                  setIsEditing(false);
                  return;
                }
                if (isUnknownAliasArrangement) {
                  openConfirmDialog();
                  return;
                }
                setIsEditing(true);
              }}
            >
              {isEditing ? "取消" : "编辑"}
            </button>
            <button
              type="button"
              className="h-7 rounded-full bg-[var(--admin-input-bg)] px-3 text-[12px] font-medium text-text-muted transition hover:bg-[var(--admin-input-hover-bg)] active:scale-[0.98]"
              onClick={() => onIgnore(confirmation.id)}
            >
              忽略
            </button>
        </div>
      </div>

      {isUnknownAliasArrangement && isDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-[rgba(15,23,42,0.32)] px-4 pb-4 pt-12 backdrop-blur-[2px]">
          <div className="w-full max-w-[430px] rounded-[18px] bg-[var(--admin-panel-bg)] p-4 text-text shadow-[0_20px_60px_rgba(15,23,42,0.24)]">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[16px] font-semibold leading-6 text-text">
                  确认暗语与安排
                </p>
                <p className="mt-1 text-[12px] leading-5 text-text-tertiary">
                  {`检测到可能的安排：${
                    possibleArrangementText || draft.title || "这个事项"
                  }`}
                </p>
              </div>
              <button
                type="button"
                className="h-7 rounded-full bg-[var(--admin-input-bg)] px-3 text-[12px] font-medium text-text-muted transition hover:bg-[var(--admin-input-hover-bg)]"
                onClick={() => {
                  setDraft(confirmation);
                  setIsDialogOpen(false);
                }}
              >
                关闭
              </button>
            </div>

            <div className="mt-3 space-y-2">
              <input
                value={draft.title}
                onChange={(event) => updateDraft("title", event.target.value)}
                placeholder="安排标题"
                className="h-10 w-full rounded-[10px] border border-[rgba(9,184,62,0.22)] bg-[var(--admin-input-bg)] px-3 text-[14px] text-text outline-none focus:border-primary focus:[box-shadow:var(--admin-input-focus-shadow)]"
              />
              <input
                value={draft.timeText}
                onChange={(event) => updateDraft("timeText", event.target.value)}
                placeholder="时间"
                className="h-10 w-full rounded-[10px] border border-[rgba(9,184,62,0.22)] bg-[var(--admin-input-bg)] px-3 text-[14px] text-text outline-none focus:border-primary focus:[box-shadow:var(--admin-input-focus-shadow)]"
              />
              <input
                value={draft.locationName || draft.locationText}
                onChange={(event) => updateDraft("locationText", event.target.value)}
                placeholder="地点"
                className="h-10 w-full rounded-[10px] border border-[rgba(9,184,62,0.22)] bg-[var(--admin-input-bg)] px-3 text-[14px] text-text outline-none focus:border-primary focus:[box-shadow:var(--admin-input-focus-shadow)]"
              />
              <textarea
                value={draft.note}
                onChange={(event) => updateDraft("note", event.target.value)}
                placeholder="备注"
                rows={2}
                className="min-h-[62px] w-full resize-none rounded-[10px] border border-[rgba(9,184,62,0.22)] bg-[var(--admin-input-bg)] px-3 py-2 text-[14px] leading-5 text-text outline-none focus:border-primary focus:[box-shadow:var(--admin-input-focus-shadow)]"
              />
              <label className="block text-[12px] leading-4 text-text-tertiary">
                暗语
                <input
                  value={draft.unknownAliasText ?? ""}
                  onChange={(event) =>
                    updateDraft("unknownAliasText", event.target.value)
                  }
                  placeholder="例如：~~、老样子"
                  className="mt-1 h-10 w-full rounded-[10px] border border-[rgba(9,184,62,0.22)] bg-[var(--admin-input-bg)] px-3 text-[14px] text-text outline-none focus:border-primary focus:[box-shadow:var(--admin-input-focus-shadow)]"
                />
              </label>
              <label className="block text-[12px] leading-4 text-text-tertiary">
                暗语含义
                <input
                  value={draft.suggestedAliasMeaning ?? ""}
                  onChange={(event) =>
                    updateDraft("suggestedAliasMeaning", event.target.value)
                  }
                  placeholder="可编辑暗语含义，如：游泳"
                  className="mt-1 h-10 w-full rounded-[10px] border border-[rgba(9,184,62,0.22)] bg-[var(--admin-input-bg)] px-3 text-[14px] text-text outline-none focus:border-primary focus:[box-shadow:var(--admin-input-focus-shadow)]"
                />
              </label>
            </div>

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                className="h-9 rounded-full bg-[var(--admin-input-bg)] px-4 text-[13px] font-medium text-text-muted transition hover:bg-[var(--admin-input-hover-bg)]"
                onClick={() => onIgnore(confirmation.id)}
              >
                忽略
              </button>
              <button
                type="button"
                className="h-9 rounded-full bg-primary px-4 text-[13px] font-semibold text-on-primary transition hover:bg-primary-hover active:scale-[0.98]"
                onClick={handleConfirm}
              >
                确认添加
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function buildArrangementConfirmationQuestion(
  confirmation: ChatArrangementConfirmation
) {
  const title = confirmation.title.trim();
  const timeText = confirmation.timeText.trim();
  const location = (
    confirmation.locationName.trim() || confirmation.locationText.trim()
  ).trim();
  const locationText = location && !title.includes(location) ? `（${location}）` : "";
  const mainText = [timeText, title].filter(Boolean).join("");

  return `要帮您安排${mainText || title || "这个事项"}${locationText}吗？`;
}

function AutoRecognitionStatusPanel({ status }: { status: AutoRecognitionStatus }) {
  if (status.status === "idle") return null;

  const isError = status.status === "error";
  const isSuccess = status.status === "success";
  const message =
    status.status === "loading" ? "正在自动识别聊天里的安排..." : status.message;

  return (
    <div
      className={cn(
        "mb-3 rounded-[12px] border px-3 py-2.5 text-[12px] leading-5",
        isError
          ? "border-[rgba(244,99,99,0.22)] bg-[rgba(244,99,99,0.08)] text-danger"
          : isSuccess
            ? "border-[rgba(9,184,62,0.22)] bg-primary-soft text-primary"
            : "border-[var(--admin-border-subtle)] bg-[var(--admin-panel-muted-bg)] text-text-tertiary"
      )}
    >
      {message}
    </div>
  );
}

function getAiTestErrorMessage(error: unknown) {
  if (error instanceof AiApiError) {
    if (error.code === "AI_API_NOT_CONFIGURED") {
      return "请先在移动端 Demo 的 AI API 设置中完成配置。";
    }

    if (error.code === "AI_API_JSON_PARSE_FAILED") {
      return "AI 已返回内容，但不是合法 JSON。";
    }

    return "AI 请求失败，请检查 Base URL、Model 或网络状态。";
  }

  return "AI 请求失败，请稍后重试。";
}

function getAiTestDisplayText(output: unknown) {
  if (output && typeof output === "object" && !Array.isArray(output)) {
    const summary = (output as { summary?: unknown }).summary;
    if (typeof summary === "string" && summary.trim()) {
      return summary.trim();
    }
  }

  return JSON.stringify(output, null, 2);
}

function AiTestResultPanel({ result }: { result: AiTestResult }) {
  if (result.status === "idle") return null;

  if (result.status === "loading") {
    return (
      <div className="mb-3 rounded-[12px] border border-[var(--admin-border-subtle)] bg-[var(--admin-panel-muted-bg)] px-3 py-2.5 text-[12px] leading-5 text-text-tertiary">
        正在测试 AI 调用...
      </div>
    );
  }

  if (result.status === "error") {
    return (
      <div className="mb-3 rounded-[12px] border border-[rgba(244,99,99,0.22)] bg-[rgba(244,99,99,0.08)] px-3 py-2.5 text-[12px] leading-5 text-danger">
        {result.message}
      </div>
    );
  }

  return (
    <div className="mb-3 rounded-[12px] border border-[rgba(9,184,62,0.22)] bg-primary-soft px-3 py-2.5">
      <p className="text-[12px] font-semibold leading-5 text-primary">
        AI 测试成功
      </p>
      <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words text-[12px] leading-5 text-text">
        {getAiTestDisplayText(result.output)}
      </pre>
    </div>
  );
}

function AdminConversationMessages({
  identity,
  identities,
  mode,
  messages,
}: {
  identity: TestIdentity | null;
  identities: TestIdentity[];
  mode: TestConversationType;
  messages: TestMessage[];
}) {
  let previousSentAt = 0;

  return (
    <div className="space-y-5">
      {messages.map((message, index) => {
        const showTime =
          index === 0 || Math.abs(message.sentAt - previousSentAt) > 1000 * 60 * 5;
        previousSentAt = message.sentAt;

        return (
          <div key={message.id} className="space-y-3">
            {showTime && (
              <div className="flex justify-center">
                <span className="text-[13px] font-medium leading-5 text-text-disabled">
                  {formatConversationTime(message.sentAt)}
                </span>
              </div>
            )}
            {message.sender === "demo" ? (
              <div className="flex items-start justify-start gap-2.5">
                <DemoAvatar />
                <MessageBubble align="left" text={message.text} />
              </div>
            ) : (
              <div className="flex items-start justify-end gap-3">
                <div className="flex max-w-[76%] flex-col items-end gap-1">
                  {mode === "group" && (
                    <span className="pr-1 text-[11px] leading-4 text-text-tertiary">
                      {identities.find((item) => item.id === message.identityId)?.name ??
                        "群成员"}
                    </span>
                  )}
                  <MessageBubble align="right" text={message.text} />
                </div>
                {(identities.find((item) => item.id === message.identityId) ?? identity) && (
                  <IdentityAvatar
                    identity={
                      identities.find((item) => item.id === message.identityId) ??
                      identity!
                    }
                    large
                  />
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function GroupPickerDropdown({
  align = "left",
  groups,
  messages,
  activeGroup,
  onSelect,
  onCreate,
}: {
  align?: "left" | "right";
  groups: TestGroup[];
  messages: TestMessage[];
  activeGroup: TestGroup | null;
  onSelect: (groupId: string) => void;
  onCreate: () => void;
}) {
  return (
    <div
      className={cn(
        "absolute z-20 w-[320px] max-w-[calc(100vw-48px)] rounded-[14px] border border-[var(--admin-border)] bg-[var(--admin-dialog-bg)] p-2 [box-shadow:var(--admin-floating-shadow)]",
        align === "right"
          ? "right-0 top-full mt-2"
          : "bottom-full left-1 mb-2"
      )}
    >
      <div className="max-h-[260px] space-y-1 overflow-auto">
        {groups.map((group) => {
          const messageCount = messages.filter(
            (message) => message.conversationId === group.id
          ).length;
          const active = group.id === activeGroup?.id;
          return (
            <button
              key={group.id}
              type="button"
              className={cn(
                "flex w-full items-center rounded-[10px] px-3 py-2.5 text-left transition focus:outline-none focus-visible:[box-shadow:var(--admin-input-focus-shadow)]",
                active ? "bg-primary-selected" : "hover:bg-hover-overlay"
              )}
              onClick={() => onSelect(group.id)}
            >
              <GroupAvatar group={group} />
              <span className="ml-3 min-w-0 flex-1">
                <span className="flex min-w-0 items-center justify-between gap-2">
                  <span className="truncate text-[14px] font-medium text-text">
                    {group.name}
                  </span>
                  <span className="shrink-0 text-[11px] text-text-tertiary">
                    {messageCount}条
                  </span>
                </span>
                <span className="mt-0.5 block truncate text-xs text-text-tertiary">
                  {group.note.trim() || "此群聊暂无备注"}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        className="mt-2 flex h-10 w-full items-center rounded-[10px] border border-[var(--admin-border-subtle)] px-3 text-left text-sm font-medium text-text transition hover:bg-hover-overlay focus:outline-none focus-visible:[box-shadow:var(--admin-input-focus-shadow)]"
        onClick={onCreate}
      >
        <span className="flex items-center">
          <span className="mr-2 flex h-6 w-6 items-center justify-center rounded-full bg-fill-4 text-base leading-none">
            +
          </span>
          创建新群聊
        </span>
      </button>
    </div>
  );
}

function IdentityPickerDropdown({
  identities,
  messages,
  activeIdentity,
  onSelect,
  onCreate,
}: {
  identities: TestIdentity[];
  messages: TestMessage[];
  activeIdentity: TestIdentity;
  onSelect: (identityId: string) => void;
  onCreate: () => void;
}) {
  return (
    <div className="absolute bottom-full left-1 z-20 mb-2 w-[320px] max-w-[calc(100vw-48px)] rounded-[14px] border border-[var(--admin-border)] bg-[var(--admin-dialog-bg)] p-2 [box-shadow:var(--admin-floating-shadow)]">
      <div className="max-h-[260px] space-y-1 overflow-auto">
        {identities.map((identity) => {
          const messageCount = messages.filter(
            (message) => message.identityId === identity.id
          ).length;
          const active = identity.id === activeIdentity.id;
          return (
            <button
              key={identity.id}
              type="button"
              className={cn(
                "flex w-full items-center rounded-[10px] px-3 py-2.5 text-left transition focus:outline-none focus-visible:[box-shadow:var(--admin-input-focus-shadow)]",
                active ? "bg-primary-selected" : "hover:bg-hover-overlay"
              )}
              onClick={() => onSelect(identity.id)}
            >
              <IdentityAvatar identity={identity} />
              <span className="ml-3 min-w-0 flex-1">
                <span className="flex min-w-0 items-center justify-between gap-2">
                  <span className="truncate text-[14px] font-medium text-text">
                    {identity.name}
                  </span>
                  <span className="shrink-0 text-[11px] text-text-tertiary">
                    已发{messageCount}条
                  </span>
                </span>
                <span className="mt-0.5 block truncate text-xs text-text-tertiary">
                  {identity.note.trim() || "此身份暂无备注"}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        className="mt-2 flex h-10 w-full items-center rounded-[10px] border border-[var(--admin-border-subtle)] px-3 text-left text-sm font-medium text-text transition hover:bg-hover-overlay focus:outline-none focus-visible:[box-shadow:var(--admin-input-focus-shadow)]"
        onClick={onCreate}
      >
        <span className="flex items-center">
          <span className="mr-2 flex h-6 w-6 items-center justify-center rounded-full bg-fill-4 text-base leading-none">
            +
          </span>
          创建新身份
        </span>
      </button>
    </div>
  );
}

function GroupAvatar({ group }: { group: TestGroup }) {
  return (
    <span
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold text-white"
      style={{ backgroundColor: group.color }}
    >
      {group.avatarLabel}
    </span>
  );
}

function formatConversationTime(timestamp: number) {
  const dayLabel = formatTimeLabel(timestamp);
  const timeLabel = formatBubbleTime(timestamp);
  return dayLabel === "今天" ? timeLabel : `${dayLabel} ${timeLabel}`;
}

function MessageBubble({
  align,
  text,
}: {
  align: "left" | "right";
  text: string;
}) {
  return (
    <button
      type="button"
      className={cn(
        "rounded-[12px] border border-[var(--admin-border-subtle)] bg-[var(--admin-bubble-bg)] px-3.5 py-2.5 text-left text-text [box-shadow:var(--shadow-sm)] transition hover:bg-[var(--admin-bubble-hover-bg)] active:scale-[0.995] focus:outline-none focus-visible:[box-shadow:var(--admin-input-focus-shadow)]",
        align === "right"
          ? "w-fit max-w-full rounded-tr-[4px]"
          : "max-w-[76%] rounded-tl-[4px]"
      )}
      onContextMenu={(event) => {
        event.preventDefault();
      }}
    >
      <p className="whitespace-pre-wrap break-words text-[15px] font-normal leading-[1.55] tracking-normal">
        {text}
      </p>
    </button>
  );
}

function DemoAvatar() {
  return (
    <span
      className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold leading-none text-on-primary"
      aria-hidden="true"
    >
      我
    </span>
  );
}

function IdentityAvatar({
  identity,
  small = false,
  large = false,
}: {
  identity: TestIdentity;
  small?: boolean;
  large?: boolean;
}) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white",
        large ? "h-8 w-8 text-[11px]" : small ? "h-7 w-7" : "h-9 w-9"
      )}
      style={{ backgroundColor: identity.color }}
      aria-hidden="true"
    >
      {identity.avatarLabel}
    </span>
  );
}
