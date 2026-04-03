import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeTelegramHtml, stripTelegramHtml } from "./telegram-format.js";

test("converts common markdown to telegram html", () => {
  const result = sanitizeTelegramHtml(
    "📄 **Daftar transaksi lengkap**\n📌 *Ada 2 transaksi saja saat ini.*\nID: `04116586`",
  );

  assert.equal(
    result,
    "📄 <b>Daftar transaksi lengkap</b>\n📌 <i>Ada 2 transaksi saja saat ini.</i>\nID: <code>04116586</code>",
  );
});

test("keeps allowed html tags intact", () => {
  const result = sanitizeTelegramHtml("<b>Hello</b> <code>123</code>");
  assert.equal(result, "<b>Hello</b> <code>123</code>");
});

test("escapes unsupported html tags", () => {
  const result = sanitizeTelegramHtml("<div>bad</div>");
  assert.equal(result, "&lt;div&gt;bad&lt;/div&gt;");
});

test("normalizes bullets and excessive blank lines", () => {
  const result = sanitizeTelegramHtml("- satu\n* dua\n\n\n• tiga");
  assert.equal(result, "• satu\n• dua\n\n• tiga");
});

test("escapes unbalanced allowed html tags to avoid telegram parse errors", () => {
  const result = sanitizeTelegramHtml("<b>Judul\n<i>miring</b>");
  assert.equal(result, "&lt;b&gt;Judul\n&lt;i&gt;miring&lt;/b&gt;");
});

test("strips telegram html into safe plain text fallback", () => {
  const result = stripTelegramHtml("<b>Judul</b>\n<code>123</code> &lt;div&gt;");
  assert.equal(result, "Judul\n123 <div>");
});
