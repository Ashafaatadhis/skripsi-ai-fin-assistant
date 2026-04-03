import assert from "node:assert/strict";
import test from "node:test";
import { AIMessage } from "@langchain/core/messages";
import { cleanAIResponse, getMessageText } from "./clarification.js";

test("cleanAIResponse removes think tags", () => {
  const result = cleanAIResponse("halo<think>internal</think>dunia");
  assert.equal(result, "halodunia");
});

test("getMessageText joins array content safely", () => {
  const result = getMessageText(
    new AIMessage({
      content: [
        { type: "text", text: "halo" },
        { type: "text", text: "dunia" },
      ],
    }),
  );

  assert.equal(result, "halo\ndunia");
});
