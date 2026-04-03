import assert from "node:assert/strict";
import test from "node:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import {
  estimateContextSize,
  shouldSummarizeMessages,
} from "./context-budget.js";

test("estimateContextSize includes summary and messages", () => {
  const size = estimateContextSize(
    [new HumanMessage("halo"), new AIMessage("hai juga")],
    "Ringkasan singkat",
  );

  assert.ok(size > 0);
});

test("shouldSummarizeMessages stays false for short context", () => {
  const shouldSummarize = shouldSummarizeMessages(
    [new HumanMessage("halo"), new AIMessage("hai")],
    "",
  );

  assert.equal(shouldSummarize, false);
});

test("shouldSummarizeMessages turns true when context is too large", () => {
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

  assert.equal(shouldSummarizeMessages(messages, "ringkas"), true);
});
