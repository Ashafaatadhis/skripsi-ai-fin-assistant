import { BaseMessage } from "@langchain/core/messages";
import { getMessageText } from "@/app/chains/clarification.js";

export const RECENT_RAW_TAIL_COUNT = 6;
export const SOFT_CONTEXT_LIMIT = 14000;

function estimateTextSize(text: string) {
  return text.trim().length;
}

export function estimateMessageSize(message: BaseMessage) {
  return estimateTextSize(getMessageText(message));
}

export function estimateContextSize(messages: BaseMessage[], summary: string) {
  const summarySize = summary.trim() ? estimateTextSize(summary) : 0;
  const messageSize = messages.reduce(
    (total, message) => total + estimateMessageSize(message),
    0,
  );

  return summarySize + messageSize;
}

export function shouldSummarizeMessages(messages: BaseMessage[], summary: string) {
  if (messages.length <= RECENT_RAW_TAIL_COUNT) {
    return false;
  }

  return estimateContextSize(messages, summary) > SOFT_CONTEXT_LIMIT;
}
