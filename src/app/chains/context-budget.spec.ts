import assert from "node:assert/strict";
import test from "node:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import {
  estimateMessagesTokens,
  estimateSummaryTokens,
  shouldCondenseSummary,
  shouldSummarizeMessages,
} from "./context-budget.js";

test("estimateMessagesTokens includes message content", () => {
  const size = estimateMessagesTokens([
    new HumanMessage("halo"),
    new AIMessage("hai juga"),
  ]);

  assert.ok(size > 0);
});

test("estimateSummaryTokens includes summary text", () => {
  const size = estimateSummaryTokens("Ringkasan singkat");

  assert.ok(size > 0);
});

test("shouldSummarizeMessages stays false for short context", () => {
  const shouldSummarize = shouldSummarizeMessages([
    new HumanMessage("halo"),
    new AIMessage("hai"),
  ]);

  assert.equal(shouldSummarize, false);
});

test("shouldSummarizeMessages turns true when message tokens are too large", () => {
  const longText = "transaksi ".repeat(2000);
  const messages = [
    new HumanMessage(longText),
    new AIMessage(longText),
    new HumanMessage(longText),
    new AIMessage(longText),
    new HumanMessage(longText),
    new AIMessage(longText),
    new HumanMessage(longText),
  ];

  assert.equal(shouldSummarizeMessages(messages), true);
});

test("shouldCondenseSummary turns true when summary is too large", () => {
  const longSummary = "ringkas ".repeat(600);

  assert.equal(shouldCondenseSummary(longSummary), true);
});


test("shouldCondenseSummary stays false for short summary", () => {
  assert.equal(shouldCondenseSummary("ringkas"), false);
});
