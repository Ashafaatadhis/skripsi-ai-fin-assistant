import { BaseMessage } from "@langchain/core/messages";
import { ChatGroq } from "@langchain/groq";
import { MEMORY_CHECKPOINT_PROMPT_TEMPLATE } from "@/app/chains/prompt.js";
import { cleanAIResponse, getMessageText } from "@/app/chains/clarification.js";
import { getMcpClient } from "@/lib/mcp.js";

export type FactCategory =
  | "profile"
  | "preference"
  | "financial_goal"
  | "recurring_pattern"
  | "constraint";

export type MemoryFactCandidate = {
  category: FactCategory;
  canonicalKey: string;
  content: string;
  confidence?: number;
  importanceScore?: number;
};

export type EpisodeSummaryCandidate = {
  content: string;
  importanceScore?: number;
} | null;

export type MemoryCheckpointExtraction = {
  facts: MemoryFactCandidate[];
  episodeSummary: EpisodeSummaryCandidate;
};

export type PendingMemoryCandidate = {
  candidateKey: string;
  memoryType: "fact" | "episode_summary";
  category: string;
  content: string;
  canonicalKey?: string;
  confidence?: number;
  importanceScore?: number;
  firstSeenAt: string;
  lastSeenAt: string;
  seenCount: number;
  checkpointCount: number;
};

const FACT_CATEGORIES = new Set<FactCategory>([
  "profile",
  "preference",
  "financial_goal",
  "recurring_pattern",
  "constraint",
]);

const FACT_PROMOTION_MIN_SEEN = 2;
const FACT_PROMOTION_MAX_CHECKPOINTS = 2;
const EPISODE_PROMOTION_MIN_SEEN = 2;
const EPISODE_PROMOTION_MAX_CHECKPOINTS = 3;
const EPISODE_PROMOTION_MIN_IMPORTANCE = 0.6;
const FACT_PENDING_MAX_CHECKPOINTS = 4;
const EPISODE_PENDING_MAX_CHECKPOINTS = 5;
const PENDING_CANDIDATE_MAX_AGE_DAYS = 14;
const MAX_PENDING_MEMORY_CANDIDATES = 20;

function clampScore(value: unknown, fallback: number) {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function normalizeCanonicalKey(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "_").replace(/_+/g, "_");
}

