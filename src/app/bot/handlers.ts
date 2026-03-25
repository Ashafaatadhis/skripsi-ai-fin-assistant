// src/app/bot/handlers.ts
import { Context } from "telegraf";
import { message } from "telegraf/filters";
import { clearChatHistory, runNaturalChat } from "@/app/chains/groq_chain.js";
import { runVisionAnalysis } from "@/app/chains/vision_chain.js";

export const handleTextMessage = async (ctx: Context) => {
  // Pastikan hanya memproses pesan teks
  if (!ctx.has(message("text"))) return;

  const chatId = ctx.chat.id.toString();
  const userText = ctx.message.text;
  console.log(`📩 Pesan masuk dari user: "${userText}", chat id: "${chatId}"`);

  try {
    // Tampilkan status "typing..." di Telegram biar natural
    await ctx.sendChatAction("typing");
    // Panggil AI
    const aiResponse = await runNaturalChat(chatId, userText);

    // Kirim jawaban ke user
    await ctx.reply(aiResponse, {
      parse_mode: "HTML",
    });
  } catch (error) {
    console.error("Groq Error:", error);
    await ctx.reply("Duh, koneksi ke otak saya lagi putus. Coba lagi ya!");
  }
};

// src/app/bot/handlers.ts
export const handlePhotoMessage = async (ctx: Context) => {
  if (!ctx.has(message("photo"))) return;

  try {
    await ctx.sendChatAction("upload_photo");

    const photo = ctx.message.photo.pop();
    const caption = ctx.message.caption; // Ambil teks yang dikirim bareng foto
    const fileId = photo?.file_id;
    const fileUrl = await ctx.telegram.getFileLink(fileId!);

    // Pesan tunggu
    await ctx.reply("Sabar ya, lagi gue cek fotonya...");

    // Jalankan analisis dengan menyertakan caption
    const analysis = await runVisionAnalysis(
      ctx.chat.id.toString(),
      fileUrl.href,
      caption,
    );

    // Kirim hasil akhir
    await ctx.reply(analysis, { parse_mode: "HTML" });
  } catch (error) {
    console.error("Vision Error:", error);
    await ctx.reply("Duh, kamera gue burem. Coba kirim ulang struknya!");
  }
};

export const handleClearCommand = async (ctx: Context) => {
  const chatId = ctx.chat?.id.toString();
  if (!chatId) return;

  const res = await clearChatHistory(chatId);
  await ctx.reply(res);
};
