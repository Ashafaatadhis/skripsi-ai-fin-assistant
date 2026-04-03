# Memory Flow

Dokumen ini menjelaskan arsitektur memory di `skripsi-ai-fin-assistant` dan `skripsi-mcp-server`.

Fokus utamanya:
- apa itu short-term memory
- apa itu long-term memory
- kapan short-term diringkas
- kapan long-term checkpoint jalan
- kapan kandidat memory dipending, dipromote, atau dibuang
- variabel kondisi yang dipakai sistem sekarang
- contoh flow end-to-end

## Gambaran Singkat

Flow sederhananya:

```text
raw messages
-> short-term context
-> context terlalu besar?
-> ringkas jadi summary
-> long-term checkpoint
-> extract memory candidates
-> pendingMemoryCandidates
-> promote / discard
-> save_memory
-> LongTermMemory (DB)
```

Intinya:
- pesan baru tidak langsung masuk long-term memory
- long-term memory hanya diisi lewat pipeline sistem
- `search_memory` tetap dipakai agent saat perlu retrieval

## 1. Short-Term Memory

Short-term memory adalah konteks aktif yang dipakai model untuk menjawab sekarang.

Lokasi utama:
- `src/app/chains/groq_chain.ts`
- `src/app/chains/context-budget.ts`

State yang relevan:
- `messages`
- `summary`
- `messagesSinceLastMemorySave`
- `pendingMemoryCandidates`

Isi short-term context:
- raw messages terbaru
- summary dari pesan lama yang sudah dipadatkan

## 2. Variabel Kondisi Short-Term

Lokasi:
- `src/app/chains/context-budget.ts`

Variabel aktif sekarang:

```ts
export const RECENT_RAW_TAIL_COUNT = 6;
export const SOFT_CONTEXT_LIMIT = 3500;
```

Artinya:
- `RECENT_RAW_TAIL_COUNT = 6`
  - sistem selalu berusaha menyisakan 6 raw message terakhir
- `SOFT_CONTEXT_LIMIT = 3500`
  - estimasi token (1 token ≈ 4 karakter)
  - jika ukuran gabungan `summary + messages` melewati angka ini, short-term akan diringkas

Function penting:
- `estimateTextSize(text)`
- `estimateMessageSize(message)`
- `estimateContextSize(messages, summary)`
- `shouldSummarizeMessages(messages, summary)`

Aturan short-term summary trigger:
- kalau `messages.length <= 6`, jangan summarize
- kalau `estimateContextSize(messages, summary) > 14000`, summarize

## 3. Apa yang Terjadi Saat Short-Term Diringkas

Lokasi:
- `src/app/chains/groq_chain.ts`
- function: `summarizeMessages(...)`

Yang terjadi:
1. Sistem ambil pesan lama sebagai `droppedMessages`
2. `droppedMessages` + `summary` lama dikirim ke summarizer
3. Hasilnya jadi `nextSummary`
4. Hanya 6 raw messages terbaru yang dipertahankan
5. Counter `messagesSinceLastMemorySave` ditambah sejumlah pesan yang dibuang

Variabel yang terlibat:
- `droppedMessages`
- `nextSummary`
- `trimmedMessages`
- `nextCounter`

Summary yang dipakai short-term bukan summary bebas. Prompt-nya diarahkan agar formatnya stabil, misalnya:

```text
KONTEKS AKTIF: User sedang membahas pengeluaran bulan ini.
FAKTA/PROFILE PENTING: Nama user Adhis, mahasiswa semester 8.
CATATAN LANJUT: Belum ada aksi khusus yang tertunda.
```

Contoh raw messages sebelum summarize:

```text
HUMAN: saya Adhis, sekarang mahasiswa semester 8
AI: noted
HUMAN: saya lagi mau lebih rapi ngatur pengeluaran bulanan
AI: sip
HUMAN: tadi habis beli kopi 25 ribu di Serab
AI: transaksi sudah dicatat
HUMAN: saya juga pengen nabung dana darurat 10 juta
AI: noted
```

