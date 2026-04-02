import { BaseMessage, HumanMessage } from "@langchain/core/messages";

export const cleanAIResponse = (text: string) =>
  text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

export const getMessageText = (message: BaseMessage) => {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => (typeof part === "string" ? part : (part?.text ?? "")))
      .join("\n");
  }
  return String(content ?? "");
};

const looksLikeClarificationReply = (text: string) => {
  const normalized = text.trim();
  if (!normalized) return false;

  if (/^[A-Za-z0-9-]{4,36}$/.test(normalized)) return true;
  if (/^yang\s+/i.test(normalized)) return true;
  if (/^yg\s+/i.test(normalized)) return true;
  if (/tanggal\s+\d{1,2}/i.test(normalized)) return true;
  if (/\d+[.,]?\d*\s*(rb|ribu|k|jt|juta)?$/i.test(normalized)) return true;

  return false;
};

export const detectClarificationRoute = (messages: BaseMessage[]) => {
  const lastMessage = messages[messages.length - 1];
  if (!(lastMessage instanceof HumanMessage)) return null;

  const latestUserText = getMessageText(lastMessage).trim();
  if (!looksLikeClarificationReply(latestUserText)) return null;

  const recentContext = messages
    .slice(-8, -1)
    .map((message) => cleanAIResponse(getMessageText(message)))
    .join("\n")
    .toLowerCase();

  if (
    recentContext.includes("debt id ambigu") ||
    recentContext.includes("debtid yang benar") ||
    (recentContext.includes("hutang") && recentContext.includes("ambigu"))
  ) {
    return "split_bill";
  }

  if (
    recentContext.includes("id transaksi ambigu") ||
    recentContext.includes("txid berikut") ||
    recentContext.includes("transaksi untuk split ambigu") ||
    recentContext.includes("hasil pencarian transaksi")
  ) {
    return "recorder";
  }

  return null;
};
