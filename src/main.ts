// src/main.ts
import "dotenv/config";
import { Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { handlePhotoMessage, handleTextMessage } from "@/app/bot/handlers.js";

// Pastikan BOT_TOKEN ada sebelum bot dinyalakan
const token = process.env.BOT_TOKEN!;
if (!token) {
  console.error("❌ ERROR: BOT_TOKEN tidak ditemukan di file .env");
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

// 3. Test Handler (Hapus ini jika sudah pakai file handlers)
bot.on(message("text"), handleTextMessage);
bot.on(message("photo"), handlePhotoMessage);

// 4. Launch Bot dengan Penanganan Error
console.log("⌛ Sedang menyambungkan ke Telegram...");
bot
  .launch()
  .then(() => {
    console.log("-----------------------------------------");
    console.log("🚀 AI Financial Assistant IS RUNNING");
    console.log("🤖 Bot: @" + bot.botInfo?.username);
    console.log("-----------------------------------------");
  })
  .catch((err) => {
    console.error("❌ Gagal menjalankan bot:", err);
  });

// 5. Graceful Shutdown
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
