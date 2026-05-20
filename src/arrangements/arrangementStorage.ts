export type ArrangementStatus = "pending" | "later" | "completed";
export type ArrangementTimeKind = "none" | "allDay" | "time" | "timeRange";

export type ArrangementItem = {
  id: string;
  title: string;
  timeText: string;
  dateKey: string;
  startTime: string;
  endTime: string;
  timeKind: ArrangementTimeKind;
  peopleText: string;
  locationText: string;
  locationName: string;
  note: string;
  source: string;
  status: ArrangementStatus;
  createdAt: number;
  pinned: boolean;
  contexts?: string[];
};

export type ArrangementDraft = {
  title: string;
  timeText: string;
  dateKey: string;
  startTime: string;
  endTime: string;
  timeKind: ArrangementTimeKind;
  peopleText: string;
  locationText: string;
  locationName: string;
  note: string;
};

export type PendingArrangementDraft = ArrangementDraft & {
  id: string;
  confidence: number;
  contexts: string[];
  source: "ai" | "rules" | "ai_group_chat";
  createdAt: number;
};

export const arrangementStorageEvent = "arkme-demo.arrangements-updated";
export const arrangementsStorageKey = "arkme-demo.arrangements";
export const pendingArrangementDraftsStorageKey =
  "arkme-demo.pendingArrangementDrafts";
const calendarDayMs = 24 * 60 * 60 * 1000;

export function buildDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * calendarDayMs);
}

export function isValidDateKey(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function isValidTimeValue(value: string) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function normalizeTimeKind(value: unknown): ArrangementTimeKind {
  return value === "allDay" || value === "time" || value === "timeRange"
    ? value
    : "none";
}

function normalizeArrangementStatus(value: unknown): ArrangementStatus {
  if (value === "later" || value === "completed") return value;
  return "pending";
}

function normalizeText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function buildReadableDate(dateKey: string) {
  if (!isValidDateKey(dateKey)) return "";
  const [, month, day] = dateKey.split("-");
  return `${Number(month)}月${Number(day)}日`;
}

const tomorrowDateKey = buildDateKey(addDays(new Date(), 1));
const dayAfterTomorrowDateKey = buildDateKey(addDays(new Date(), 2));

const defaultArrangements: ArrangementItem[] = [
  {
    id: "sample-hospital",
    title: "后天去一趟医院",
    timeText: `${buildReadableDate(dayAfterTomorrowDateKey)} 09:30`,
    dateKey: dayAfterTomorrowDateKey,
    startTime: "09:30",
    endTime: "",
    timeKind: "time",
    peopleText: "自己",
    locationText: "市中心医院",
    locationName: "市中心医院",
    note: "",
    source: "来自发给自己",
    status: "pending",
    createdAt: 1760000003000,
    pinned: false,
  },
  {
    id: "sample-breakfast",
    title: "到公司帮小林带早餐",
    timeText: `${buildReadableDate(tomorrowDateKey)} 08:30`,
    dateKey: tomorrowDateKey,
    startTime: "08:30",
    endTime: "",
    timeKind: "time",
    peopleText: "小林",
    locationText: "公司",
    locationName: "公司",
    note: "",
    source: "来自私聊",
    status: "pending",
    createdAt: 1760000002000,
    pinned: false,
  },
  {
    id: "sample-documents",
    title: "项目资料以后再整理",
    timeText: "",
    dateKey: "",
    startTime: "",
    endTime: "",
    timeKind: "none",
    peopleText: "",
    locationText: "",
    locationName: "",
    note: "",
    source: "已暂放",
    status: "later",
    createdAt: 1760000001000,
    pinned: false,
  },
];

function normalizeContexts(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
    : [];
}

function normalizeConfidence(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0.6;
  return Math.min(1, Math.max(0, value));
}

function normalizeStoredArrangement(value: unknown): ArrangementItem | null {
  if (!value || typeof value !== "object") return null;

  const item = value as Partial<ArrangementItem>;
  const id = normalizeText(item.id);
  const title = normalizeText(item.title);
  if (!id || !title) return null;
  const locationText = normalizeText(item.locationText);
  const locationName = normalizeText(item.locationName) || locationText;
  const dateKey = normalizeText(item.dateKey);
  const startTime = normalizeText(item.startTime);
  const endTime = normalizeText(item.endTime);
  const contexts = normalizeContexts(item.contexts);

  return {
    id,
    title,
    timeText: normalizeText(item.timeText),
    dateKey: isValidDateKey(dateKey) ? dateKey : "",
    startTime: isValidTimeValue(startTime) ? startTime : "",
    endTime: isValidTimeValue(endTime) ? endTime : "",
    timeKind: normalizeTimeKind(item.timeKind),
    peopleText: normalizeText(item.peopleText),
    locationText,
    locationName,
    note: normalizeText(item.note),
    source: normalizeText(item.source) || "手动创建",
    status: normalizeArrangementStatus(item.status),
    createdAt:
      typeof item.createdAt === "number" && Number.isFinite(item.createdAt)
        ? item.createdAt
        : Date.now(),
    pinned: item.pinned === true,
    ...(contexts.length > 0 ? { contexts } : {}),
  };
}

export function getInitialArrangements() {
  if (typeof window === "undefined") return defaultArrangements;

  try {
    const storedValue = window.localStorage.getItem(arrangementsStorageKey);
    if (!storedValue) return defaultArrangements;
    const parsedValue = JSON.parse(storedValue);
    if (!Array.isArray(parsedValue)) return defaultArrangements;

    const storedArrangements = parsedValue
      .map(normalizeStoredArrangement)
      .filter((item): item is ArrangementItem => Boolean(item));
    return storedArrangements.length > 0 ? storedArrangements : defaultArrangements;
  } catch {
    return defaultArrangements;
  }
}

export function persistArrangements(items: ArrangementItem[]) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(arrangementsStorageKey, JSON.stringify(items));
  } catch {
    // Keep the in-memory arrangement usable when storage is unavailable.
  }
}