Contoh summary yang bagus sesudah summarize:

```text
KONTEKS AKTIF: User sedang merapikan pengeluaran bulanan.
FAKTA/PROFILE PENTING: Nama user Adhis, mahasiswa semester 8, punya target dana darurat 10 juta.
CATATAN LANJUT: Fokus tetap pada budgeting; detail transaksi tunggal yang sudah selesai tidak perlu dibawa mentah.
```

Intinya:
- identitas user tetap terbawa
- target finansial tetap terbawa
- detail transaksi yang sudah selesai tidak dibawa mentah

## 4. Kapan Long-Term Checkpoint Jalan

Lokasi:
- `src/app/chains/groq_chain.ts`

Variabel aktif:

```ts
const LONG_TERM_MEMORY_CHECKPOINT_EVERY = 30;
```

Dan state:
- `messagesSinceLastMemorySave`

Aturannya:
- setiap kali ada pesan yang keluar dari raw short-term karena summarize, counter bertambah
- jika counter `>= 30`, long-term checkpoint dijalankan

Jadi long-term checkpoint:
- tidak jalan setiap pesan
- tidak agentic bebas
- jalan berdasarkan akumulasi pesan yang sudah dikompresi

## 5. Input ke Long-Term Checkpoint

Lokasi:
- `src/app/chains/memory-checkpoint.ts`
- function: `extractCheckpointMemories(...)`

Input ke extractor:
- `summary`
- `recentMessages`

Bukan seluruh history mentah.

Prompt yang dipakai:
- `MEMORY_CHECKPOINT_PROMPT_TEMPLATE`

Output yang diharapkan:
- `facts[]`
- `episodeSummary`

Contoh output:

```json
{
  "facts": [
    {
      "category": "profile",
      "canonicalKey": "profile.name",
      "content": "Nama user adalah Adhis.",
      "confidence": 0.9,
      "importanceScore": 0.8
    },
    {
      "category": "financial_goal",
      "canonicalKey": "goal.emergency_fund",
      "content": "User ingin menabung dana darurat 10 juta.",
      "confidence": 0.85,
      "importanceScore": 0.9
    }
  ],
  "episodeSummary": {
    "topicKey": "budgeting_focus",
    "content": "User sedang fokus merapikan pengeluaran bulan ini.",
    "importanceScore": 0.7
  }
}
```

Contoh input aktual ke extractor:

```text
SUMMARY CHECKPOINT:
KONTEKS AKTIF: User sedang merapikan pengeluaran bulanan.
FAKTA/PROFILE PENTING: Nama user Adhis, mahasiswa semester 8, punya target dana darurat 10 juta.
CATATAN LANJUT: User juga bilang tidak suka jawaban yang terlalu formal.

MESSAGE TERBARU:
HUMAN: saya orangnya kalau jawab jangan terlalu formal ya
AI: sip
HUMAN: targetku tetap dana darurat 10 juta dulu
AI: noted
```

Contoh output extractor yang masuk akal:

```json
{
  "facts": [
    {
      "category": "profile",
      "canonicalKey": "profile.name",
      "content": "Nama user adalah Adhis.",
      "confidence": 0.95,
      "importanceScore": 0.8
    },
    {
      "category": "constraint",
      "canonicalKey": "constraint.response_style_not_formal",
      "content": "User tidak suka jawaban yang terlalu formal.",
      "confidence": 0.88,
      "importanceScore": 0.78
    },
    {
      "category": "financial_goal",
      "canonicalKey": "goal.emergency_fund_10m",
      "content": "User menargetkan dana darurat 10 juta.",
      "confidence": 0.92,
      "importanceScore": 0.9
    }
  ],
  "episodeSummary": {
    "topicKey": "budgeting_focus",
    "content": "User sedang fokus merapikan pengeluaran dan budgeting bulan ini.",
    "importanceScore": 0.7
  }
}
```

## 6. Tipe Kandidat Memory