function normalizeContent(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function stripJsonFence(text: string) {
  return text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

export function formatRecentMessages(messages: BaseMessage[]) {
  return messages
    .slice(-6)
    .map((message) => `${message.getType().toUpperCase()}: ${getMessageText(message)}`)
    .join("\n");
}

export function parseMemoryCheckpointResponse(rawText: string): MemoryCheckpointExtraction {
  const parsed = JSON.parse(stripJsonFence(cleanAIResponse(rawText))) as {
    facts?: Array<Record<string, unknown>>;
    episodeSummary?: Record<string, unknown> | null;
  };

  const seenKeys = new Set<string>();
  const facts = (parsed.facts ?? [])
    .flatMap((fact): MemoryFactCandidate[] => {
      if (
        typeof fact.content !== "string" ||
        typeof fact.canonicalKey !== "string" ||
        typeof fact.category !== "string"
      ) {
        return [];
      }

      const category = fact.category as FactCategory;
      if (!FACT_CATEGORIES.has(category)) {
        return [];
      }

      const content = normalizeContent(fact.content);
      const canonicalKey = normalizeCanonicalKey(fact.canonicalKey);
      if (!content || !canonicalKey || seenKeys.has(canonicalKey)) {
        return [];
      }

      seenKeys.add(canonicalKey);
      return [{
        category,
        canonicalKey,
        content,
        confidence: clampScore(fact.confidence, 0.9),
        importanceScore: clampScore(fact.importanceScore, 0.8),
      }];
    })
    .slice(0, 3);

  const episodeSummary =
    parsed.episodeSummary && typeof parsed.episodeSummary.content === "string"
      ? {
          content: normalizeContent(parsed.episodeSummary.content),
          importanceScore: clampScore(parsed.episodeSummary.importanceScore, 0.55),
        }
      : null;

  return {
    facts,
    episodeSummary,
  };
}

function getCandidateKey(candidate: {
  memoryType: "fact" | "episode_summary";
  canonicalKey?: string;
  content: string;
}) {
  if (candidate.memoryType === "fact" && candidate.canonicalKey) {
    return `fact:${candidate.canonicalKey}`;
  }

  return `episode:${normalizeContent(candidate.content).toLowerCase()}`;
}

export function buildPendingMemoryCandidates(
  extraction: MemoryCheckpointExtraction,
  nowIso: string,
) {
  const candidates: PendingMemoryCandidate[] = extraction.facts.map((fact) => {
    const candidate: PendingMemoryCandidate = {
      candidateKey: getCandidateKey({
        memoryType: "fact",
        canonicalKey: fact.canonicalKey,
        content: fact.content,
      }),
      memoryType: "fact",
      category: fact.category,
      content: fact.content,
      canonicalKey: fact.canonicalKey,
      firstSeenAt: nowIso,
      lastSeenAt: nowIso,
      seenCount: 1,
      checkpointCount: 1,
      ...(fact.confidence !== undefined ? { confidence: fact.confidence } : {}),
      ...(fact.importanceScore !== undefined
        ? { importanceScore: fact.importanceScore }
        : {}),
    };

    return candidate;
  });

  if (extraction.episodeSummary) {
    candidates.push({
      candidateKey: getCandidateKey({
        memoryType: "episode_summary",
        content: extraction.episodeSummary.content,
      }),
      memoryType: "episode_summary",
      category: "episode",
      content: extraction.episodeSummary.content,
      confidence: 0.7,
      firstSeenAt: nowIso,
      lastSeenAt: nowIso,
      seenCount: 1,
      checkpointCount: 1,
      ...(extraction.episodeSummary.importanceScore !== undefined
        ? { importanceScore: extraction.episodeSummary.importanceScore }
        : {}),
    });
  }

  return candidates;
}

export function updatePendingMemoryCandidates(
  existingCandidates: PendingMemoryCandidate[],
  extraction: MemoryCheckpointExtraction,
  nowIso: string,
) {
  const merged = new Map(
    existingCandidates.map((candidate) => [
      candidate.candidateKey,
      {
        ...candidate,
        checkpointCount: candidate.checkpointCount + 1,
      },
    ]),
  );

  for (const candidate of buildPendingMemoryCandidates(extraction, nowIso)) {
    const existing = merged.get(candidate.candidateKey);
    if (!existing) {
      merged.set(candidate.candidateKey, candidate);
      continue;
    }

    merged.set(candidate.candidateKey, {
      ...existing,
      content: candidate.content,
      category: candidate.category,
      lastSeenAt: nowIso,
      seenCount: existing.seenCount + 1,
      ...(candidate.canonicalKey !== undefined
        ? { canonicalKey: candidate.canonicalKey }
        : {}),
      ...(candidate.confidence !== undefined
        ? { confidence: candidate.confidence }
        : {}),
      ...(candidate.importanceScore !== undefined
        ? { importanceScore: candidate.importanceScore }
        : {}),
    });
  }

  const promotedCandidates: PendingMemoryCandidate[] = [];
  const pendingCandidates: PendingMemoryCandidate[] = [];

  for (const candidate of merged.values()) {
    if (shouldDiscardCandidate(candidate, nowIso)) {
      continue;
    }

    if (shouldPromoteCandidate(candidate)) {
      promotedCandidates.push(candidate);
      continue;
    }

    pendingCandidates.push(candidate);
  }

  const trimmedPendingCandidates = pendingCandidates
    .sort((left, right) => {
      if (right.seenCount !== left.seenCount) {
        return right.seenCount - left.seenCount;
      }

      const rightImportance = right.importanceScore ?? 0;
      const leftImportance = left.importanceScore ?? 0;
      if (rightImportance !== leftImportance) {
        return rightImportance - leftImportance;
      }

      return Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt);
    })
    .slice(0, MAX_PENDING_MEMORY_CANDIDATES);

  return { pendingCandidates: trimmedPendingCandidates, promotedCandidates };
}

function shouldPromoteCandidate(candidate: PendingMemoryCandidate) {
  if (candidate.memoryType === "fact") {
    return (
      candidate.seenCount >= FACT_PROMOTION_MIN_SEEN ||
      candidate.checkpointCount >= FACT_PROMOTION_MAX_CHECKPOINTS
    );
  }

  return (
    (candidate.importanceScore ?? 0) >= EPISODE_PROMOTION_MIN_IMPORTANCE &&
    (candidate.seenCount >= EPISODE_PROMOTION_MIN_SEEN ||
      candidate.checkpointCount >= EPISODE_PROMOTION_MAX_CHECKPOINTS)
  );
}

function shouldDiscardCandidate(
  candidate: PendingMemoryCandidate,
  nowIso: string,
) {
  const maxCheckpoints =
    candidate.memoryType === "fact"
      ? FACT_PENDING_MAX_CHECKPOINTS
      : EPISODE_PENDING_MAX_CHECKPOINTS;

  if (candidate.checkpointCount > maxCheckpoints) {
    return true;
  }

  const ageMs = Date.parse(nowIso) - Date.parse(candidate.firstSeenAt);
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return ageDays > PENDING_CANDIDATE_MAX_AGE_DAYS;
}

export async function persistPromotedMemories(
  chatId: string,
  promotedCandidates: PendingMemoryCandidate[],
) {
  if (promotedCandidates.length === 0) {
    console.log("[MEMORY_LONG_TERM_MEMORY_SAVED]", {
      chatId,
      savedCount: 0,
    });
    return;
  }

  const client = await getMcpClient();
  let savedCount = 0;

  for (const candidate of promotedCandidates) {
    if (candidate.memoryType === "fact") {
      await client.callTool({
        name: "save_memory",
        arguments: {
          chatId,
          content: candidate.content,
          memoryType: "fact",
          category: candidate.category,
          canonicalKey: candidate.canonicalKey,
          confidence: candidate.confidence,
          importanceScore: candidate.importanceScore,
          sourceType: "system_checkpoint_candidate",
        },
      });
      savedCount += 1;
      continue;
    }

    if ((candidate.importanceScore ?? 0) < EPISODE_PROMOTION_MIN_IMPORTANCE) {
      continue;
    }

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    await client.callTool({
      name: "save_memory",
      arguments: {
        chatId,
        content: candidate.content,
        memoryType: "episode_summary",
        category: candidate.category,
        importanceScore: candidate.importanceScore,
        confidence: candidate.confidence,
        sourceType: "system_checkpoint_candidate",
        expiresAt: expiresAt.toISOString(),
      },
    });
    savedCount += 1;
  }

  console.log("[MEMORY_LONG_TERM_MEMORY_SAVED]", {
    chatId,
    promotedCount: promotedCandidates.length,
    savedCount,
  });
}

export async function extractCheckpointMemories({
  summary,
  recentMessages,
  model,
}: {
  summary: string;
  recentMessages: BaseMessage[];
  model: ChatGroq;
}) {
  const prompt = await MEMORY_CHECKPOINT_PROMPT_TEMPLATE.invoke({
    summary,
    recentMessages: formatRecentMessages(recentMessages),
  });
  const response = await model.invoke(prompt);
  const extraction = parseMemoryCheckpointResponse(response.content.toString());
  console.log("[MEMORY_LONG_TERM_CHECKPOINT_EXTRACTED]", {
    factCount: extraction.facts.length,
    hasEpisodeSummary: Boolean(extraction.episodeSummary),
  });
  return extraction;
}
