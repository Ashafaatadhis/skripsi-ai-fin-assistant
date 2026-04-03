import { BaseMessage } from "@langchain/core/messages";
import { getMessageText } from "@/app/chains/clarification.js";

export const RECENT_RAW_TAIL_COUNT = 6;
export const MESSAGE_TOKEN_LIMIT = 1000;
export const SUMMARY_TOKEN_LIMIT = 500;

function estimateTokens(text: string) {
  return Math.ceil(text.trim().length / 4);
}

export function estimateMessageTokens(message: BaseMessage) {
  return estimateTokens(getMessageText(message));
}

export function estimateMessagesTokens(messages: BaseMessage[]) {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

export function estimateSummaryTokens(summary: string) {
  return estimateTokens(summary);
}

export function shouldSummarizeMessages(messages: BaseMessage[]) {
  if (messages.length <= RECENT_RAW_TAIL_COUNT) {
    return false;
  }
  return estimateMessagesTokens(messages) > MESSAGE_TOKEN_LIMIT;
}

export function shouldCondenseSummary(summary: string) {
  return estimateSummaryTokens(summary) > SUMMARY_TOKEN_LIMIT;
}