export function appendArrangement(item: ArrangementItem) {
  const nextArrangements = [item, ...getInitialArrangements()];
  persistArrangements(nextArrangements);

  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(arrangementStorageEvent));
  }

  return nextArrangements;
}

function normalizePendingArrangementDraft(value: unknown): PendingArrangementDraft | null {
  if (!value || typeof value !== "object") return null;

  const draft = value as Partial<PendingArrangementDraft>;
  const id = normalizeText(draft.id);
  const title = normalizeText(draft.title);
  if (!id || !title) return null;
  const locationText = normalizeText(draft.locationText);
  const locationName = normalizeText(draft.locationName) || locationText;
  const contexts = normalizeContexts(draft.contexts);

  return {
    id,
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
    contexts,
    source:
      draft.source === "rules" || draft.source === "ai_group_chat"
        ? draft.source
        : "ai",
    createdAt:
      typeof draft.createdAt === "number" && Number.isFinite(draft.createdAt)
        ? draft.createdAt
        : Date.now(),
  };
}

export function getPendingArrangementDrafts() {
  if (typeof window === "undefined") return [];

  try {
    const storedValue = window.localStorage.getItem(pendingArrangementDraftsStorageKey);
    if (!storedValue) return [];
    const parsedValue = JSON.parse(storedValue);
    if (!Array.isArray(parsedValue)) return [];
    return parsedValue
      .map(normalizePendingArrangementDraft)
      .filter((item): item is PendingArrangementDraft => Boolean(item));
  } catch {
    return [];
  }
}

export function persistPendingArrangementDrafts(items: PendingArrangementDraft[]) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(
      pendingArrangementDraftsStorageKey,
      JSON.stringify(items)
    );
    window.dispatchEvent(new Event(arrangementStorageEvent));
  } catch {
    // Pending drafts are a convenience; keep the current screen usable.
  }
}

export function appendPendingArrangementDrafts(
  drafts: Omit<PendingArrangementDraft, "id" | "createdAt">[]
) {
  const now = Date.now();
  const nextDrafts = [
    ...drafts.map((draft, index) => ({
      ...draft,
      id: `pending-ai-${now}-${index}`,
      createdAt: now + index,
    })),
    ...getPendingArrangementDrafts(),
  ];
  persistPendingArrangementDrafts(nextDrafts);
  return nextDrafts;
}

export function removePendingArrangementDraft(id: string) {
  const nextDrafts = getPendingArrangementDrafts().filter((draft) => draft.id !== id);
  persistPendingArrangementDrafts(nextDrafts);
  return nextDrafts;
}
