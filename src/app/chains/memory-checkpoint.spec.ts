import assert from "node:assert/strict";
import test from "node:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import {
  buildPendingMemoryCandidates,
  formatRecentMessages,
  parseMemoryCheckpointResponse,
  updatePendingMemoryCandidates,
} from "./memory-checkpoint.js";

test("parseMemoryCheckpointResponse keeps unique fact candidates and episode summary", () => {
  const result = parseMemoryCheckpointResponse(`
    {"facts":[
      {"category":"preference","canonicalKey":"preference.transaction_view","content":"User ingin daftar transaksi tampil lengkap.","confidence":0.95,"importanceScore":0.8},
      {"category":"preference","canonicalKey":"preference.transaction_view","content":"Duplikat yang harus dibuang.","confidence":0.9,"importanceScore":0.7}
    ],"episodeSummary":{"content":"User sedang bingung mengatur uang bulan ini dan butuh bantuan yang lebih terstruktur.","importanceScore":0.7}}
  `);

  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0]?.canonicalKey, "preference.transaction_view");
  assert.equal(result.episodeSummary?.content, "User sedang bingung mengatur uang bulan ini dan butuh bantuan yang lebih terstruktur.");
});

test("formatRecentMessages renders message role and content", () => {
  const result = formatRecentMessages([
    new HumanMessage("halo"),
    new AIMessage("siap"),
  ]);

  assert.match(result, /HUMAN: halo/);
  assert.match(result, /AI: siap/);
});

test("updatePendingMemoryCandidates keeps new candidates pending", () => {
  const extraction = parseMemoryCheckpointResponse(`
    {"facts":[{"category":"profile","canonicalKey":"profile.name","content":"Nama user adalah Adhis.","confidence":0.9,"importanceScore":0.8}],"episodeSummary":null}
  `);

  const { pendingCandidates, promotedCandidates } = updatePendingMemoryCandidates(
    [],
    extraction,
    "2026-04-02T10:00:00.000Z",
  );

  assert.equal(promotedCandidates.length, 0);
  assert.equal(pendingCandidates.length, 1);
  assert.equal(pendingCandidates[0]?.seenCount, 1);
});

test("updatePendingMemoryCandidates promotes repeated candidates", () => {
  const extraction = parseMemoryCheckpointResponse(`
    {"facts":[{"category":"profile","canonicalKey":"profile.name","content":"Nama user adalah Adhis.","confidence":0.9,"importanceScore":0.8}],"episodeSummary":null}
  `);

  const firstPending = buildPendingMemoryCandidates(
    extraction,
    "2026-04-02T10:00:00.000Z",
  );
  const { pendingCandidates, promotedCandidates } = updatePendingMemoryCandidates(
    firstPending,
    extraction,
    "2026-04-02T11:00:00.000Z",
  );

  assert.equal(pendingCandidates.length, 0);
  assert.equal(promotedCandidates.length, 1);
  assert.equal(promotedCandidates[0]?.seenCount, 2);
});

test("updatePendingMemoryCandidates keeps episode summary pending longer", () => {
  const extraction = parseMemoryCheckpointResponse(`
    {"facts":[],"episodeSummary":{"content":"User sedang bingung mengatur uang bulan ini dan butuh bantuan yang lebih terstruktur.","importanceScore":0.7}}
  `);

  const firstPending = buildPendingMemoryCandidates(
    extraction,
    "2026-04-02T10:00:00.000Z",
  );
  const nextResult = updatePendingMemoryCandidates(
    firstPending,
    { facts: [], episodeSummary: null },
    "2026-04-02T11:00:00.000Z",
  );

  assert.equal(nextResult.promotedCandidates.length, 0);
  assert.equal(nextResult.pendingCandidates.length, 1);
  assert.equal(nextResult.pendingCandidates[0]?.checkpointCount, 2);
});

test("updatePendingMemoryCandidates promotes episode summary after enough checkpoints", () => {
  const extraction = parseMemoryCheckpointResponse(`
    {"facts":[],"episodeSummary":{"content":"User sedang bingung mengatur uang bulan ini dan butuh bantuan yang lebih terstruktur.","importanceScore":0.7}}
  `);

  const firstPending = buildPendingMemoryCandidates(
    extraction,
    "2026-04-02T10:00:00.000Z",
  );
  const secondPending = updatePendingMemoryCandidates(
    firstPending,
    { facts: [], episodeSummary: null },
    "2026-04-02T11:00:00.000Z",
  ).pendingCandidates;
  const thirdResult = updatePendingMemoryCandidates(
    secondPending,
    { facts: [], episodeSummary: null },
    "2026-04-02T12:00:00.000Z",
  );

  assert.equal(thirdResult.pendingCandidates.length, 0);
  assert.equal(thirdResult.promotedCandidates.length, 1);
  assert.equal(thirdResult.promotedCandidates[0]?.memoryType, "episode_summary");
});

test("updatePendingMemoryCandidates discards stale fact candidates after too many checkpoints", () => {
  const extraction = parseMemoryCheckpointResponse(`
    {"facts":[{"category":"profile","canonicalKey":"profile.name","content":"Nama user adalah Adhis.","confidence":0.9,"importanceScore":0.8}],"episodeSummary":null}
  `);

  let pendingCandidates = buildPendingMemoryCandidates(
    extraction,
    "2026-04-02T10:00:00.000Z",
  ).map((candidate) => ({
    ...candidate,
    seenCount: 1,
    checkpointCount: 4,
  }));

  const result = updatePendingMemoryCandidates(
    pendingCandidates,
    { facts: [], episodeSummary: null },
    "2026-04-02T11:00:00.000Z",
  );

  assert.equal(result.pendingCandidates.length, 0);
  assert.equal(result.promotedCandidates.length, 0);
});

test("updatePendingMemoryCandidates discards candidates that are too old", () => {
  const extraction = parseMemoryCheckpointResponse(`
    {"facts":[{"category":"preference","canonicalKey":"preference.drink","content":"User suka kopi hitam.","confidence":0.9,"importanceScore":0.8}],"episodeSummary":null}
  `);

  const oldPending = buildPendingMemoryCandidates(
    extraction,
    "2026-04-01T10:00:00.000Z",
  );
  const result = updatePendingMemoryCandidates(
    oldPending,
    { facts: [], episodeSummary: null },
    "2026-04-20T10:00:00.000Z",
  );

  assert.equal(result.pendingCandidates.length, 0);
  assert.equal(result.promotedCandidates.length, 0);
});

test("updatePendingMemoryCandidates caps pending candidates and keeps stronger ones first", () => {
  const manyCandidates = Array.from({ length: 25 }, (_, index) => ({
    candidateKey: `episode:item_${index}`,
    memoryType: "episode_summary" as const,
    category: "episode",
    content: `Ringkasan ${index}`,
    confidence: 0.8,
    importanceScore: index === 24 ? 0.59 : 0.2,
    firstSeenAt: "2026-04-02T10:00:00.000Z",
    lastSeenAt: `2026-04-02T10:${String(index).padStart(2, "0")}:00.000Z`,
    seenCount: index === 24 ? 2 : 1,
    checkpointCount: 1,
  }));

  const result = updatePendingMemoryCandidates(
    manyCandidates,
    { facts: [], episodeSummary: null },
    "2026-04-02T11:00:00.000Z",
  );

  assert.equal(result.pendingCandidates.length, 20);
  assert.equal(result.pendingCandidates[0]?.candidateKey, "episode:item_24");
  assert.equal(
    result.pendingCandidates.some((candidate) => candidate.candidateKey === "episode:item_0"),
    false,
  );
});
