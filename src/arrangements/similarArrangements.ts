import {
  isValidTimeValue,
  type ArrangementDraft,
  type ArrangementItem,
} from "@/arrangements/arrangementStorage";
import { callAiJson } from "@/ai/aiClient";
import { hasAiApiSettings } from "@/settings/aiApiSettings";

export type SimilarArrangementCandidate = ArrangementDraft & {
  contexts?: string[];
};

export type SimilarArrangementMatch = {
  arrangement: ArrangementItem;
  score: number;
  reasons: string[];
};

type FindSimilarArrangementOptions = {
  threshold?: number;
  limit?: number;
};

type AiSimilarityMatch = {
  id: string;
  score: number;
  reasons: string[];
};

const defaultSimilarityThreshold = 0.65;
const defaultSimilarityLimit = 3;

const stopWords = new Set([
  "安排",
  "事项",
  "待办",
  "一个",
  "一下",
  "这个",
  "那个",
  "我的",
  "你的",
  "他的",
  "她的",
  "我们",
  "你们",
  "他们",
  "她们",
]);

function normalizeText(value: string) {
  return value
    .toLowerCase()
    .replace(/[，。！？、；：,.!?;:()[\]{}"'“”‘’`~@#$%^&*+=\\/|<>_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildKeywordSet(value: string) {
  const normalized = normalizeText(value);
  const tokens = new Set<string>();
  if (!normalized) return tokens;

  normalized
    .split(" ")
    .map((token) => token.trim())
    .filter(Boolean)
    .forEach((token) => {
      if (/^[a-z0-9]+$/.test(token)) {
        if (token.length >= 2 && !stopWords.has(token)) tokens.add(token);
        return;
      }

      if (token.length <= 2) {
        if (!stopWords.has(token)) tokens.add(token);
        return;
      }

      for (let index = 0; index < token.length - 1; index += 1) {
        const pair = token.slice(index, index + 2);
        if (!stopWords.has(pair)) tokens.add(pair);
      }
    });

  return tokens;
}

function scoreTokenOverlap(leftValue: string, rightValue: string) {
  const left = buildKeywordSet(leftValue);
  const right = buildKeywordSet(rightValue);
  if (left.size === 0 || right.size === 0) return 0;

  const intersection = [...left].filter((token) => right.has(token)).length;
  const union = new Set([...left, ...right]).size;
  return union > 0 ? intersection / union : 0;
}

function scoreTextField(leftValue: string, rightValue: string) {
  const left = normalizeText(leftValue);
  const right = normalizeText(rightValue);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.85;
  return scoreTokenOverlap(left, right);
}

function getTimeMinutes(value: string) {
  if (!isValidTimeValue(value)) return null;
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function scoreTime(candidate: SimilarArrangementCandidate, existing: ArrangementItem) {
  if (candidate.dateKey && existing.dateKey && candidate.dateKey === existing.dateKey) {
    const candidateMinutes = getTimeMinutes(candidate.startTime);
    const existingMinutes = getTimeMinutes(existing.startTime);
    if (candidateMinutes === null || existingMinutes === null) return 0.75;
    return Math.abs(candidateMinutes - existingMinutes) <= 60 ? 1 : 0.75;
  }

  if (
    candidate.startTime &&
    existing.startTime &&
    candidate.startTime === existing.startTime
  ) {
    return 0.55;
  }

  if (candidate.timeText && existing.timeText) {
    return scoreTextField(candidate.timeText, existing.timeText) >= 0.5 ? 0.45 : 0;
  }

  return 0;
}

function scoreContexts(candidate: SimilarArrangementCandidate, existing: ArrangementItem) {
  const candidateContext = (candidate.contexts || []).join(" ");
  const existingContext = (existing.contexts || []).join(" ");
  const candidateText = [candidateContext, candidate.title, candidate.note].join(" ");
  const existingText = [existingContext, existing.title, existing.note].join(" ");
  return scoreTokenOverlap(candidateText, existingText);
}

function roundScore(value: number) {
  return Math.round(value * 100) / 100;
}

function buildSimilarityScore({
  titleScore,
  timeScore,
  locationScore,
  peopleScore,
  contextScore,
}: {
  titleScore: number;
  timeScore: number;
  locationScore: number;
  peopleScore: number;
  contextScore: number;
}) {
  const weightedScore =
    titleScore * 0.32 +
    timeScore * 0.24 +
    locationScore * 0.16 +
    peopleScore * 0.14 +
    contextScore * 0.14;
  const supportingScore = Math.max(
    timeScore,
    locationScore,
    peopleScore,
    contextScore
  );

  if (titleScore >= 0.85) return Math.max(weightedScore, 0.86);
  if (titleScore >= 0.65 && supportingScore >= 0.45) {
    return Math.max(weightedScore, 0.72);
  }

  return weightedScore;
}

function combineDistinctText(existingValue: string, incomingValue: string) {
  const existing = existingValue.trim();
  const incoming = incomingValue.trim();
  if (!existing) return incoming;
  if (!incoming) return existing;
  if (existing.includes(incoming)) return existing;
  if (incoming.includes(existing)) return incoming;
  return `${existing}、${incoming}`;
}

function serializeCandidate(candidate: SimilarArrangementCandidate) {
  return {
    title: candidate.title,
    timeText: candidate.timeText,
    dateKey: candidate.dateKey,
    startTime: candidate.startTime,
    endTime: candidate.endTime,
    peopleText: candidate.peopleText,
    locationText: candidate.locationName || candidate.locationText,
    note: candidate.note,
    contexts: candidate.contexts || [],
  };
}

function serializeExistingArrangement(arrangement: ArrangementItem) {
  return {
    id: arrangement.id,
    title: arrangement.title,
    timeText: arrangement.timeText,
    dateKey: arrangement.dateKey,
    startTime: arrangement.startTime,
    endTime: arrangement.endTime,
    peopleText: arrangement.peopleText,
    locationText: arrangement.locationName || arrangement.locationText,
    note: arrangement.note,
    source: arrangement.source,
    status: arrangement.status,
    contexts: arrangement.contexts || [],
  };
}

function buildAiSimilarityPrompt(
  candidate: SimilarArrangementCandidate,
  existingArrangements: ArrangementItem[]
) {
  return [
    "你是待办事项相似度判断器。请判断新待办是否和已有待办指向同一个现实事项。",
    "判断时综合语义、标题意图、时间、地点、相关人、来源上下文；不要只做字面关键词匹配。",
    "如果只是同一主题但行动不同，或时间/对象明显不同，不要判为相似。",
    "只返回 JSON 对象，不要 markdown。JSON 格式：",
    "{\"matches\":[{\"id\":\"已有待办 id\",\"score\":0.0到1.0,\"reasons\":[\"简短中文原因\"]}]}",
    "只返回高度相似、值得提示用户合并的候选，最多 3 条；没有则返回 {\"matches\":[] }。",
    "",
    `新待办：${JSON.stringify(serializeCandidate(candidate))}`,
    `已有待办：${JSON.stringify(existingArrangements.map(serializeExistingArrangement))}`,
  ].join("\n");
}

function normalizeAiScore(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  if (value > 1 && value <= 100) return value / 100;
  return Math.min(1, Math.max(0, value));
}

function normalizeAiReasons(value: unknown) {
  if (!Array.isArray(value)) return ["AI 语义判断相似"];
  const reasons = value
    .filter((reason): reason is string => typeof reason === "string")
    .map((reason) => reason.trim())
    .filter(Boolean)
    .slice(0, 3);
  return reasons.length > 0 ? reasons : ["AI 语义判断相似"];
}

function parseAiSimilarityMatches(
  value: unknown,
  existingArrangements: ArrangementItem[],
  options: Required<FindSimilarArrangementOptions>
): SimilarArrangementMatch[] {
  if (!value || typeof value !== "object") return [];

  const matchesValue = (value as { matches?: unknown }).matches;
  if (!Array.isArray(matchesValue)) return [];

  const arrangementMap = new Map(
    existingArrangements.map((arrangement) => [arrangement.id, arrangement])
  );

  return matchesValue
    .map((matchValue): AiSimilarityMatch | null => {
      if (!matchValue || typeof matchValue !== "object") return null;
      const rawMatch = matchValue as {
        id?: unknown;
        score?: unknown;
        reasons?: unknown;
      };
      if (typeof rawMatch.id !== "string") return null;
      const arrangement = arrangementMap.get(rawMatch.id);
      if (!arrangement) return null;

      return {
        id: rawMatch.id,
        score: roundScore(normalizeAiScore(rawMatch.score)),
        reasons: normalizeAiReasons(rawMatch.reasons),
      };
    })
    .filter((match): match is AiSimilarityMatch => Boolean(match))
    .filter((match) => match.score >= options.threshold)
    .sort((left, right) => right.score - left.score)
    .slice(0, options.limit)
    .map((match) => ({
      arrangement: arrangementMap.get(match.id) as ArrangementItem,
      score: match.score,
      reasons: match.reasons,
    }));
}

export function findSimilarArrangements(
  candidate: SimilarArrangementCandidate,
  existingArrangements: ArrangementItem[],
  options: FindSimilarArrangementOptions = {}
): SimilarArrangementMatch[] {
  const threshold = options.threshold ?? defaultSimilarityThreshold;
  const limit = options.limit ?? defaultSimilarityLimit;

  return existingArrangements
    .map((arrangement) => {
      const titleScore = scoreTextField(candidate.title, arrangement.title);
      const timeScore = scoreTime(candidate, arrangement);
      const locationScore = Math.max(
        scoreTextField(candidate.locationName, arrangement.locationName),
        scoreTextField(candidate.locationText, arrangement.locationText),
        scoreTextField(candidate.locationName, arrangement.locationText),
        scoreTextField(candidate.locationText, arrangement.locationName)
      );
      const peopleScore = scoreTextField(candidate.peopleText, arrangement.peopleText);
      const contextScore = scoreContexts(candidate, arrangement);
      const score = buildSimilarityScore({
        titleScore,
        timeScore,
        locationScore,
        peopleScore,
        contextScore,
      });
      const reasons = [
        titleScore >= 0.45 ? "标题相近" : "",
        timeScore >= 0.55 ? "时间接近" : "",
        locationScore >= 0.5 ? "地点相同" : "",
        peopleScore >= 0.5 ? "相关人相同" : "",
        contextScore >= 0.35 ? "上下文相关" : "",
      ].filter(Boolean);

      return {
        arrangement,
        score: roundScore(score),
        reasons,
      };
    })
    .filter((match) => match.score >= threshold && match.reasons.length > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

export async function findSimilarArrangementsWithAi(
  candidate: SimilarArrangementCandidate,
  existingArrangements: ArrangementItem[],
  options: FindSimilarArrangementOptions = {}
): Promise<SimilarArrangementMatch[]> {
  const normalizedOptions = {
    threshold: options.threshold ?? defaultSimilarityThreshold,
    limit: options.limit ?? defaultSimilarityLimit,
  };
  const localMatches = findSimilarArrangements(
    candidate,
    existingArrangements,
    normalizedOptions
  );
  const activeArrangements = existingArrangements
    .filter((arrangement) => arrangement.status !== "completed")
    .slice(0, 30);

  if (activeArrangements.length === 0 || !hasAiApiSettings()) {
    return localMatches;
  }

  try {
    const aiResponse = await callAiJson(
      buildAiSimilarityPrompt(candidate, activeArrangements)
    );
    const aiMatches = parseAiSimilarityMatches(
      aiResponse,
      activeArrangements,
      normalizedOptions
    );
    return aiMatches.length > 0 ? aiMatches : localMatches;
  } catch {
    return localMatches;
  }
}

export function mergeSimilarArrangement(
  existing: ArrangementItem,
  incoming: SimilarArrangementCandidate
): ArrangementItem {
  const incomingLocation = incoming.locationName.trim() || incoming.locationText.trim();
  const contexts = Array.from(
    new Set([...(existing.contexts || []), ...(incoming.contexts || [])].filter(Boolean))
  );
  const note =
    existing.note && incoming.note && !existing.note.includes(incoming.note)
      ? `${existing.note}\n${incoming.note}`
      : existing.note || incoming.note;

  return {
    ...existing,
    timeText: existing.timeText || incoming.timeText,
    dateKey: existing.dateKey || incoming.dateKey,
    startTime: existing.startTime || incoming.startTime,
    endTime: existing.endTime || incoming.endTime,
    timeKind:
      existing.timeKind !== "none" || !incoming.dateKey ? existing.timeKind : incoming.timeKind,
    peopleText: combineDistinctText(existing.peopleText, incoming.peopleText),
    locationText: combineDistinctText(existing.locationText, incomingLocation),
    locationName: combineDistinctText(existing.locationName, incomingLocation),
    note,
    contexts: contexts.length > 0 ? contexts : existing.contexts,
  };
}
