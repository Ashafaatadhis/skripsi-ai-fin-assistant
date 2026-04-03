// src/app/bot/handlers.ts
import { Context } from "telegraf";
import { message } from "telegraf/filters";
import { app, clearChatHistory, runNaturalChat } from "@/app/chains/groq_chain.js";
import { runVisionAnalysis } from "@/app/chains/vision_chain.js";
import { sanitizeTelegramHtml, stripTelegramHtml } from "@/app/bot/telegram-format.js";
import { getLogger, truncateForLog } from "@/lib/logger.js";

const logger = getLogger("bot");

async function replyWithSafeTelegramHtml(ctx: Context, text: string) {
  const fallbackText = stripTelegramHtml(text).trim() || "Maaf, jawabanku tadi kosong. Coba ulang ya.";
  const sanitized = sanitizeTelegramHtml(text).trim();

  if (!sanitized) {
    await ctx.reply(fallbackText);
    return;
  }

  try {
    await ctx.reply(sanitized, {
      parse_mode: "HTML",
    });
  } catch (error) {
    logger.warn("Telegram HTML parse failed, retrying plain text", {
      eventName: "BOT_TELEGRAM_HTML_RETRY",
      error,
      chatId: ctx.chat?.id?.toString() ?? null,
    });
    await ctx.reply(stripTelegramHtml(sanitized).trim() || fallbackText);
  }
}

export const handleTextMessage = async (ctx: Context) => {
  // Pastikan hanya memproses pesan teks
  if (!ctx.has(message("text"))) return;

  const chatId = ctx.chat.id.toString();
  const userText = ctx.message.text;
  logger.info("Pesan teks masuk", {
    eventName: "BOT_TEXT_MESSAGE_RECEIVED",
    chatId,
    userTextPreview: truncateForLog(userText, 250),
  });

  try {
    await ctx.sendChatAction("typing");

    const config = { configurable: { thread_id: chatId } };
    const graphState = await app.getState(config);
    const hasActiveInterrupt = graphState.tasks.some(
      (task) => (task.interrupts?.length ?? 0) > 0,
    );

    logger.info("Checked graph interrupt state", {
      eventName: "BOT_INTERRUPT_STATE_CHECKED",
      chatId,
      hasActiveInterrupt,
      taskCount: graphState.tasks.length,
    });

    const aiResponse = await runNaturalChat(chatId, userText, {
      resume: hasActiveInterrupt,
    });

    logger.info("Balasan AI siap dikirim", {
      eventName: "BOT_TEXT_RESPONSE_READY",
      chatId,
      aiResponsePreview: truncateForLog(aiResponse, 250),
      resumedInterrupt: hasActiveInterrupt,
    });

    await replyWithSafeTelegramHtml(ctx, aiResponse);
  } catch (error) {
    logger.error("Groq error saat memproses pesan teks", {
      eventName: "BOT_TEXT_MESSAGE_FAILED",
      chatId,
      error,
    });
    await ctx.reply("Duh, koneksi ke otak saya lagi putus. Coba lagi ya!");
  }
};

// src/app/bot/handlers.ts
export const handlePhotoMessage = async (ctx: Context) => {
  if (!ctx.has(message("photo"))) return;

  const chatId = ctx.chat.id.toString();

  try {
    await ctx.sendChatAction("upload_photo");

    const photo = ctx.message.photo.pop();
    const caption = ctx.message.caption; // Ambil teks yang dikirim bareng foto
    const fileId = photo?.file_id;
    const fileUrl = await ctx.telegram.getFileLink(fileId!);

    logger.info("Pesan foto masuk", {
      eventName: "BOT_PHOTO_MESSAGE_RECEIVED",
      chatId,
      captionPreview: truncateForLog(caption ?? "", 250),
      fileId: fileId ?? null,
    });

    // Pesan tunggu
    await ctx.reply("Sabar ya, lagi gue cek fotonya...");

    // Jalankan analisis dengan menyertakan caption
    const analysis = await runVisionAnalysis(
      chatId,
      fileUrl.href,
      caption,
    );

    logger.info("Hasil analisis foto siap dikirim", {
      eventName: "BOT_PHOTO_RESPONSE_READY",
      chatId,
      analysisPreview: truncateForLog(analysis, 250),
    });

    // Kirim hasil akhir
    await replyWithSafeTelegramHtml(ctx, analysis);
  } catch (error) {
    logger.error("Vision error saat memproses foto", {
      eventName: "BOT_PHOTO_MESSAGE_FAILED",
      chatId,
      error,
    });
    await ctx.reply("Duh, kamera gue burem. Coba kirim ulang struknya!");
  }
};

export const handleClearCommand = async (ctx: Context) => {
  const chatId = ctx.chat?.id.toString();
  if (!chatId) return;

  logger.info("Perintah clear chat diterima", {
    eventName: "BOT_CLEAR_COMMAND_RECEIVED",
    chatId,
  });

  const res = await clearChatHistory(chatId);
  await ctx.reply(res);
};