Lokasi:
- `src/app/chains/memory-checkpoint.ts`

Tipe utama:

### Fact
Dipakai untuk informasi yang lebih stabil.

Kategori fact yang valid sekarang:
- `profile`
- `preference`
- `financial_goal`
- `recurring_pattern`
- `constraint`

Contoh:
- `Nama user adalah Adhis.`
- `User vegetarian.`
- `User ingin nabung 10 juta.`
- `Gaji user masuk setiap tanggal 25.`
- `User tidak suka jawaban yang terlalu formal.`

### Episode Summary
Dipakai untuk konteks rangkuman episode percakapan.

Episode summary punya `topicKey` (stable identifier, snake_case) yang dipakai sebagai `candidateKey`. Ini memastikan episode yang sama, meski kalimatnya sedikit berbeda di checkpoint berikutnya, tetap dikenali sebagai kandidat yang sama dan `seenCount`-nya bisa naik.

Contoh:
- `topicKey: "budgeting_focus"`, content: `User sedang fokus mengatur pengeluaran selama bulan ini.`

## 7. Pending Memory Candidates

Hasil extraction tidak langsung masuk database.

Dia diubah dulu menjadi `pendingMemoryCandidates`.

Lokasi:
- `src/app/chains/memory-checkpoint.ts`

Type:

```ts
type PendingMemoryCandidate = {
  candidateKey: string;
  memoryType: "fact" | "episode_summary";
  category: string;
  content: string;
  canonicalKey?: string;
  confidence?: number;
  importanceScore?: number;
  firstSeenAt: string;
  lastSeenAt: string;
  seenCount: number;
  checkpointCount: number;
};
```

Makna field penting:
- `candidateKey`
  - identifier internal kandidat
- `memoryType`
  - `fact` atau `episode_summary`
- `canonicalKey`
  - key stabil untuk fact, misalnya `profile.name`
- `seenCount`
  - berapa kali kandidat yang sama muncul lagi
- `checkpointCount`
  - berapa kali kandidat tetap hidup saat checkpoint diproses
- `firstSeenAt`
  - pertama kali kandidat muncul
- `lastSeenAt`
  - terakhir kali kandidat muncul lagi

Contoh candidate fact:

```ts
{
  candidateKey: "fact:profile.name",
  memoryType: "fact",
  category: "profile",
  content: "Nama user adalah Adhis.",
  canonicalKey: "profile.name",
  confidence: 0.9,
  importanceScore: 0.8,
  firstSeenAt: "2026-04-03T10:00:00.000Z",
  lastSeenAt: "2026-04-03T10:00:00.000Z",
  seenCount: 1,
  checkpointCount: 1
}
```

Contoh candidate episode summary:

```ts
{
  candidateKey: "episode:budgeting_focus",
  memoryType: "episode_summary",
  category: "episode",
  canonicalKey: "budgeting_focus",
  content: "User sedang fokus merapikan pengeluaran bulan ini.",
  confidence: 0.7,
  importanceScore: 0.7,
  firstSeenAt: "2026-04-03T10:00:00.000Z",
  lastSeenAt: "2026-04-03T10:00:00.000Z",
  seenCount: 1,
  checkpointCount: 1
}
```

Contoh candidate yang sudah hidup 2 checkpoint:

```ts
{
  candidateKey: "fact:goal.emergency_fund_10m",
  memoryType: "fact",
  category: "financial_goal",
  content: "User menargetkan dana darurat 10 juta.",
  canonicalKey: "goal.emergency_fund_10m",
  confidence: 0.92,
  importanceScore: 0.9,
  firstSeenAt: "2026-04-03T10:00:00.000Z",
  lastSeenAt: "2026-04-05T10:00:00.000Z",
  seenCount: 2,
  checkpointCount: 2
}
```

## 8. Variabel Kondisi Pending, Promote, dan Discard

Lokasi:
- `src/app/chains/memory-checkpoint.ts`

Variabel aktif sekarang:

