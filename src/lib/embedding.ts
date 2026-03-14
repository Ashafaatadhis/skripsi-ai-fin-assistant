// src/lib/embedding.ts
import { OpenAIEmbeddings } from "@langchain/openai";

export const embeddings = new OpenAIEmbeddings({
  apiKey: process.env.OPENAI_API_KEY,
  // Kita pake model 'small' karena paling murah dan dimensinya 1536 (pas sama Prisma)
  modelName: "text-embedding-3-small",
});

/**
 * Fungsi pembantu buat ngetes teks jadi angka
 */
export async function generateVector(text: string) {
  try {
    const vector = await embeddings.embedQuery(text);
    return vector; // Ini bakal balikin array of numbers (1536 item)
  } catch (error) {
    console.error("Gagal generate embedding:", error);
    throw error;
  }
}
