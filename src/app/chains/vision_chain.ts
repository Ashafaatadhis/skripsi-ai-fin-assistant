// src/app/chains/vision_chain.ts
import { ChatGroq } from "@langchain/groq";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { GENERAL_VISION_SYSTEM_PROMPT } from "@/app/chains/prompt.js";
import { runNaturalChat } from "./groq_chain.js";

const visionModel = new ChatGroq({
  apiKey: process.env.GROQ_API_KEY!,
  model: "meta-llama/llama-4-scout-17b-16e-instruct",
});

export async function runVisionAnalysis(
  chatId: string,
  imageUrl: string,
  userCaption?: string,
) {
  // Cara LangChain yang bener buat kirim gambar (Multimodal)
  const response = await visionModel.invoke([
    new SystemMessage(GENERAL_VISION_SYSTEM_PROMPT),
    new HumanMessage({
      content: [
        { type: "text", text: "Mohon analisa foto ini." },
        { type: "image_url", image_url: { url: imageUrl } },
      ],
    }),
  ]);

  const rawData = response.content.toString();
  const userContext = userCaption ? `\nPesan User: "${userCaption}"` : "";

  // Kirim hasil scan (struk atau gambar umum) ke LangGraph utama
  return await runNaturalChat(
    chatId,
    `[SYSTEM_EVENT: User mengunggah foto. Deskripsi Vision: ${rawData}${userContext}]`,
  );
}
