// src/lib/memory.ts
import { prisma } from "@/lib/db.js"; // Pastikan path prisma client lo bener
import { embeddings } from "@/lib/embedding.js";

export async function saveToLongTermMemory(chatId: string, content: string) {
  try {
    // 1. Generate Vector (1536 dimensi)
    const vector = await embeddings.embedQuery(content);

    // 2. Simpan ke VPS via Prisma Raw SQL
    // Kita pakai $executeRawUnsafe karena tipe 'vector' butuh format '[0.1, 0.2, ...]'
    await prisma.$executeRawUnsafe(
      `INSERT INTO "LongTermMemory" (id, "chatId", content, embedding) 
       VALUES (gen_random_uuid(), $1, $2, $3::vector)`,
      chatId,
      content,
      `[${vector.join(",")}]`, // Mengubah array [0.1, 0.2] jadi string "[0.1, 0.2]"
    );

    console.log(
      `✅ Memory Berhasil Disimpan: "${content.substring(0, 20)}..."`,
    );
  } catch (error) {
    console.error("❌ Gagal simpan ke Long Term Memory:", error);
  }
}

export async function searchLongTermMemory(
  chatId: string,
  query: string,
  limit = 3,
) {
  const vector = await embeddings.embedQuery(query);
  const vectorString = `[${vector.join(",")}]`;

  // Mencari 3 memori yang paling relevan berdasarkan cosine similarity
  const results = await prisma.$queryRawUnsafe<any[]>(
    `SELECT content FROM "LongTermMemory" 
     WHERE "chatId" = $1 
     ORDER BY embedding <=> $2::vector 
     LIMIT $3`,
    chatId,
    vectorString,
    limit,
  );

  return results.map((r) => r.content).join("\n");
}