```ts
const FACT_PROMOTION_MIN_SEEN = 2;
const EPISODE_PROMOTION_MIN_SEEN = 2;
const EPISODE_PROMOTION_MAX_CHECKPOINTS = 3;
const EPISODE_PROMOTION_MIN_IMPORTANCE = 0.6;
const FACT_PENDING_MAX_CHECKPOINTS = 4;
const EPISODE_PENDING_MAX_CHECKPOINTS = 5;
const PENDING_CANDIDATE_MAX_AGE_DAYS = 14;
const MAX_PENDING_MEMORY_CANDIDATES = 20;
```

## 9. Kapan Candidate Dipromote

Function terkait:
- `shouldPromoteCandidate(candidate)`

### Promote Fact

Fact dipromote kalau:
- `seenCount >= 2`

Artinya fact tidak boleh auto-promote hanya karena bertahan hidup di pending.
Fact harus benar-benar muncul lagi dari hasil ekstraksi LLM.

Contoh fact yang promote:
- checkpoint 1: `Nama user adalah Adhis.` muncul -> pending, `seenCount=1`
- checkpoint 2: kandidat yang sama muncul lagi -> `seenCount=2` -> promote

Contoh fact yang tetap pending:
- checkpoint 1: muncul sekali -> pending, `seenCount=1`
- checkpoint 2: tidak muncul lagi -> `checkpointCount=2`, `seenCount=1` -> tetap pending

Contoh bentuk candidate yang sudah promote:

```ts
{
  candidateKey: "fact:profile.name",
  seenCount: 2,
  checkpointCount: 2
}
```

Contoh fact yang masih pending walau sudah hidup 2 checkpoint:

```ts
{
  candidateKey: "fact:profile.name",
  seenCount: 1,
  checkpointCount: 2
}
```

### Promote Episode Summary

Episode summary dipromote kalau:
- `importanceScore >= 0.6`
- dan salah satu terpenuhi:
  - `seenCount >= 2`
  - `checkpointCount >= 3`

Artinya episode summary lebih ketat dari fact.

Contoh episode summary yang baru boleh promote:

```ts
{
  candidateKey: "episode:user sedang fokus merapikan pengeluaran bulan ini",
  importanceScore: 0.7,
  seenCount: 1,
  checkpointCount: 3
}
```

## 10. Kapan Candidate Dibuang

Function terkait:
- `shouldDiscardCandidate(candidate, nowIso)`

Discard dicek sebelum promote.

Aturannya:

### Fact dibuang kalau:
- `checkpointCount > 4`
- atau umur candidate lebih dari 14 hari

Artinya fact sekarang punya jalur seperti ini:
- muncul sekali -> pending
- kalau muncul lagi -> promote
- kalau tidak pernah muncul lagi dan terus hidup di pending -> akhirnya dibuang

### Episode summary dibuang kalau:
- `checkpointCount > 5`
- atau umur candidate lebih dari 14 hari

Contoh candidate yang dibuang:

```ts
{
  candidateKey: "fact:preference.suka_serab",
  memoryType: "fact",
  category: "preference",
  content: "User suka Serab Coffee Brewery.",
  seenCount: 1,
  checkpointCount: 5,
  firstSeenAt: "2026-03-01T10:00:00.000Z",
  lastSeenAt: "2026-03-02T10:00:00.000Z"
}
```

Alasan dibuang:
- terlalu lama hidup di pending
- tidak cukup sering muncul lagi

## 11. Urutan Evaluasi Candidate

Saat checkpoint diproses:
1. merge pending lama + extraction baru
2. increment `checkpointCount` untuk kandidat lama
3. update `seenCount` jika kandidat muncul lagi
4. cek discard
5. cek promote
6. sisanya tetap pending
7. pending di-cap maksimal 20 kandidat

Artinya `pendingMemoryCandidates` tidak dibiarkan tumbuh tanpa batas.

## 12. Apa yang Benar-Benar Masuk Long-Term

Yang masuk long-term hanyalah `promotedCandidates`.

