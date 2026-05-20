import React from "react";
import {
  addDays,
  arrangementsStorageKey,
  arrangementStorageEvent,
  buildDateKey,
  getInitialArrangements,
  getPendingArrangementDrafts,
  isValidDateKey,
  isValidTimeValue,
  pendingArrangementDraftsStorageKey,
  persistArrangements,
  removePendingArrangementDraft,
  type ArrangementDraft,
  type ArrangementItem,
  type ArrangementStatus,
  type ArrangementTimeKind,
  type PendingArrangementDraft,
} from "@/arrangements/arrangementStorage";
import {
  findSimilarArrangementsWithAi,
  mergeSimilarArrangement,
  type SimilarArrangementMatch,
} from "@/arrangements/similarArrangements";
import { cn } from "@/lib/utils";
import { usePreferences } from "@/settings/preferences";

type ArrangementsProps = {
  onOpenMenu: () => void;
};

type ArrangementView = "list" | "calendar";
type ArrangementListSort = "created" | "time";

type CompletionToast = {
  item: ArrangementItem;
  previousStatus: ArrangementStatus;
};

type GentleReminderCandidate = {
  item: ArrangementItem;
  autoDismiss: boolean;
};

type ArrangementEditDraft = ArrangementDraft & {
  status: ArrangementStatus;
};

type ArrangementMergeSuggestion = {
  candidate: ArrangementItem;
  matches: SimilarArrangementMatch[];
  pendingDraftId?: string;
  persistedCandidateId?: string;
};

const reminderDismissedStorageKey =
  "arkme-demo.arrangement-reminder-dismissed";

function parseDateKey(dateKey: string) {
  if (!isValidDateKey(dateKey)) return null;
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function getTodayDateKey() {
  return buildDateKey(new Date());
}

function buildReminderDismissKey(item: ArrangementItem, dateKey: string) {
  return `${dateKey}:${item.id}`;
}

function getReminderDismissals() {
  if (typeof window === "undefined") return [];

  try {
    const storedValue = window.localStorage.getItem(reminderDismissedStorageKey);
    const parsedValue = storedValue ? JSON.parse(storedValue) : [];
    return Array.isArray(parsedValue)
      ? parsedValue.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function persistReminderDismissals(keys: string[]) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(reminderDismissedStorageKey, JSON.stringify(keys));
  } catch {
    // Reminder dismissal is a nicety; keep the app usable if storage is blocked.
  }
}

function getTimeMinutes(value: string) {
  if (!isValidTimeValue(value)) return null;
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function isTodayOverdueArrangement(item: ArrangementItem, now: Date) {
  if (item.status !== "pending") return false;
  if (item.dateKey !== buildDateKey(now)) return false;
  const startMinutes = getTimeMinutes(item.startTime);
  if (startMinutes === null) return false;
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  return startMinutes < currentMinutes;
}

function getGentleReminderCandidate(
  items: ArrangementItem[],
  dismissedKeys: string[],
  todayKey: string
): GentleReminderCandidate | null {
  const today = parseDateKey(todayKey);
  if (!today) return null;
  const dismissedSet = new Set(dismissedKeys);
  const candidates = items
    .filter(
      (item) =>
        item.status === "pending" &&
        item.dateKey === todayKey &&
        !dismissedSet.has(buildReminderDismissKey(item, todayKey))
    )
    .map((item) => {
      const itemDate = parseDateKey(item.dateKey);
      if (!itemDate) return null;
      const autoDismiss = isTodayOverdueArrangement(item, new Date());
      return { item, autoDismiss, priority: autoDismiss ? 0 : 1 };
    })
    .filter(
      (
        candidate
      ): candidate is GentleReminderCandidate & { priority: number } =>
        Boolean(candidate)
    )
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      if (a.item.startTime && b.item.startTime) {
        return a.item.startTime.localeCompare(b.item.startTime);
      }
      if (a.item.startTime && !b.item.startTime) return -1;
      if (!a.item.startTime && b.item.startTime) return 1;
      return b.item.createdAt - a.item.createdAt;
    });

  return candidates[0] ?? null;
}

function buildReadableDate(dateKey: string) {
  if (!isValidDateKey(dateKey)) return "";
  const [, month, day] = dateKey.split("-");
  return `${Number(month)}月${Number(day)}日`;
}

function buildTimeText(draft: ArrangementDraft, allDayText: string) {
  const manualText = draft.timeText.trim();
  if (!draft.dateKey) return manualText;

  const dateLabel = buildReadableDate(draft.dateKey);
  if (draft.timeKind === "allDay") return `${dateLabel} ${allDayText}`;
  if (draft.timeKind === "time" && draft.startTime) {
    return `${dateLabel} ${draft.startTime}`;
  }
  if (draft.timeKind === "timeRange" && draft.startTime && draft.endTime) {
    return `${dateLabel} ${draft.startTime}-${draft.endTime}`;
  }
  return manualText || dateLabel;
}

function sortArrangements(a: ArrangementItem, b: ArrangementItem) {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (a.dateKey && b.dateKey && a.dateKey !== b.dateKey) {
    return a.dateKey.localeCompare(b.dateKey);
  }
  if (a.startTime && b.startTime && a.startTime !== b.startTime) {
    return a.startTime.localeCompare(b.startTime);
  }
  return b.createdAt - a.createdAt;
}

function sortArrangementsByCreated(a: ArrangementItem, b: ArrangementItem) {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  return b.createdAt - a.createdAt;
}

function sortArrangementsByTime(a: ArrangementItem, b: ArrangementItem) {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (a.dateKey && !b.dateKey) return -1;
  if (!a.dateKey && b.dateKey) return 1;
  if (a.dateKey && b.dateKey && a.dateKey !== b.dateKey) {
    return a.dateKey.localeCompare(b.dateKey);
  }
  if (a.startTime && !b.startTime) return -1;
  if (!a.startTime && b.startTime) return 1;
  if (a.startTime && b.startTime && a.startTime !== b.startTime) {
    return a.startTime.localeCompare(b.startTime);
  }
  return b.createdAt - a.createdAt;
}

const todayDateKey = getTodayDateKey();

const emptyDraft: ArrangementDraft = {
  title: "",
  timeText: "",
  dateKey: "",
  startTime: "",
  endTime: "",
  timeKind: "none",
  peopleText: "",
  locationText: "",
  locationName: "",
  note: "",
};

function buildEditDraft(item: ArrangementItem): ArrangementEditDraft {
  return {
    title: item.title,
    timeText: item.timeText,
    dateKey: item.dateKey,
    startTime: item.startTime,
    endTime: item.endTime,
    timeKind: item.timeKind,
    peopleText: item.peopleText,
    locationText: item.locationText,
    locationName: item.locationName,
    note: item.note,
    status: item.status,
  };
}

function formatArrangementCreatedAt(timestamp: number) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

function formatArrangementTimeRange(item: ArrangementItem, allDayText: string) {
  if (item.timeKind === "allDay") return allDayText;
  if (item.timeKind === "timeRange" && item.startTime && item.endTime) {
    return `${item.startTime}-${item.endTime}`;
  }
  if (item.startTime) return item.startTime;
  return item.timeText || allDayText;
}

function buildCalendarCells(monthDate: Date, items: ArrangementItem[]) {
  const firstDay = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
  const startDate = addDays(firstDay, -firstDay.getDay());
  const itemMap = new Map<string, ArrangementItem[]>();
  items.forEach((item) => {
    if (!item.dateKey) return;
    itemMap.set(item.dateKey, [...(itemMap.get(item.dateKey) || []), item]);
  });

  return Array.from({ length: 42 }, (_, index) => {
    const date = addDays(startDate, index);
    const dateKey = buildDateKey(date);
    const dayItems = itemMap.get(dateKey) || [];
    return {
      dateKey,
      day: date.getDate(),
      inCurrentMonth: date.getMonth() === monthDate.getMonth(),
      items: dayItems,
      hasPending: dayItems.some((item) => item.status === "pending"),
      hasLater: dayItems.some((item) => item.status === "later"),
      hasPinned: dayItems.some((item) => item.pinned),
    };
  });
}

function groupArrangementsByLocation(items: ArrangementItem[], emptyLocation: string) {
  const groups = new Map<string, ArrangementItem[]>();
  items.forEach((item) => {
    const location = item.locationName || item.locationText || emptyLocation;
    groups.set(location, [...(groups.get(location) || []), item]);
  });
  return Array.from(groups.entries()).map(([location, groupItems]) => ({
    location,
    items: groupItems,
  }));
}

