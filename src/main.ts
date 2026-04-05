// src/main.ts
import "dotenv/config";
import { Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { handleClearCommand, handlePhotoMessage, handleTextMessage } from "@/app/bot/handlers.js";
import { getLogger } from "@/lib/logger.js";

const logger = getLogger("main");

// Pastikan BOT_TOKEN ada sebelum bot dinyalakan
const token = process.env.BOT_TOKEN!;
if (!token) {
  logger.error("BOT_TOKEN tidak ditemukan di file .env", {
    eventName: "BOT_TOKEN_MISSING",
  });
  process.exit(1);
}

const bot = new Telegraf(token);

// 1. Handler Command Start
bot.start((ctx) => {
  ctx.reply(
    "👋 Halo! Saya AI Financial Assistant.\n\n" +
      "Kirim foto struk untuk catat pengeluaran otomatis, " +
      "atau chat biasa untuk konsultasi keuangan.",
  );
});

bot.command("clear", handleClearCommand);

// 3. Test Handler (Hapus ini jika sudah pakai file handlers)
bot.on(message("text"), handleTextMessage);
bot.on(message("photo"), handlePhotoMessage);

// 4. Launch Bot dengan Penanganan Error
logger.info("Sedang menyambungkan ke Telegram", {
  eventName: "BOT_LAUNCH_START",
});

bot
  .launch()
  .then(() => {
    logger.info("AI Financial Assistant is running", {
      eventName: "BOT_LAUNCH_SUCCESS",
      username: bot.botInfo?.username ?? null,
    });
  })
  .catch((err) => {
    logger.error("Gagal menjalankan bot", {
      eventName: "BOT_LAUNCH_FAILED",
      error: err,
    });
  });

// 5. Graceful Shutdown
process.once("SIGINT", () => {
  logger.info("Received SIGINT, stopping bot", {
    eventName: "BOT_STOP_SIGINT",
  });
  bot.stop("SIGINT");
});
process.once("SIGTERM", () => {
  logger.info("Received SIGTERM, stopping bot", {
    eventName: "BOT_STOP_SIGTERM",
  });
  bot.stop("SIGTERM");
});