Function terkait:
- `persistPromotedMemories(chatId, promotedCandidates)`

Perilaku saat save:

### Untuk fact
Dipanggil ke `save_memory` dengan data seperti:
- `content`
- `memoryType: "fact"`
- `category`
- `canonicalKey`
- `confidence`
- `importanceScore`
- `sourceType: "system_checkpoint_candidate"`

### Untuk episode_summary
Dipanggil ke `save_memory` dengan data seperti:
- `content`
- `memoryType: "episode_summary"`
- `category: "episode"`
- `confidence`
- `importanceScore`
- `sourceType: "system_checkpoint_candidate"`
- `expiresAt` = sekarang + 30 hari

Contoh payload `save_memory` untuk fact:

```ts
{
  content: "Nama user adalah Adhis.",
  memoryType: "fact",
  category: "profile",
  canonicalKey: "profile.name",
  confidence: 0.95,
  importanceScore: 0.8,
  sourceType: "system_checkpoint_candidate"
}
```

Contoh payload `save_memory` untuk episode summary:

```ts
{
  content: "User sedang fokus merapikan pengeluaran dan budgeting bulan ini.",
  memoryType: "episode_summary",
  category: "episode",
  confidence: 0.7,
  importanceScore: 0.7,
  sourceType: "system_checkpoint_candidate",
  expiresAt: "2026-05-03T10:00:00.000Z"
}
```

Jadi episode summary memang sifatnya lebih sementara daripada fact.

## 13. Long-Term Memory di Server

Lokasi utama:
- `skripsi-mcp-server/src/memory/memory.service.ts`
- `skripsi-mcp-server/src/memory/memory.resolver.ts`
- `skripsi-mcp-server/prisma/schema.prisma`

Long-term memory disimpan di tabel `LongTermMemory`.

Field penting di DB:
- `chatId`
- `content`
- `memoryType`
- `category`
- `canonicalKey`
- `importanceScore`
- `confidence`
- `mentionCount`
- `lastConfirmedAt`
- `isActive`
- `sourceType`
- `expiresAt`
- `updatedAt`

Perilaku `save_memory` di server:
- insert jika memory baru
- refresh jika memory sama ditemukan lagi
- update jika `canonicalKey` sama tapi isi berubah
- skip jika input tidak layak diproses

Contoh:

### Kasus insert
Belum ada `profile.name`, lalu sistem simpan:
- `Nama user adalah Adhis.`

Status hasil:
- `inserted`

### Kasus refresh
Sudah ada `profile.name = Nama user adalah Adhis.` lalu muncul lagi persis sama.

Status hasil:
- `refreshed`

Efek:
- `mentionCount` naik
- `lastConfirmedAt` di-update

### Kasus update
Sudah ada:
- `User tinggal di Depok.`

Lalu sistem dapat fakta baru dengan `canonicalKey` sama:
- `User tinggal di Jakarta Selatan.`

Status hasil:
- `updated`

Efek:
- isi lama diganti
- embedding di-update

Contoh bentuk row konseptual di DB:

```ts
{
  chatId: "8031639685",
  memoryType: "fact",
  category: "profile",
  canonicalKey: "profile.name",
  content: "Nama user adalah Adhis.",
  importanceScore: 0.8,
  confidence: 0.95,
  mentionCount: 2,
  lastConfirmedAt: "2026-04-05T10:00:00.000Z",
  isActive: true,
  sourceType: "system_checkpoint_candidate",
  expiresAt: null
}
```

## 14. Contoh End-to-End

Contoh input user:

```text
Nama saya Adhis, sekarang mahasiswa semester 8.
```

### Tahap A: Masuk Short-Term
Yang masuk ke state:
- user message
- assistant reply

Belum ada long-term save.

### Tahap B: Context Makin Besar
Saat context melewati `SOFT_CONTEXT_LIMIT`, pesan lama diringkas.

Contoh summary:

```text
KONTEKS AKTIF: User sedang ngobrol santai.
FAKTA/PROFILE PENTING: Nama user Adhis, mahasiswa semester 8.
CATATAN LANJUT: Belum ada aksi khusus.
```