export default function Arrangements({ onOpenMenu }: ArrangementsProps) {
  const { t } = usePreferences();
  const [arrangements, setArrangements] = React.useState(getInitialArrangements);
  const [pendingDrafts, setPendingDrafts] = React.useState(
    getPendingArrangementDrafts
  );
  const [showCreateSheet, setShowCreateSheet] = React.useState(false);
  const [selectedArrangement, setSelectedArrangement] =
    React.useState<ArrangementItem | null>(null);
  const [draft, setDraft] = React.useState<ArrangementDraft>(emptyDraft);
  const [currentView, setCurrentView] = React.useState<ArrangementView>("list");
  const [listSort, setListSort] = React.useState<ArrangementListSort>("created");
  const [actionTarget, setActionTarget] = React.useState<ArrangementItem | null>(
    null
  );
  const [completionToast, setCompletionToast] =
    React.useState<CompletionToast | null>(null);
  const [completingArrangementIds, setCompletingArrangementIds] =
    React.useState<string[]>([]);
  const [detailEditRequest, setDetailEditRequest] = React.useState(0);
  const [mergeSuggestion, setMergeSuggestion] =
    React.useState<ArrangementMergeSuggestion | null>(null);
  const [checkingPendingDraftId, setCheckingPendingDraftId] =
    React.useState<string | null>(null);
  const completionAnimationTimeoutsRef = React.useRef<number[]>([]);
  const [dismissedReminderKeys, setDismissedReminderKeys] = React.useState(
    getReminderDismissals
  );
  const [selectedDateKey, setSelectedDateKey] = React.useState(todayDateKey);
  const [visibleMonth, setVisibleMonth] = React.useState(
    () => new Date(new Date().getFullYear(), new Date().getMonth(), 1)
  );
  const title = draft.title.trim();
  const pendingCount = arrangements.filter((item) => item.status === "pending").length;
  const laterCount = arrangements.filter((item) => item.status === "later").length;
  const visibleArrangements = React.useMemo(
    () => arrangements.filter((item) => item.status !== "completed"),
    [arrangements]
  );
  const pendingArrangements = React.useMemo(
    () => arrangements.filter((item) => item.status === "pending"),
    [arrangements]
  );
  const timedCount = visibleArrangements.filter((item) => item.dateKey).length;
  const sortedArrangements = React.useMemo(
    () =>
      [...pendingArrangements].sort(
        listSort === "time" ? sortArrangementsByTime : sortArrangementsByCreated
      ),
    [pendingArrangements, listSort]
  );
  const createdSortedArrangements = React.useMemo(
    () => [...visibleArrangements].sort(sortArrangementsByCreated),
    [visibleArrangements]
  );
  const calendarItems = React.useMemo(
    () => visibleArrangements.filter((item) => item.dateKey),
    [visibleArrangements]
  );
  const undatedArrangements = React.useMemo(
    () => createdSortedArrangements.filter((item) => !item.dateKey),
    [createdSortedArrangements]
  );
  const selectedDayArrangements = React.useMemo(
    () =>
      visibleArrangements
        .filter((item) => item.dateKey === selectedDateKey)
        .sort(sortArrangements),
    [visibleArrangements, selectedDateKey]
  );
  const gentleReminder = React.useMemo(
    () =>
      getGentleReminderCandidate(
        arrangements,
        dismissedReminderKeys,
        todayDateKey
      ),
    [arrangements, dismissedReminderKeys]
  );

  React.useEffect(() => {
    persistArrangements(arrangements);
  }, [arrangements]);

  React.useEffect(() => {
    if (typeof window === "undefined") return undefined;

    const refreshArrangements = () => {
      setArrangements(getInitialArrangements());
      setPendingDrafts(getPendingArrangementDrafts());
    };
    const refreshArrangementsFromStorage = (event: StorageEvent) => {
      if (
        event.key === arrangementsStorageKey ||
        event.key === pendingArrangementDraftsStorageKey
      ) {
        refreshArrangements();
      }
    };

    window.addEventListener(arrangementStorageEvent, refreshArrangements);
    window.addEventListener("storage", refreshArrangementsFromStorage);
    return () => {
      window.removeEventListener(arrangementStorageEvent, refreshArrangements);
      window.removeEventListener("storage", refreshArrangementsFromStorage);
    };
  }, []);

  React.useEffect(() => {
    if (!completionToast) return undefined;

    const timeoutId = window.setTimeout(() => {
      setCompletionToast(null);
    }, 3000);
    return () => window.clearTimeout(timeoutId);
  }, [completionToast]);

  React.useEffect(
    () => () => {
      completionAnimationTimeoutsRef.current.forEach((timeoutId) => {
        window.clearTimeout(timeoutId);
      });
    },
    []
  );

  const updateDraft = (key: keyof ArrangementDraft, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const closeCreateSheet = () => {
    setShowCreateSheet(false);
    setDraft(emptyDraft);
  };

  const finishPendingDraft = (pendingDraftId?: string) => {
    if (!pendingDraftId) return;
    removePendingArrangementDraft(pendingDraftId);
    setPendingDrafts(getPendingArrangementDrafts());
  };

  const publishArrangements = (items: ArrangementItem[]) => {
    persistArrangements(items);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event(arrangementStorageEvent));
    }
  };

  const addArrangement = (arrangement: ArrangementItem, pendingDraftId?: string) => {
    const nextArrangements = [arrangement, ...arrangements];
    setArrangements(nextArrangements);
    publishArrangements(nextArrangements);
    finishPendingDraft(pendingDraftId);
    return nextArrangements;
  };

  const createArrangement = () => {
    if (!title) return;

    const now = Date.now();
    const locationName = draft.locationName.trim() || draft.locationText.trim();
    const arrangement: ArrangementItem = {
      id: `manual-${now}`,
      title,
      timeText: buildTimeText(draft, t("arrangements.timeKindAllDay")),
      dateKey: draft.dateKey,
      startTime: draft.startTime,
      endTime: draft.endTime,
      timeKind: draft.dateKey ? draft.timeKind : "none",
      peopleText: draft.peopleText.trim(),
      locationText: locationName,
      locationName,
      note: draft.note.trim(),
      source: t("arrangements.manualSource"),
      status: "pending",
      createdAt: now,
      pinned: false,
    };
    addArrangement(arrangement);
    closeCreateSheet();

    void findSimilarArrangementsWithAi(arrangement, arrangements).then((matches) => {
      if (matches.length > 0) {
        setMergeSuggestion({
          candidate: arrangement,
          matches,
          persistedCandidateId: arrangement.id,
        });
      }
    });
  };

  const createArrangementFromSuggestion = () => {
    if (!mergeSuggestion) return;
    if (!mergeSuggestion.persistedCandidateId) {
      addArrangement(mergeSuggestion.candidate, mergeSuggestion.pendingDraftId);
    }
    setMergeSuggestion(null);
    closeCreateSheet();
  };

  const mergeArrangementFromSuggestion = (match: SimilarArrangementMatch) => {
    if (!mergeSuggestion) return;

    const mergedArrangement = mergeSimilarArrangement(
      match.arrangement,
      mergeSuggestion.candidate
    );
    const nextArrangements = arrangements
      .filter((item) => item.id !== mergeSuggestion.persistedCandidateId)
      .map((item) => (item.id === mergedArrangement.id ? mergedArrangement : item));
    setArrangements(nextArrangements);
    publishArrangements(nextArrangements);
    setSelectedArrangement((current) =>
      current?.id === mergedArrangement.id ? mergedArrangement : current
    );
    finishPendingDraft(mergeSuggestion.pendingDraftId);
    setMergeSuggestion(null);
    closeCreateSheet();
  };

  const updateArrangement = (updatedArrangement: ArrangementItem) => {
    setArrangements((current) =>
      current.map((item) =>
        item.id === updatedArrangement.id ? updatedArrangement : item
      )
    );
    setSelectedArrangement(updatedArrangement);
  };

  const toggleArrangementPin = (target: ArrangementItem) => {
    const updatedArrangement = { ...target, pinned: !target.pinned };
    setArrangements((current) =>
      current.map((item) =>
        item.id === target.id ? updatedArrangement : item
      )
    );
    setSelectedArrangement((current) =>
      current?.id === target.id ? updatedArrangement : current
    );
  };

  const deleteArrangement = (target: ArrangementItem) => {
    setArrangements((current) => current.filter((item) => item.id !== target.id));
    setSelectedArrangement((current) =>
      current?.id === target.id ? null : current
    );
    setActionTarget((current) => (current?.id === target.id ? null : current));
  };

  const updateArrangementStatus = (
    target: ArrangementItem,
    status: ArrangementStatus
  ) => {
    const updatedArrangement = { ...target, status };
    setArrangements((current) =>
      current.map((item) => (item.id === target.id ? updatedArrangement : item))
    );
    setSelectedArrangement((current) =>
      current?.id === target.id ? updatedArrangement : current
    );
    setActionTarget(null);
    return updatedArrangement;
  };

  const completeArrangement = (target: ArrangementItem) => {
    if (completingArrangementIds.includes(target.id)) return;

    setCompletingArrangementIds((current) =>
      current.includes(target.id) ? current : [...current, target.id]
    );
    setActionTarget((current) => (current?.id === target.id ? null : current));
    const timeoutId = window.setTimeout(() => {
      updateArrangementStatus(target, "completed");
      setCompletionToast({ item: target, previousStatus: target.status });
      setCompletingArrangementIds((current) =>
        current.filter((itemId) => itemId !== target.id)
      );
      completionAnimationTimeoutsRef.current =
        completionAnimationTimeoutsRef.current.filter((id) => id !== timeoutId);
    }, 220);
    completionAnimationTimeoutsRef.current = [
      ...completionAnimationTimeoutsRef.current,
      timeoutId,
    ];
  };

  const postponeArrangement = (target: ArrangementItem) => {
    updateArrangementStatus(target, "later");
  };

  const undoCompleteArrangement = () => {
    if (!completionToast) return;

    const restoredArrangement = {
      ...completionToast.item,
      status: completionToast.previousStatus,
    };
    setArrangements((current) =>
      current.map((item) =>
        item.id === restoredArrangement.id ? restoredArrangement : item
      )
    );
    setCompletingArrangementIds((current) =>
      current.filter((itemId) => itemId !== restoredArrangement.id)
    );
    setSelectedArrangement((current) =>
      current?.id === restoredArrangement.id ? restoredArrangement : current
    );
    setCompletionToast(null);
  };

  const rescheduleArrangement = (target: ArrangementItem) => {
    setActionTarget(null);
    setSelectedArrangement(target);
    setDetailEditRequest((current) => current + 1);
  };

  const dismissGentleReminder = (target: ArrangementItem) => {
    const dismissKey = buildReminderDismissKey(target, todayDateKey);
    setDismissedReminderKeys((current) => {
      if (current.includes(dismissKey)) return current;
      const nextKeys = [...current, dismissKey];
      persistReminderDismissals(nextKeys);
      return nextKeys;
    });
  };

  const viewGentleReminder = (target: ArrangementItem) => {
    dismissGentleReminder(target);
    setSelectedArrangement(target);
  };

  const postponeGentleReminder = (target: ArrangementItem) => {
    dismissGentleReminder(target);
    postponeArrangement(target);
  };

  const completeGentleReminder = (target: ArrangementItem) => {
    dismissGentleReminder(target);
    completeArrangement(target);
  };

  const acceptPendingDraft = async (draft: PendingArrangementDraft) => {
    if (checkingPendingDraftId) return;

    const now = Date.now();
    const arrangement: ArrangementItem = {
      id: `ai-${now}`,
      title: draft.title,
      timeText: draft.timeText,
      dateKey: draft.dateKey,
      startTime: draft.startTime,
      endTime: draft.endTime,
      timeKind: draft.dateKey ? draft.timeKind : "none",
      peopleText: draft.peopleText,
      locationText: draft.locationText,
      locationName: draft.locationName,
      note: draft.note,
      source: draft.source,
      status: "pending",
      createdAt: now,
      pinned: false,
      contexts: draft.contexts,
    };
    setCheckingPendingDraftId(draft.id);
    try {
      const matches = await findSimilarArrangementsWithAi(
        arrangement,
        arrangements
      );
      if (matches.length > 0) {
        setMergeSuggestion({
          candidate: arrangement,
          matches,
          pendingDraftId: draft.id,
        });
        return;
      }

      addArrangement(arrangement, draft.id);
    } finally {
      setCheckingPendingDraftId(null);
    }
  };

  const dismissPendingDraft = (draft: PendingArrangementDraft) => {
    removePendingArrangementDraft(draft.id);
    setPendingDrafts(getPendingArrangementDrafts());
  };

  React.useEffect(() => {
    if (!gentleReminder) return undefined;

    const timeoutId = window.setTimeout(() => {
      dismissGentleReminder(gentleReminder.item);
      const updatedArrangement = { ...gentleReminder.item, status: "later" as const };
      setArrangements((current) =>
        current.map((item) =>
          item.id === updatedArrangement.id ? updatedArrangement : item
        )
      );
      setSelectedArrangement((current) =>
        current?.id === updatedArrangement.id ? updatedArrangement : current
      );
      setActionTarget((current) =>
        current?.id === updatedArrangement.id ? null : current
      );
    }, 30000);
    return () => window.clearTimeout(timeoutId);
  }, [gentleReminder]);

  return (
    <div className="flex h-full flex-col bg-bg">
      <header className="flex h-14 shrink-0 items-center justify-between bg-bg px-4">
        <button
          type="button"
          className="flex h-10 w-10 items-center justify-center rounded-full text-text transition hover:bg-hover-overlay active:scale-[0.96]"
          onClick={onOpenMenu}
          aria-label={t("common.openMenu")}
        >
          <svg
            className="h-6 w-6"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            <path
              d="M5 7h9M5 12h14M5 17h7"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>
        <h1 className="text-lg font-semibold leading-none text-text">
          {t("arrangements.title")}
        </h1>
        <button
          type="button"
          className="flex h-10 w-10 items-center justify-center rounded-full text-text transition hover:bg-hover-overlay active:scale-[0.96]"
          aria-label={t("arrangements.add")}
          onClick={() => setShowCreateSheet(true)}
        >
          <svg
            className="h-5 w-5"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            <path
              d="M12 5v14M5 12h14"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        <section className="pt-2">
          <div className="grid grid-cols-3 gap-2">
            <ArrangementStat
              value={String(pendingCount)}
              label={t("arrangements.statPending")}
            />
            <ArrangementStat
              value={String(timedCount)}
              label={t("arrangements.statTimed")}
            />
            <ArrangementStat
              value={String(laterCount)}
              label={t("arrangements.statLater")}
            />
          </div>
        </section>

        {gentleReminder && (
          <GentleReminderCard
            candidate={gentleReminder}
            onView={() => viewGentleReminder(gentleReminder.item)}
            onComplete={() => completeGentleReminder(gentleReminder.item)}
            onLater={() => dismissGentleReminder(gentleReminder.item)}
            onPostpone={() => postponeGentleReminder(gentleReminder.item)}
          />
        )}

        {pendingDrafts.length > 0 && (
          <PendingArrangementDrafts
            drafts={pendingDrafts}
            checkingDraftId={checkingPendingDraftId}
            onAccept={acceptPendingDraft}
            onDismiss={dismissPendingDraft}
          />
        )}

        <section className="mt-4">
          <div className="flex h-9 items-center rounded-[10px] bg-surface-muted p-1">
            {([
              ["list", t("arrangements.viewList")],
              ["calendar", t("arrangements.viewCalendar")],
            ] as const).map(([view, label]) => (
              <button
                key={label}
                type="button"
                className={
                  currentView === view
                    ? "h-7 flex-1 rounded-[8px] bg-surface text-[13px] font-medium text-text shadow-sm"
                    : "h-7 flex-1 rounded-[8px] text-[13px] text-text-muted"
                }
                onClick={() => setCurrentView(view)}
              >
                {label}
              </button>
            ))}
          </div>
        </section>

        {currentView === "list" ? (
          <>
            <section className="mt-4">
              <div className="flex items-center justify-end">
                <div className="flex h-8 items-center rounded-full bg-surface-muted p-1">
                  {([
                    ["created", t("arrangements.sortCreated")],
                    ["time", t("arrangements.sortTime")],
                  ] as const).map(([sort, label]) => (
                    <button
                      key={sort}
                      type="button"
                      className={cn(
                        "h-6 rounded-full px-3 text-[12px] transition active:scale-[0.98]",
                        listSort === sort
                          ? "bg-surface font-medium text-text shadow-sm"
                          : "text-text-muted"
                      )}
                      onClick={() => setListSort(sort)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </section>
            <section className="mt-3 space-y-2.5">
              {sortedArrangements.map((item) => (
              <ArrangementCard
                key={item.id}
                item={item}
                isCompleting={completingArrangementIds.includes(item.id)}
                onOpen={() => setSelectedArrangement(item)}
                onComplete={() => completeArrangement(item)}
                onLongPress={() => setActionTarget(item)}
                  onTogglePin={() => toggleArrangementPin(item)}
                  onDelete={() => deleteArrangement(item)}
                />
              ))}
            </section>
          </>
        ) : (
          <CalendarArrangementView
            visibleMonth={visibleMonth}
            selectedDateKey={selectedDateKey}
            calendarItems={calendarItems}
            selectedDayItems={selectedDayArrangements}
            undatedItems={undatedArrangements}
            onChangeMonth={setVisibleMonth}
            onSelectDate={setSelectedDateKey}
            onOpenItem={setSelectedArrangement}
          />
        )}
      </main>

      {showCreateSheet && (
        <CreateArrangementSheet
          draft={draft}
          canSubmit={Boolean(title)}
          onChange={updateDraft}
          onClose={closeCreateSheet}
          onSubmit={createArrangement}
        />
      )}

      {mergeSuggestion && (
        <ArrangementMergeSuggestionSheet
          suggestion={mergeSuggestion}
          onCreateNew={createArrangementFromSuggestion}
          onMerge={mergeArrangementFromSuggestion}
        />
      )}

      {selectedArrangement && (
        <ArrangementDetailSheet
          item={selectedArrangement}
          onClose={() => setSelectedArrangement(null)}
          onSave={updateArrangement}
          editRequest={detailEditRequest}
        />
      )}

      {actionTarget && (
        <ArrangementActionSheet
          item={actionTarget}
          onClose={() => setActionTarget(null)}
          onPostpone={() => postponeArrangement(actionTarget)}
          onReschedule={() => rescheduleArrangement(actionTarget)}
          onComplete={() => completeArrangement(actionTarget)}
        />
      )}

      {completionToast && (
        <CompletionToastBar
          message={t("arrangements.completedToast")}
          undoLabel={t("arrangements.undo")}
          onUndo={undoCompleteArrangement}
        />
      )}
    </div>
  );
}

function PendingArrangementDrafts({
  drafts,
  checkingDraftId,
  onAccept,
  onDismiss,
}: {
  drafts: PendingArrangementDraft[];
  checkingDraftId: string | null;
  onAccept: (draft: PendingArrangementDraft) => void;
  onDismiss: (draft: PendingArrangementDraft) => void;
}) {
  return (
    <section className="mt-4 space-y-2.5">
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-semibold leading-5 text-text">
          待确认安排
        </h2>
        <span className="rounded-full bg-primary-soft px-2 py-1 text-[11px] font-semibold leading-4 text-primary">
          {drafts.length} 条
        </span>
      </div>
      {drafts.map((draft) => {
        const isCheckingDraft = checkingDraftId === draft.id;
        const isBusy = Boolean(checkingDraftId);

        return (
          <div
            key={draft.id}
            className="rounded-[14px] border border-[rgba(9,184,62,0.22)] bg-surface px-3 py-3 shadow-sm"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[15px] font-semibold leading-5 text-text">
                  {draft.title}
                </p>
                <p className="mt-1 text-[12px] leading-5 text-text-tertiary">
                  {[draft.timeText, draft.locationName, draft.peopleText]
                    .filter(Boolean)
                    .join(" · ") || "时间地点待确认"}
                </p>
              </div>
              <span className="shrink-0 rounded-full bg-primary-soft px-2 py-1 text-[11px] font-semibold leading-4 text-primary">
                {Math.round(draft.confidence * 100)}%
              </span>
            </div>
            {draft.note && (
              <p className="mt-2 rounded-[10px] bg-surface-muted px-2.5 py-2 text-[12px] leading-5 text-text-muted">
                {draft.note}
              </p>
            )}
            {draft.contexts[0] && (
              <p className="mt-2 line-clamp-2 text-[12px] leading-5 text-text-tertiary">
                来源：{draft.contexts[0]}
              </p>
            )}
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                type="button"
                className="h-9 rounded-[9px] border border-border bg-surface text-[13px] font-medium text-text-muted transition active:scale-[0.98] disabled:text-text-disabled"
                disabled={isBusy}
                onClick={() => onDismiss(draft)}
              >
                忽略
              </button>
              <button
                type="button"
                className="h-9 rounded-[9px] bg-primary text-[13px] font-semibold text-on-primary transition active:scale-[0.98] disabled:opacity-60"
                disabled={isBusy}
                onClick={() => onAccept(draft)}
              >
                {isCheckingDraft ? "判断中..." : "加入安排"}
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}

function ArrangementMergeSuggestionSheet({
  suggestion,
  onCreateNew,
  onMerge,
}: {
  suggestion: ArrangementMergeSuggestion;
  onCreateNew: () => void;
  onMerge: (match: SimilarArrangementMatch) => void;
}) {
  const candidateMeta =
    [
      suggestion.candidate.timeText,
      suggestion.candidate.locationName || suggestion.candidate.locationText,
      suggestion.candidate.peopleText,
    ]
      .filter(Boolean)
      .join(" · ") || "时间地点待确认";

  return (
    <div className="absolute inset-0 z-[60] flex items-end">
      <div className="absolute inset-0 bg-overlay" aria-hidden="true" />
      <section
        className="relative z-10 max-h-[88%] w-full overflow-y-auto rounded-t-[16px] border border-border-light bg-[var(--dialog-bg)] px-4 pb-4 pt-2.5 shadow-[0_-12px_36px_rgba(0,0,0,0.18)]"
        role="dialog"
        aria-modal="true"
        aria-label="可能相关安排"
      >
        <div className="mx-auto mb-3 h-1 w-9 rounded-full bg-fill-2" />
        <div className="rounded-[14px] border border-[rgba(9,184,62,0.22)] bg-primary-soft/50 px-3.5 py-3">
          <p className="text-[13px] font-semibold leading-5 text-primary">
            可能相关安排
          </p>
          <h2 className="mt-1 text-[17px] font-semibold leading-6 text-text">
            {suggestion.candidate.title}
          </h2>
          <p className="mt-1 text-[12px] leading-5 text-text-muted">
            {candidateMeta}
          </p>
        </div>

        <div className="mt-3 space-y-2.5">
          {suggestion.matches.map((match) => (
            <div
              key={match.arrangement.id}
              className="rounded-[14px] bg-surface px-3.5 py-3 shadow-sm"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[15px] font-semibold leading-5 text-text">
                    {match.arrangement.title}
                  </p>
                  <p className="mt-1 text-[12px] leading-5 text-text-tertiary">
                    {[
                      match.arrangement.timeText,
                      match.arrangement.locationName || match.arrangement.locationText,
                      match.arrangement.peopleText,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "时间地点待确认"}
                  </p>
                </div>
                <span className="shrink-0 rounded-full bg-surface-muted px-2 py-1 text-[11px] font-semibold leading-4 text-text-muted">
                  {Math.round(match.score * 100)}%
                </span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {match.reasons.map((reason) => (
                  <span
                    key={reason}
                    className="rounded-full bg-primary-soft px-2 py-0.5 text-[11px] leading-4 text-primary"
                  >
                    {reason}
                  </span>
                ))}
              </div>
              <button
                type="button"
                className="mt-3 h-9 w-full rounded-[9px] bg-primary text-[13px] font-semibold text-on-primary transition active:scale-[0.98]"
                onClick={() => onMerge(match)}
              >
                合并到已有安排
              </button>
            </div>
          ))}
        </div>

        <button
          type="button"
          className="mt-3 h-10 w-full rounded-[10px] border border-border bg-surface text-[13px] font-semibold text-text-muted transition active:scale-[0.98]"
          onClick={onCreateNew}
        >
          仍然创建新安排
        </button>
      </section>
    </div>
  );
}

function CalendarArrangementView({
  visibleMonth,
  selectedDateKey,
  calendarItems,
  selectedDayItems,
  undatedItems,
  onChangeMonth,
  onSelectDate,
  onOpenItem,
}: {
  visibleMonth: Date;
  selectedDateKey: string;
  calendarItems: ArrangementItem[];
  selectedDayItems: ArrangementItem[];
  undatedItems: ArrangementItem[];
  onChangeMonth: (date: Date) => void;
  onSelectDate: (dateKey: string) => void;
  onOpenItem: (item: ArrangementItem) => void;
}) {
  const { t } = usePreferences();
  const calendarCells = React.useMemo(
    () => buildCalendarCells(visibleMonth, calendarItems),
    [calendarItems, visibleMonth]
  );
  const monthLabel = `${visibleMonth.getFullYear()}-${String(
    visibleMonth.getMonth() + 1
  ).padStart(2, "0")}`;
  const selectedLabel =
    selectedDateKey === todayDateKey
      ? t("arrangements.todayLabel")
      : selectedDateKey;
  const groupedDayItems = React.useMemo(
    () => groupArrangementsByLocation(selectedDayItems, t("arrangements.noLocation")),
    [selectedDayItems, t]
  );

  const moveMonth = (direction: -1 | 1) => {
    onChangeMonth(
      new Date(
        visibleMonth.getFullYear(),
        visibleMonth.getMonth() + direction,
        1
      )
    );
  };

  return (
    <section className="mt-4 space-y-3">
      <div className="rounded-[12px] bg-surface px-3 py-3 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
        <div className="flex items-center justify-between">
          <button
            type="button"
            className="flex h-8 w-8 items-center justify-center rounded-full text-text-muted transition hover:bg-hover-overlay active:scale-[0.96]"
            onClick={() => moveMonth(-1)}
            aria-label={t("arrangements.prevMonth")}
          >
            <span aria-hidden="true">‹</span>
          </button>
          <p className="text-[15px] font-semibold leading-5 text-text">
            {monthLabel}
          </p>
          <button
            type="button"
            className="flex h-8 w-8 items-center justify-center rounded-full text-text-muted transition hover:bg-hover-overlay active:scale-[0.96]"
            onClick={() => moveMonth(1)}
            aria-label={t("arrangements.nextMonth")}
          >
            <span aria-hidden="true">›</span>
          </button>
        </div>

        <div className="mt-3 grid grid-cols-7 text-center text-[11px] leading-4 text-text-tertiary">
          {[
            t("arrangements.weekSun"),
            t("arrangements.weekMon"),
            t("arrangements.weekTue"),
            t("arrangements.weekWed"),
            t("arrangements.weekThu"),
            t("arrangements.weekFri"),
            t("arrangements.weekSat"),
          ].map((label) => (
            <span key={label}>{label}</span>
          ))}
        </div>

        <div className="mt-2 grid grid-cols-7 gap-1">
          {calendarCells.map((cell) => {
            const isSelected = cell.dateKey === selectedDateKey;
            const isToday = cell.dateKey === todayDateKey;
            return (
              <button
                key={cell.dateKey}
                type="button"
                className={cn(
                  "min-h-[54px] rounded-[10px] px-1.5 py-1.5 text-left transition active:scale-[0.98]",
                  isSelected
                    ? "bg-primary-soft text-primary"
                    : "bg-surface-muted text-text",
                  !cell.inCurrentMonth && "opacity-40"
                )}
                onClick={() => onSelectDate(cell.dateKey)}
              >
                <span
                  className={cn(
                    "flex h-5 w-5 items-center justify-center rounded-full text-[12px] font-medium leading-5",
                    isToday && !isSelected && "bg-surface text-primary"
                  )}
                >
                  {cell.day}
                </span>
                {cell.items.length > 0 && (
                  <div className="mt-1 flex items-center gap-1">
                    {cell.hasPending && (
                      <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                    )}
                    {cell.hasLater && (
                      <span className="h-1.5 w-1.5 rounded-full bg-text-tertiary" />
                    )}
                    {cell.hasPinned && (
                      <span className="h-1.5 w-1.5 rounded-full bg-[#D6A23A]" />
                    )}
                    <span className="ml-auto text-[10px] leading-4 text-text-tertiary">
                      {cell.items.length}
                    </span>
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="rounded-[12px] bg-surface px-3.5 py-3 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[15px] font-semibold leading-5 text-text">
              {t("arrangements.dayFlow")}
            </p>
            <p className="mt-0.5 text-[12px] leading-4 text-text-tertiary">
              {selectedLabel}
            </p>
          </div>
          <span className="rounded-full bg-surface-muted px-2 py-1 text-[11px] leading-4 text-text-muted">
            {selectedDayItems.length}
          </span>
        </div>

        {groupedDayItems.length > 0 ? (
          <div className="mt-3 space-y-3">
            {groupedDayItems.map((group) => (
              <div key={group.location} className="space-y-2">
                <p className="text-[12px] font-medium leading-4 text-text-muted">
                  {group.location}
                </p>
                {group.items.map((item) => (
                  <TimelineArrangementButton
                    key={item.id}
                    item={item}
                    onOpen={() => onOpenItem(item)}
                  />
                ))}
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-3 rounded-[10px] bg-surface-muted px-3 py-3 text-[13px] leading-5 text-text-muted">
            {t("arrangements.dayEmpty")}
          </p>
        )}
      </div>

      <div className="rounded-[12px] bg-surface px-3.5 py-3 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
        <div className="flex items-center justify-between">
          <p className="text-[15px] font-semibold leading-5 text-text">
            {t("arrangements.undatedTitle")}
          </p>
          <span className="rounded-full bg-surface-muted px-2 py-1 text-[11px] leading-4 text-text-muted">
            {undatedItems.length}
          </span>
        </div>
        {undatedItems.length > 0 ? (
          <div className="mt-3 space-y-2">
            {undatedItems.slice(0, 3).map((item) => (
              <TimelineArrangementButton
                key={item.id}
                item={item}
                onOpen={() => onOpenItem(item)}
              />
            ))}
          </div>
        ) : (
          <p className="mt-2 text-[13px] leading-5 text-text-tertiary">
            {t("arrangements.undatedEmpty")}
          </p>
        )}
      </div>
    </section>
  );
}

function TimelineArrangementButton({
  item,
  onOpen,
}: {
  item: ArrangementItem;
  onOpen: () => void;
}) {
  const { t } = usePreferences();
  return (
    <button
      type="button"
      className="flex w-full items-start gap-3 rounded-[10px] bg-surface-muted px-3 py-2.5 text-left transition hover:bg-hover-overlay active:scale-[0.99]"
      onClick={onOpen}
    >
      <span className="w-[54px] shrink-0 text-[12px] font-medium leading-5 text-primary">
        {formatArrangementTimeRange(item, t("arrangements.timeKindAllDay"))}
      </span>
      <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-primary-soft ring-1 ring-primary/30" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-medium leading-5 text-text">
          {item.title}
        </span>
        <span className="mt-0.5 block truncate text-[12px] leading-4 text-text-muted">
          {[item.peopleText, item.locationName || item.locationText]
            .filter(Boolean)
            .join(" · ") || t("arrangements.noPeople")}
        </span>
      </span>
    </button>
  );
}

function GentleReminderCard({
  candidate,
  onView,
  onComplete,
  onLater,
  onPostpone,
}: {
  candidate: GentleReminderCandidate;
  onView: () => void;
  onComplete: () => void;
  onLater: () => void;
  onPostpone: () => void;
}) {
  const { t } = usePreferences();
  const { item } = candidate;
  const location = item.locationName || item.locationText;
  const messageTemplate = t("arrangements.reminderToday");
  const message = messageTemplate
    .replace("{title}", item.title)
    .replace("{location}", location || t("arrangements.noLocation"));

  return (
    <section className="mt-3 rounded-[14px] border border-primary/10 bg-primary-soft/60 px-3.5 py-3 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <div className="flex items-start gap-3">
        <span className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface text-primary">
          <svg
            className="h-4 w-4"
            viewBox="0 0 16 16"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            <path
              d="M8 2.5v2.2M8 11.3v2.2M3.4 4.2 5 5.7M11 10.3l1.6 1.5M2.5 8h2.2M11.3 8h2.2M3.4 11.8 5 10.3M11 5.7l1.6-1.5"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-medium leading-4 text-primary">
            {t("arrangements.reminderKicker")}
          </p>
          <p className="mt-1 text-[14px] leading-5 text-text">{message}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className="h-8 rounded-full bg-surface px-3 text-[12px] font-medium text-text shadow-sm transition active:scale-[0.98]"
              onClick={onView}
            >
              {t("arrangements.reminderView")}
            </button>
            <button
              type="button"
              className="h-8 rounded-full bg-primary px-3 text-[12px] font-medium text-white shadow-sm transition active:scale-[0.98]"
              onClick={onComplete}
            >
              {t("arrangements.markComplete")}
            </button>
            <button
              type="button"
              className="h-8 rounded-full bg-surface/70 px-3 text-[12px] font-medium text-text-muted transition active:scale-[0.98]"
              onClick={onLater}
            >
              {t("arrangements.reminderLater")}
            </button>
            <button
              type="button"
              className="h-8 rounded-full bg-surface/70 px-3 text-[12px] font-medium text-text-muted transition active:scale-[0.98]"
              onClick={onPostpone}
            >
              {t("arrangements.actionLater")}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function ArrangementActionSheet({
  item,
  onClose,
  onPostpone,
  onReschedule,
  onComplete,
}: {
  item: ArrangementItem;
  onClose: () => void;
  onPostpone: () => void;
  onReschedule: () => void;
  onComplete: () => void;
}) {
  const { t } = usePreferences();

  return (
    <div className="absolute inset-0 z-50 flex items-end">
      <button
        type="button"
        className="absolute inset-0 bg-overlay"
        onClick={onClose}
        aria-label={t("arrangements.closeActions")}
      />
      <section
        className="relative z-10 w-full overflow-hidden rounded-t-[16px] border border-border-light bg-[var(--dialog-bg)] px-4 pb-4 pt-2.5 shadow-[0_-12px_36px_rgba(0,0,0,0.18)]"
        role="dialog"
        aria-modal="true"
        aria-label={t("arrangements.actionTitle")}
      >
        <div className="mx-auto mb-3 h-1 w-9 rounded-full bg-fill-2" />
        <div className="mb-3 rounded-[12px] bg-surface-muted px-3.5 py-3">
          <p className="truncate text-[15px] font-medium leading-5 text-text">
            {item.title}
          </p>
          <p className="mt-1 text-[12px] leading-4 text-text-muted">
            {t("arrangements.actionHint")}
          </p>
        </div>
        <div className="space-y-2">
          <ActionSheetButton onClick={onPostpone}>
            {t("arrangements.actionLater")}
          </ActionSheetButton>
          <ActionSheetButton onClick={onReschedule}>
            {t("arrangements.actionReschedule")}
          </ActionSheetButton>
          <ActionSheetButton onClick={onComplete}>
            {t("arrangements.markComplete")}
          </ActionSheetButton>
        </div>
      </section>
    </div>
  );
}

function ActionSheetButton({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="h-11 w-full rounded-[12px] bg-surface text-[15px] font-medium text-text transition hover:bg-hover-overlay active:scale-[0.99]"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function CompletionToastBar({
  message,
  undoLabel,
  onUndo,
}: {
  message: string;
  undoLabel: string;
  onUndo: () => void;
}) {
  return (
    <div className="absolute inset-x-4 bottom-5 z-[60] flex items-center justify-between rounded-[14px] bg-[rgba(30,35,32,0.92)] px-4 py-3 text-white shadow-[0_10px_28px_rgba(0,0,0,0.2)]">
      <span className="text-[14px] font-medium leading-5">{message}</span>
      <button
        type="button"
        className="ml-4 rounded-full bg-white/12 px-3 py-1 text-[13px] font-medium leading-5 text-white transition active:scale-[0.96]"
        onClick={onUndo}
      >
        {undoLabel}
      </button>
    </div>
  );
}

function ArrangementStat({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-[12px] bg-surface px-3 py-2.5 text-center shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <p className="text-[20px] font-semibold leading-6 text-text">{value}</p>
      <p className="mt-1 truncate text-[11px] leading-4 text-text-muted">
        {label}
      </p>
    </div>
  );
}

function ArrangementCard({
  item,
  isCompleting,
  onOpen,
  onComplete,
  onLongPress,
  onTogglePin,
  onDelete,
}: {
  item: ArrangementItem;
  isCompleting: boolean;
  onOpen: () => void;
  onComplete: () => void;
  onLongPress: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
}) {
  const { t } = usePreferences();
  const [dragOffset, setDragOffset] = React.useState(0);
  const [swipePhase, setSwipePhase] = React.useState<
    "idle" | "dragging" | "snapping"
  >("idle");
  const dragOffsetRef = React.useRef(0);
  const dragStartXRef = React.useRef(0);
  const dragInitialOffsetRef = React.useRef(0);
  const draggingRef = React.useRef(false);
  const suppressClickRef = React.useRef(false);
  const longPressTimerRef = React.useRef<number | null>(null);
  const isLater = item.status === "later";
  const metaParts = [
    item.timeText,
    item.peopleText,
    item.locationName || item.locationText,
  ].filter(Boolean);
  const metaText = metaParts.length > 0 ? metaParts.join(" · ") : t("arrangements.noTime");
  const actionWidth = 132;
  const swipeOpenThreshold = actionWidth / 2;

  const clearLongPressTimer = () => {
    if (longPressTimerRef.current === null) return;
    window.clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
  };

  React.useEffect(() => clearLongPressTimer, []);

  const updateDragOffset = (value: number) => {
    dragOffsetRef.current = value;
    setDragOffset(value);
  };

  const snapDragOffset = (value: number) =>
    Math.abs(value) >= swipeOpenThreshold ? -actionWidth : 0;

  const setClosed = () => {
    setSwipePhase("snapping");
    updateDragOffset(0);
    draggingRef.current = false;
  };

  const finishDrag = (forceClose = false) => {
    const nextOffset = forceClose ? 0 : snapDragOffset(dragOffsetRef.current);
    setSwipePhase("snapping");
    updateDragOffset(nextOffset);
    draggingRef.current = false;
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (isCompleting) return;

    event.currentTarget.setPointerCapture(event.pointerId);
    dragStartXRef.current = event.clientX;
    dragInitialOffsetRef.current = dragOffsetRef.current;
    draggingRef.current = false;
    clearLongPressTimer();
    longPressTimerRef.current = window.setTimeout(() => {
      suppressClickRef.current = true;
      draggingRef.current = false;
      setClosed();
      onLongPress();
    }, 500);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (isCompleting) return;

    const deltaX = event.clientX - dragStartXRef.current;
    const nextOffset = Math.max(
      -actionWidth,
      Math.min(0, dragInitialOffsetRef.current + deltaX)
    );
    if (Math.abs(deltaX) < 8 && !draggingRef.current) return;

    clearLongPressTimer();
    draggingRef.current = true;
    suppressClickRef.current = true;
    setSwipePhase("dragging");
    updateDragOffset(nextOffset);
  };

  const handlePointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    clearLongPressTimer();
    if (!draggingRef.current) {
      if (dragOffsetRef.current !== 0 && dragOffsetRef.current !== -actionWidth) {
        finishDrag();
      }
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      return;
    }

    finishDrag();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleLostPointerCapture = () => {
    clearLongPressTimer();
    if (draggingRef.current) {
      finishDrag();
      return;
    }
    if (dragOffsetRef.current !== 0 && dragOffsetRef.current !== -actionWidth) {
      finishDrag();
    }
  };

  const handleOpen = () => {
    if (isCompleting) return;

    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }

    if (dragOffsetRef.current !== 0) {
      setClosed();
      return;
    }

    setClosed();
    onOpen();
  };

  const handleComplete = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    clearLongPressTimer();
    setClosed();
    onComplete();
  };

  const handleTogglePin = () => {
    setClosed();
    onTogglePin();
  };

  const handleDelete = () => {
    setClosed();
    onDelete();
  };

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-[12px] transition-[opacity,transform] duration-200 ease-out",
        isCompleting
          ? "pointer-events-none scale-95 opacity-0"
          : "scale-100 opacity-100"
      )}
    >
      <div className="absolute inset-y-0 right-0 flex items-stretch overflow-hidden rounded-[12px]">
        <button
          type="button"
          className="w-[66px] bg-primary-soft text-[12px] font-medium text-primary transition active:brightness-95"
          onClick={handleTogglePin}
        >
          {item.pinned ? t("arrangements.unpin") : t("arrangements.pin")}
        </button>
        <button
          type="button"
          className="w-[66px] bg-[var(--danger)] text-[12px] font-medium text-white transition active:brightness-95"
          onClick={handleDelete}
        >
          {t("arrangements.delete")}
        </button>
      </div>
      <div
        role="button"
        tabIndex={0}
        className={cn(
          "relative block w-full rounded-[12px] border border-border-light bg-surface px-3.5 py-3 text-left shadow-[0_1px_2px_rgba(15,23,42,0.04)] hover:bg-[var(--record-card-hover-bg)] active:scale-[0.99]",
          swipePhase === "dragging"
            ? "transition-[background]"
            : "transition-[background,transform] duration-150 ease-out"
        )}
        style={{ transform: `translateX(${dragOffset}px)` }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onLostPointerCapture={handleLostPointerCapture}
        onTransitionEnd={(event) => {
          if (event.propertyName === "transform") {
            setSwipePhase("idle");
          }
        }}
        onClick={handleOpen}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          handleOpen();
        }}
        aria-label={`${t("arrangements.openDetail")}：${item.title}`}
      >
        <div className="flex items-start gap-3">
          <button
            type="button"
            className={cn(
              "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition active:scale-95",
              isLater
                ? "border-border bg-surface-muted text-text-muted"
                : "border-primary/40 bg-primary-soft/70 text-primary"
            )}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={handleComplete}
            aria-label={`${t("arrangements.markComplete")}：${item.title}`}
          >
            <span className="h-2.5 w-2.5 rounded-full bg-current opacity-40" />
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex items-start gap-2">
              <h2 className="min-w-0 flex-1 truncate text-[15px] font-medium leading-5 text-text">
                {item.title}
              </h2>
              {item.pinned && (
                <span className="shrink-0 rounded-full bg-primary-soft px-2 py-0.5 text-[10px] leading-4 text-primary">
                  {t("arrangements.pinned")}
                </span>
              )}
              {isLater && (
                <span className="shrink-0 rounded-full bg-surface-muted px-2 py-0.5 text-[10px] leading-4 text-text-muted">
                  {t("arrangements.statusLater")}
                </span>
              )}
            </div>
            <p className="mt-1 truncate text-xs leading-4 text-text-muted">
              {metaText}
            </p>
            {item.note && (
              <p className="mt-2 line-clamp-2 text-xs leading-5 text-text-muted">
                {item.note}
              </p>
            )}
            <p className="mt-2 text-[11px] leading-4 text-text-tertiary">
              {item.source}
            </p>
          </div>
          <svg
            className="mt-1 h-4 w-4 shrink-0 text-text-tertiary"
            viewBox="0 0 16 16"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            <path
              d="M6 4L10 8L6 12"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      </div>
    </div>
  );
}

function ArrangementDetailSheet({
  item,
  onClose,
  onSave,
  editRequest,
}: {
  item: ArrangementItem;
  onClose: () => void;
  onSave: (item: ArrangementItem) => void;
  editRequest: number;
}) {
  const { t } = usePreferences();
  const [isEditing, setIsEditing] = React.useState(false);
  const [editDraft, setEditDraft] = React.useState<ArrangementEditDraft>(() =>
    buildEditDraft(item)
  );
  const visibleItem = isEditing
    ? {
        ...item,
        title: editDraft.title,
        timeText: buildTimeText(editDraft, t("arrangements.timeKindAllDay")),
        dateKey: editDraft.dateKey,
        startTime: editDraft.startTime,
        endTime: editDraft.endTime,
        timeKind: editDraft.dateKey ? editDraft.timeKind : "none",
        peopleText: editDraft.peopleText,
        locationText: editDraft.locationName || editDraft.locationText,
        locationName: editDraft.locationName || editDraft.locationText,
        note: editDraft.note,
        status: editDraft.status,
      }
    : item;
  const isLater = visibleItem.status === "later";
  const statusLabel =
    visibleItem.status === "completed"
      ? t("arrangements.statusCompleted")
      : isLater
        ? t("arrangements.statusLater")
        : t("arrangements.statusPending");
  const canSave = editDraft.title.trim().length > 0;
  const contexts = (visibleItem.contexts || []).filter(Boolean);
  const detailRows = [
    {
      label: t("arrangements.fieldTime"),
      value: visibleItem.timeText || t("arrangements.noTime"),
    },
    {
      label: t("arrangements.fieldDate"),
      value: visibleItem.dateKey || t("arrangements.undatedTitle"),
    },
    {
      label: t("arrangements.fieldPeople"),
      value: visibleItem.peopleText || t("arrangements.noPeople"),
    },
    {
      label: t("arrangements.fieldLocation"),
      value:
        visibleItem.locationName ||
        visibleItem.locationText ||
        t("arrangements.noLocation"),
    },
    {
      label: t("arrangements.detailStatus"),
      value: statusLabel,
    },
    {
      label: t("arrangements.detailPin"),
      value: visibleItem.pinned
        ? t("arrangements.pinned")
        : t("arrangements.notPinned"),
    },
    {
      label: t("arrangements.detailSource"),
      value: visibleItem.source,
    },
    {
      label: t("arrangements.detailCreatedAt"),
      value: formatArrangementCreatedAt(visibleItem.createdAt),
    },
  ];

  React.useEffect(() => {
    setEditDraft(buildEditDraft(item));
    setIsEditing(false);
  }, [item]);

  React.useEffect(() => {
    if (editRequest <= 0) return;
    setEditDraft(buildEditDraft(item));
    setIsEditing(true);
  }, [editRequest, item]);

  const updateEditDraft = (key: keyof ArrangementEditDraft, value: string) => {
    setEditDraft((current) => ({ ...current, [key]: value }));
  };

  const cancelEditing = () => {
    setEditDraft(buildEditDraft(item));
    setIsEditing(false);
  };

  const saveEditing = () => {
    if (!canSave) return;

    const locationName =
      editDraft.locationName.trim() || editDraft.locationText.trim();
    onSave({
      ...item,
      title: editDraft.title.trim(),
      timeText: buildTimeText(editDraft, t("arrangements.timeKindAllDay")),
      dateKey: editDraft.dateKey,
      startTime: editDraft.startTime,
      endTime: editDraft.endTime,
      timeKind: editDraft.dateKey ? editDraft.timeKind : "none",
      peopleText: editDraft.peopleText.trim(),
      locationText: locationName,
      locationName,
      note: editDraft.note.trim(),
      status: editDraft.status,
    });
    setIsEditing(false);
  };

  return (
    <div className="absolute inset-0 z-50 flex items-end">
      <button
        type="button"
        className="absolute inset-0 bg-overlay"
        onClick={onClose}
        aria-label={t("arrangements.closeDetail")}
      />
      <section
        className="relative z-10 flex max-h-[88%] w-full flex-col overflow-hidden rounded-t-[16px] border border-border-light bg-[var(--dialog-bg)] shadow-[0_-12px_36px_rgba(0,0,0,0.18)]"
        role="dialog"
        aria-modal="true"
        aria-label={t("arrangements.detailTitle")}
      >
        <header className="shrink-0 border-b border-border-light px-4 pb-3 pt-2.5">
          <div className="mx-auto mb-2 h-1 w-9 rounded-full bg-fill-2" />
          <div className="flex items-center gap-2">
            {isEditing ? (
              <button
                type="button"
                className="h-9 rounded-full px-1 text-sm text-text-muted transition active:scale-[0.96]"
                onClick={cancelEditing}
              >
                {t("search.cancel")}
              </button>
            ) : (
              <button
                type="button"
                className="h-9 rounded-full px-1 text-sm text-text-muted transition active:scale-[0.96]"
                onClick={() => setIsEditing(true)}
              >
                {t("arrangements.edit")}
              </button>
            )}
            <div className="min-w-0 flex-1" aria-hidden="true" />
            <button
              type="button"
              className={cn(
                "h-9 rounded-full px-1 text-sm font-medium transition active:scale-[0.96]",
                isEditing && !canSave ? "text-text-disabled" : "text-primary"
              )}
              disabled={isEditing && !canSave}
              onClick={isEditing ? saveEditing : onClose}
            >
              {isEditing ? t("arrangements.save") : t("common.done")}
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {isEditing ? (
            <ArrangementEditForm
              draft={editDraft}
              onChange={updateEditDraft}
            />
          ) : (
            <>
              <section className="rounded-[12px] bg-surface-muted px-3.5 py-3">
                <div className="flex items-start gap-3">
                  <span
                    className={cn(
                      "mt-1 h-2.5 w-2.5 shrink-0 rounded-full border",
                      isLater
                        ? "border-border bg-surface-muted text-text-muted"
                        : "border-primary/40 bg-primary-soft/70 text-primary"
                    )}
                    aria-hidden="true"
                  />
                  <h3 className="min-w-0 flex-1 text-[18px] font-semibold leading-6 text-text">
                    {visibleItem.title}
                  </h3>
                  {visibleItem.pinned && (
                    <span className="shrink-0 rounded-full bg-primary-soft px-2 py-0.5 text-[10px] leading-4 text-primary">
                      {t("arrangements.pinned")}
                    </span>
                  )}
                </div>
                {visibleItem.note && (
                  <p className="mt-3 whitespace-pre-wrap text-[14px] leading-6 text-text-muted">
                    {visibleItem.note}
                  </p>
                )}
              </section>

              <section className="mt-3 overflow-hidden rounded-[12px] bg-surface">
                {detailRows.map((row, index) => (
                  <div
                    key={row.label}
                    className={cn(
                      "flex items-start gap-4 px-3.5 py-3",
                      index > 0 && "border-t border-border-light"
                    )}
                  >
                    <p className="w-[72px] shrink-0 text-[13px] leading-5 text-text-tertiary">
                      {row.label}
                    </p>
                    <p className="min-w-0 flex-1 whitespace-pre-wrap text-[14px] leading-5 text-text">
                      {row.value}
                    </p>
                  </div>
                ))}
              </section>

              {contexts.length > 0 && (
                <section className="mt-3 rounded-[12px] bg-surface px-3.5 py-3">
                  <div className="flex items-center justify-between">
                    <p className="text-[14px] font-semibold leading-5 text-text">
                      相关上下文
                    </p>
                    <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] leading-4 text-text-muted">
                      {contexts.length} 条
                    </span>
                  </div>
                  <div className="mt-2 space-y-2">
                    {contexts.map((context, index) => (
                      <p
                        key={`${index}-${context}`}
                        className="whitespace-pre-wrap rounded-[10px] bg-surface-muted px-3 py-2 text-[12px] leading-5 text-text-muted"
                      >
                        {context}
                      </p>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}

function ArrangementEditForm({
  draft,
  onChange,
}: {
  draft: ArrangementEditDraft;
  onChange: (key: keyof ArrangementEditDraft, value: string) => void;
}) {
  const { t } = usePreferences();

  return (
    <div className="space-y-3">
      <ArrangementField
        autoFocus
        label={t("arrangements.fieldTitle")}
        value={draft.title}
        placeholder={t("arrangements.fieldTitlePlaceholder")}
        onChange={(value) => onChange("title", value)}
      />
      <ArrangementField
        label={t("arrangements.fieldDate")}
        value={draft.dateKey}
        placeholder="YYYY-MM-DD"
        inputType="date"
        onChange={(value) => onChange("dateKey", value)}
      />
      <ArrangementTimeKindFields
        draft={draft}
        onChange={onChange}
      />
      <ArrangementField
        label={t("arrangements.fieldPeople")}
        value={draft.peopleText}
        placeholder={t("arrangements.fieldPeoplePlaceholder")}
        onChange={(value) => onChange("peopleText", value)}
      />
      <ArrangementField
        label={t("arrangements.fieldLocation")}
        value={draft.locationName || draft.locationText}
        placeholder={t("arrangements.fieldLocationPlaceholder")}
        onChange={(value) => onChange("locationName", value)}
      />
      <section className="rounded-[12px] bg-surface-muted px-3 py-2.5">
        <p className="text-xs font-medium leading-4 text-text-muted">
          {t("arrangements.detailStatus")}
        </p>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {(["pending", "later"] as ArrangementStatus[]).map((status) => {
            const active = draft.status === status;
            return (
              <button
                key={status}
                type="button"
                className={cn(
                  "h-9 rounded-[10px] border text-[13px] transition active:scale-[0.98]",
                  active
                    ? "border-primary bg-primary-soft text-primary"
                    : "border-border-light bg-surface text-text-muted"
                )}
                onClick={() => onChange("status", status)}
              >
                {status === "pending"
                  ? t("arrangements.statusPending")
                  : t("arrangements.statusLater")}
              </button>
            );
          })}
        </div>
      </section>
      <label className="block rounded-[12px] bg-surface-muted px-3 py-2.5">
        <span className="text-xs font-medium leading-4 text-text-muted">
          {t("arrangements.fieldNote")}
        </span>
        <textarea
          value={draft.note}
          onChange={(event) => onChange("note", event.target.value)}
          placeholder={t("arrangements.fieldNotePlaceholder")}
          className="mt-1.5 h-24 w-full resize-none bg-transparent text-[15px] leading-5 text-text outline-none placeholder:text-input-placeholder"
        />
      </label>
    </div>
  );
}

function CreateArrangementSheet({
  draft,
  canSubmit,
  onChange,
  onClose,
  onSubmit,
}: {
  draft: ArrangementDraft;
  canSubmit: boolean;
  onChange: (key: keyof ArrangementDraft, value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const { t } = usePreferences();

  return (
    <div className="absolute inset-0 z-50 flex items-end">
      <button
        type="button"
        className="absolute inset-0 bg-overlay"
        onClick={onClose}
        aria-label={t("arrangements.closeCreate")}
      />
      <section
        className="relative z-10 flex max-h-[88%] w-full flex-col overflow-hidden rounded-t-[16px] border border-border-light bg-[var(--dialog-bg)] shadow-[0_-12px_36px_rgba(0,0,0,0.18)]"
        role="dialog"
        aria-modal="true"
        aria-label={t("arrangements.createTitle")}
      >
        <header className="shrink-0 border-b border-border-light px-4 pb-3 pt-2.5">
          <div className="mx-auto mb-2 h-1 w-9 rounded-full bg-fill-2" />
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="h-9 rounded-full px-1 text-sm text-text-muted transition active:scale-[0.96]"
              onClick={onClose}
            >
              {t("search.cancel")}
            </button>
            <h2 className="min-w-0 flex-1 text-center text-[16px] font-semibold leading-5 text-text">
              {t("arrangements.createTitle")}
            </h2>
            <button
              type="button"
              className={cn(
                "h-9 rounded-full px-1 text-sm font-medium transition active:scale-[0.96]",
                canSubmit ? "text-primary" : "text-text-disabled"
              )}
              disabled={!canSubmit}
              onClick={onSubmit}
            >
              {t("common.done")}
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
          <ArrangementField
            autoFocus
            label={t("arrangements.fieldTitle")}
            value={draft.title}
            placeholder={t("arrangements.fieldTitlePlaceholder")}
            onChange={(value) => onChange("title", value)}
          />
          <ArrangementField
            label={t("arrangements.fieldDate")}
            value={draft.dateKey}
            placeholder="YYYY-MM-DD"
            inputType="date"
            onChange={(value) => onChange("dateKey", value)}
          />
          <ArrangementTimeKindFields
            draft={draft}
            onChange={onChange}
          />
          <ArrangementField
            label={t("arrangements.fieldPeople")}
            value={draft.peopleText}
            placeholder={t("arrangements.fieldPeoplePlaceholder")}
            onChange={(value) => onChange("peopleText", value)}
          />
          <ArrangementField
            label={t("arrangements.fieldLocation")}
            value={draft.locationName || draft.locationText}
            placeholder={t("arrangements.fieldLocationPlaceholder")}
            onChange={(value) => onChange("locationName", value)}
          />
          <label className="block rounded-[12px] bg-surface-muted px-3 py-2.5">
            <span className="text-xs font-medium leading-4 text-text-muted">
              {t("arrangements.fieldNote")}
            </span>
            <textarea
              value={draft.note}
              onChange={(event) => onChange("note", event.target.value)}
              placeholder={t("arrangements.fieldNotePlaceholder")}
              className="mt-1.5 h-20 w-full resize-none bg-transparent text-[15px] leading-5 text-text outline-none placeholder:text-input-placeholder"
            />
          </label>
        </div>
      </section>
    </div>
  );
}

function ArrangementTimeKindFields({
  draft,
  onChange,
}: {
  draft: ArrangementDraft;
  onChange: (key: keyof ArrangementDraft, value: string) => void;
}) {
  const { t } = usePreferences();
  const kinds: ArrangementTimeKind[] = ["none", "allDay", "time", "timeRange"];

  return (
    <section className="rounded-[12px] bg-surface-muted px-3 py-2.5">
      <p className="text-xs font-medium leading-4 text-text-muted">
        {t("arrangements.fieldTimeKind")}
      </p>
      <div className="mt-2 grid grid-cols-4 gap-1.5">
        {kinds.map((kind) => {
          const active = draft.timeKind === kind;
          return (
            <button
              key={kind}
              type="button"
              className={cn(
                "h-8 rounded-[9px] border text-[12px] transition active:scale-[0.98]",
                active
                  ? "border-primary bg-primary-soft text-primary"
                  : "border-border-light bg-surface text-text-muted"
              )}
              onClick={() => onChange("timeKind", kind)}
            >
              {t(`arrangements.timeKind.${kind}`)}
            </button>
          );
        })}
      </div>

      {(draft.timeKind === "time" || draft.timeKind === "timeRange") && (
        <div
          className={cn(
            "mt-2 grid gap-2",
            draft.timeKind === "timeRange" ? "grid-cols-2" : "grid-cols-1"
          )}
        >
          <ArrangementField
            label={t("arrangements.fieldStartTime")}
            value={draft.startTime}
            placeholder="09:30"
            inputType="time"
            onChange={(value) => onChange("startTime", value)}
          />
          {draft.timeKind === "timeRange" && (
            <ArrangementField
              label={t("arrangements.fieldEndTime")}
              value={draft.endTime}
              placeholder="10:30"
              inputType="time"
              onChange={(value) => onChange("endTime", value)}
            />
          )}
        </div>
      )}

      <ArrangementField
        label={t("arrangements.fieldTime")}
        value={draft.timeText}
        placeholder={t("arrangements.fieldTimePlaceholder")}
        onChange={(value) => onChange("timeText", value)}
      />
    </section>
  );
}

function ArrangementField({
  label,
  value,
  placeholder,
  inputType = "text",
  autoFocus = false,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  inputType?: "text" | "date" | "time";
  autoFocus?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block rounded-[12px] bg-surface-muted px-3 py-2.5">
      <span className="text-xs font-medium leading-4 text-text-muted">
        {label}
      </span>
      <input
        type={inputType}
        autoFocus={autoFocus}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="mt-1.5 w-full bg-transparent text-[15px] leading-5 text-text outline-none placeholder:text-input-placeholder"
      />
    </label>
  );
}
