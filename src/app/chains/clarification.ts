import { BaseMessage } from "@langchain/core/messages";

export const cleanAIResponse = (text: string) =>
  text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

export const getMessageText = (message: BaseMessage) => {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) =>
        typeof part === "string" ? part : (part?.text ?? ""),
      )
      .join("\n");
  }
  return String(content ?? "");
};