### Tahap C: Long-Term Checkpoint Jalan
Extractor menghasilkan:

```json
{
  "facts": [
    {
      "category": "profile",
      "canonicalKey": "profile.name",
      "content": "Nama user adalah Adhis.",
      "confidence": 0.9,
      "importanceScore": 0.8
    },
    {
      "category": "profile",
      "canonicalKey": "profile.education_stage",
      "content": "User adalah mahasiswa semester 8.",
      "confidence": 0.85,
      "importanceScore": 0.75
    }
  ],
  "episodeSummary": null
}
```

### Tahap D: Masuk Pending
Kedua fact menjadi `pendingMemoryCandidates`.

Kondisi awal:
- `seenCount = 1`
- `checkpointCount = 1`

Belum dipromote.

### Tahap E: Checkpoint Berikutnya
Jika fact yang sama muncul lagi di ekstraksi LLM:
- `seenCount` naik menjadi `2` -> promote

Jika fact tidak muncul lagi:
- `checkpointCount` naik tapi `seenCount` tetap 1 -> tetap pending sampai `checkpointCount > 4` lalu di-drop

### Tahap F: Save ke Long-Term
Setelah dipromote:
- `persistPromotedMemories(...)` memanggil `save_memory`
- server menyimpan ke tabel `LongTermMemory`

Baru di titik ini memory dianggap masuk long-term.

## 15. Log yang Aktif Sekarang

Event log utama:
- `MEMORY_SHORT_TERM_SUMMARY_TRIGGER`
- `MEMORY_SHORT_TERM_SUMMARY_DONE`
- `MEMORY_LONG_TERM_CHECKPOINT_TRIGGER`
- `MEMORY_LONG_TERM_CHECKPOINT_EXTRACTED`
- `MEMORY_LONG_TERM_PENDING_UPDATED`
- `MEMORY_LONG_TERM_MEMORY_SAVED`
- `MEMORY_LONG_TERM_CHECKPOINT_DONE`
- `MEMORY_LONG_TERM_CHECKPOINT_FAILED`

Arti cepat:
- `SUMMARY_TRIGGER`: short-term mulai diringkas
- `SUMMARY_DONE`: summary baru selesai dibuat
- `CHECKPOINT_TRIGGER`: long-term checkpoint mulai
- `CHECKPOINT_EXTRACTED`: facts/episode summary berhasil diekstrak
- `PENDING_UPDATED`: pending dan promoted sudah dihitung
- `MEMORY_SAVED`: promoted memories benar-benar dikirim ke save layer
- `CHECKPOINT_DONE`: satu siklus long-term selesai

Contoh payload log:

```text
MEMORY_SHORT_TERM_SUMMARY_TRIGGER {
  chatId: "8031639685",
  messageCount: 65,
  droppedMessageCount: 59,
  contextSize: 14090,
  pendingCandidateCount: 0,
  messagesSinceLastMemorySave: 0,
  nextCheckpointCounter: 59
}

MEMORY_LONG_TERM_CHECKPOINT_EXTRACTED {
  factCount: 3,
  hasEpisodeSummary: true
}

MEMORY_LONG_TERM_PENDING_UPDATED {
  pendingCount: 2,
  promotedCount: 2
}

MEMORY_LONG_TERM_MEMORY_SAVED {
  promotedCount: 2,
  savedCount: 2
}
```

## 16. Ringkasan Super Singkat

### Short-Term
Yang disimpan:
- raw messages terbaru
- summary aktif

### Pending
Yang disimpan:
- candidate memory hasil ekstraksi yang belum cukup kuat untuk masuk DB

### Long-Term
Yang disimpan:
- candidate yang sudah dipromote dan lolos save pipeline

Flow super singkat:

```text
raw messages
-> summary + recent tail
-> extracted memory candidates
-> pendingMemoryCandidates
-> promotedCandidates
-> LongTermMemory
```
