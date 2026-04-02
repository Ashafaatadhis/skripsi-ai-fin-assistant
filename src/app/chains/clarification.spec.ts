import assert from "node:assert/strict";
import test from "node:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { detectClarificationRoute } from "./clarification.js";

test("routes short debt clarification replies to split_bill", () => {
  const route = detectClarificationRoute([
    new AIMessage(
      "<b>⚠️ Hutang Naufal masih ambigu</b>\nAda beberapa hutang aktif atas nama itu. Balas lagi pakai DebtID yang benar:\n- <code>debt1111</code>",
    ),
    new HumanMessage("debt1111"),
  ]);

  assert.equal(route, "split_bill");
});

test("routes transaction clarification replies with non-ID text to recorder", () => {
  const route = detectClarificationRoute([
    new AIMessage(
      "<b>HASIL PENCARIAN TRANSAKSI</b>\n- <code>abcd1234</code> | Fore | Rp 28.000\n- <code>efgh5678</code> | Kopken | Rp 25.000",
    ),
    new HumanMessage("yang fore"),
  ]);

  assert.equal(route, "recorder");
});

test("does not route normal chat as clarification", () => {
  const route = detectClarificationRoute([
    new AIMessage("Halo, ada yang bisa dibantu?"),
    new HumanMessage("makasih ya"),
  ]);

  assert.equal(route, null);
});
