# Skripsi: Sistem Manajemen Kosan Berbasis Conversational AI

## Konsep

Sistem manajemen kosan yang dapat diakses melalui **dua interface**: chatbot (Telegram) dan web dashboard. Keduanya terhubung ke backend yang sama sehingga data selalu sinkron.

**Dua role utama:**
- **Penyewa** — cari kamar, booking, bayar sewa, lapor kerusakan
- **Pemilik** — kelola kamar, konfirmasi booking, lihat laporan

**Novelty akademis:**
- Conversational AI dengan arsitektur memori bertingkat (short-term + long-term)
- Multi-role subagent routing (penyewa vs pemilik dalam satu sistem)
- Human-in-the-loop (HITL) pada proses booking dan pembayaran
- Rekomendasi kamar yang semakin personal seiring percakapan (long-term memory)
- Interface hybrid: chatbot + web dalam satu sistem terintegrasi

---

## Tech Stack

| Layer | Teknologi |
|---|---|
| Chatbot AI | LangGraph, LangChain, Groq |
| Bot Interface | Telegram Bot API |
| MCP Server | NestJS, TypeScript |
| Database | PostgreSQL + pgvector |
| Payment | bayar.gg |
| File Storage | Cloudinary / S3 (foto kamar) |
| Web Frontend | (Next.js / React — dikerjakan belakangan) |

---

## Arsitektur Sistem

```
PENYEWA                          PEMILIK
   │                                │
   ├─ Telegram Bot                  ├─ Telegram Bot
   └─ Web (dashboard)               └─ Web (dashboard)
            │                                │
            └──────────┬─────────────────────┘
                       │
              ┌────────▼────────┐
              │   AI Chatbot    │
              │  (LangGraph)    │
              └────────┬────────┘
                       │
              ┌────────▼────────┐
              │   Supervisor    │  ← detect role + intent
              └────┬────────────┘
                   │
      ┌────────────┼──────────────────┐
      ▼            ▼                  ▼
 SearchAgent   BookingAgent      PaymentAgent  (penyewa)
 PropertyAgent BookingMgmtAgent  ReportAgent   (pemilik)
 ComplaintAgent
      │
      ▼
 MCP Server (NestJS)
      │
      ▼
 PostgreSQL + bayar.gg
```

---

## Arsitektur Agent (LangGraph)

### Cara Kerja Umum

1. User kirim pesan ke Telegram
2. Handler cek apakah ada **active interrupt** (HITL sedang menunggu konfirmasi)
3. Kalau ada interrupt → `resume` dengan input user
4. Kalau tidak → invoke graph normal
5. Graph jalan: `START → summarize → supervisor → agent → (confirm_tool?) → tools → END`

### Supervisor Node

Supervisor membaca pesan terakhir dan memutuskan agent mana yang dipanggil.

```
Input: pesan user + role user (penyewa/pemilik)
Output: nama agent berikutnya

Contoh routing:
- "cari kamar dekat UGM" → SearchAgent
- "saya mau booking kamar 3" → BookingAgent
- "konfirmasi booking dari Budi" → BookingMgmtAgent
- "berapa pendapatan bulan ini" → ReportAgent
```

**Penting:** Supervisor harus tahu **role user** (penyewa atau pemilik) sebelum routing. Role disimpan di database berdasarkan `telegram_user_id`.

### Subagent — Penyewa

| Agent | Tugas | Tools |
|---|---|---|
| `SearchAgent` | Cari kamar, tanya fasilitas, bandingkan | `search_rooms`, `get_room_detail` |
| `BookingAgent` | Proses booking, cek ketersediaan | `create_booking`, `get_booking_status`, `cancel_booking` |
| `PaymentAgent` | Bayar sewa, cek tagihan, riwayat bayar | `create_payment`, `get_payment_status`, `get_payment_history` |
| `ComplaintAgent` | Lapor kerusakan, track status komplain | `submit_complaint`, `get_complaint_status` |

### Subagent — Pemilik

| Agent | Tugas | Tools |
|---|---|---|
| `PropertyAgent` | Tambah/edit kamar, upload foto, update status | `add_room`, `update_room`, `upload_photo`, `set_room_status` |
| `BookingMgmtAgent` | Konfirmasi/tolak booking masuk | `confirm_booking`, `reject_booking`, `list_pending_bookings` |
| `ReportAgent` | Ringkasan pendapatan, kamar terisi, komplain | `get_occupancy_report`, `get_payment_report`, `list_complaints` |

### Conditional Routing (setelah agent node)

```typescript
// PENTING: cek hanya LAST MESSAGE, bukan seluruh history
// Bug kalau scan seluruh history: tool call lama ikut terdeteksi → looping

.addConditionalEdges("booking_agent", (state) => {
  if (state.forceSupervisorReroute) return "supervisor";
  const lastMessage = state.messages[state.messages.length - 1];
  if (!(lastMessage instanceof AIMessage)) return END;
  const toolCall = lastMessage.tool_calls?.[0] ?? null;
  if (!toolCall) return END;
  return needsConfirmation(toolCall.name) ? "confirm_tool" : "tools";
})
```

**Write tools yang butuh konfirmasi (HITL):**
- `create_booking`
- `confirm_booking`
- `reject_booking`
- `create_payment`
- `submit_complaint`

---

## Memory Architecture

### Short-term Memory

Menyimpan konteks percakapan aktif per user.

```
[HumanMessage, AIMessage, HumanMessage, AIMessage, ...]
         ↓ kalau token > MESSAGE_TOKEN_LIMIT (1000 token)
RINGKASAN (summary) + 6 pesan terakhir (RECENT_RAW_TAIL_COUNT)
         ↓ kalau summary token > SUMMARY_TOKEN_LIMIT (500 token)
Summary dikondensasi lagi
```

**Trigger summarize:** Berbasis token, bukan jumlah pesan
- `shouldSummarizeMessages(messages)` — cek apakah total token pesan > 1000
- `shouldCondenseSummary(summary)` — cek apakah token summary > 500

**Estimasi token:**
```typescript
function estimateTokens(text: string) {
  return Math.ceil(text.trim().length / 4); // 1 token ≈ 4 karakter
}
```

**Disimpan di:** PostgresSaver (PostgreSQL) — bukan RAM, persistent antar session

### Long-term Memory

Menyimpan fakta penting tentang user yang perlu diingat jangka panjang.

```
Setiap summarize → counter token naik
Counter > LONG_TERM_CHECKPOINT_EVERY (3000 token)
  → ekstrak memori dari summary + pesan terakhir
  → simpan ke PostgreSQL via MCP tool save_memory
  → counter reset ke 0
```

**Tipe memori yang disimpan:**
- `fact` — fakta tentang user: "penyewa lebih suka kamar yang ada AC"
- `episode` — ringkasan kejadian: "user booking Kamar 3 di Kosan Melati"

**Promotion logic:**
- Setiap checkpoint, fakta diekstrak dan masuk `pendingMemoryCandidates`
- Kalau fakta muncul lagi di checkpoint berikutnya (seenCount naik) → dipromote ke long-term
- Setelah dipromote → disimpan ke DB via `save_memory` tool

**topicKey:** Identifier stabil untuk episode agar episode yang sama tidak tersimpan duplikat
```typescript
// Contoh topicKey: "booking_kamar_3_kosan_melati"
// Bukan berdasarkan content (bisa berubah wording), tapi topik yang sama
```

### GraphState Fields

```typescript
const GraphState = Annotation.Root({
  messages: Annotation<ReplaceableMessages>(...),   // pesan aktif
  summary: Annotation<string>(...),                  // ringkasan short-term
  next: Annotation<string>(...),                     // agent berikutnya
  tokensSinceLastMemorySave: Annotation<number>(...),// counter long-term
  pendingMemoryCandidates: Annotation<...>(...),     // kandidat long-term
  forceSupervisorReroute: Annotation<boolean>(...),  // flag error reroute
  rerouteReason: Annotation<string>(...),            // alasan reroute
  confirmationDecision: Annotation<string>(...),     // hasil HITL
});
```

---

## Human-in-the-Loop (HITL)

### Cara Kerja

```
Agent node → last message punya tool_calls → needsConfirmation? → confirm_tool node
  ↓
interrupt() dipanggil → app.invoke() return (paused)
  ↓
runNaturalChat cek postInvokeState.tasks → ada activeInterrupt?
  → return interrupt.value.prompt ke user (pesan konfirmasi)
  ↓
User balas "ya" / "batal"
  ↓
handler.ts cek hasActiveInterrupt = true
  → runNaturalChat(..., { resume: true })
  → app.invoke(new Command({ resume: userInput }))
  ↓
Graph resume di confirm_tool → cek isConfirmed/isRejected
  → confirmed: lanjut ke tools
  → rejected: inject ToolMessage dummy + AIMessage cancel → END
```

### Detect Active Interrupt (handlers.ts)

```typescript
const graphState = await app.getState(config);
const hasActiveInterrupt = graphState.tasks.some(
  (task) => (task.interrupts?.length ?? 0) > 0,
);
const aiResponse = await runNaturalChat(chatId, userText, {
  resume: hasActiveInterrupt,
});
```

### Return Confirmation Prompt (runNaturalChat)

```typescript
// Setelah app.invoke(), cek apakah ada interrupt aktif
const postInvokeState = await app.getState(config);
const activeInterrupt = postInvokeState.tasks
  .flatMap((task) => task.interrupts ?? [])
  .find((active) => {
    const value = active.value as { type?: string } | undefined;
    return value?.type === "tool_confirmation";
  });

if (activeInterrupt) {
  const interruptValue = activeInterrupt.value as { prompt?: string };
  return interruptValue.prompt ?? "Balas ya atau batal.";
}
```

### Dangling tool_calls Fix

Kalau user batal, AIMessage dengan tool_calls tidak boleh dibiarkan tanpa ToolMessage pasangannya (LangGraph akan error). Fix:

```typescript
function buildCancelledConfirmationResult(toolCall, text) {
  const messages = [];
  if (toolCall.id) {
    messages.push(new ToolMessage({
      content: "[TOOL_CANCELLED] User rejected confirmation.",
      tool_call_id: toolCall.id,
    }));
  }
  messages.push(new AIMessage(text));
  return { confirmationDecision: "rejected", messages };
}
```

---

## MCP Tools — Domain Kosan

### Penyewa

```typescript
search_rooms({
  location?: string,
  maxPrice?: number,
  facilities?: string[],  // ["AC", "wifi", "parkir"]
  type?: string,           // "kost putra/putri/campur"
})

get_room_detail({ roomId: string })

create_booking({
  roomId: string,
  startDate: string,   // ISO date
  duration: number,    // bulan
})

get_booking_status({ bookingId: string })
cancel_booking({ bookingId: string })

create_payment({ bookingId: string })   // generate payment link bayar.gg
get_payment_status({ paymentId: string })
get_payment_history()

submit_complaint({
  roomId: string,
  description: string,
  photoUrl?: string,
})
get_complaint_status({ complaintId: string })
```

### Pemilik

```typescript
add_room({
  name: string,
  price: number,
  type: string,
  facilities: string[],
  description: string,
})

update_room({ roomId: string, ...updates })
set_room_status({ roomId: string, status: "available" | "occupied" | "maintenance" })
upload_photo({ roomId: string, photoBase64: string })  // dari foto Telegram

list_pending_bookings()
confirm_booking({ bookingId: string })
reject_booking({ bookingId: string, reason: string })

get_occupancy_report()   // kamar terisi vs kosong
get_payment_report({ month?: string })
list_complaints({ status?: "open" | "resolved" })
resolve_complaint({ complaintId: string, resolution: string })
```

---

## Flow Payment (bayar.gg)

**Model: Langsung ke rekening pemilik** — platform tidak pegang uang, bayar.gg langsung transfer ke rekening pemilik setelah penyewa bayar.

```
1. User: "saya mau bayar sewa bulan ini"
2. PaymentAgent → tool create_payment(bookingId)
3. MCP Server → hit bayar.gg API dengan data:
     - amount: nominal sewa
     - destination: rekening pemilik (dari tabel bank_accounts)
     - external_id: payment ID internal
   → dapat payment_url
4. Bot kirim ke user: "Silakan bayar di sini: [link]"
5. User bayar di bayar.gg
6. bayar.gg proses transfer → langsung ke rekening pemilik
7. bayar.gg kirim webhook POST ke MCP Server
8. MCP Server update payments table: status = "paid"
9. MCP Server notifikasi penyewa + pemilik via Telegram
```

**Endpoint webhook di MCP Server:**
```
POST /payments/webhook/bayargg
```

**Tambahan tabel untuk rekening pemilik:**
```sql
bank_accounts (
  id UUID PRIMARY KEY,
  owner_id UUID REFERENCES users(id),
  bank_name VARCHAR(50),      -- BCA, Mandiri, BRI, dll
  account_number VARCHAR(30),
  account_name VARCHAR(100),  -- nama pemilik rekening
  is_primary BOOLEAN          -- rekening utama
)
```

**Onboarding pemilik — tambah step rekening:**
```
Bot: "Terakhir, masukkan info rekening bank kamu
      untuk menerima pembayaran sewa."
Bot: "Nama bank? (BCA/Mandiri/BRI/dll)"
User: "BCA"
Bot: "Nomor rekening?"
User: "1234567890"
Bot: "Nama pemilik rekening?"
User: "Budi Santoso"
Bot: "Siap! Rekening BCA atas nama Budi Santoso berhasil didaftarkan."
```

---

## Database Schema

```sql
-- User (penyewa dan pemilik)
users (
  id UUID PRIMARY KEY,
  telegram_id BIGINT UNIQUE,
  role VARCHAR(10),  -- 'tenant' | 'owner'
  name VARCHAR(100),
  phone VARCHAR(20),
  created_at TIMESTAMP
)

-- Kosan (milik owner)
kosan (
  id UUID PRIMARY KEY,
  owner_id UUID REFERENCES users(id),
  name VARCHAR(100),
  address TEXT,
  description TEXT,
  created_at TIMESTAMP
)

-- Kamar
rooms (
  id UUID PRIMARY KEY,
  kosan_id UUID REFERENCES kosan(id),
  name VARCHAR(50),
  price INTEGER,           -- per bulan
  type VARCHAR(20),        -- putra/putri/campur
  facilities TEXT[],
  status VARCHAR(20),      -- available/occupied/maintenance
  description TEXT,
  photos TEXT[]            -- array URL foto
)

-- Booking
bookings (
  id UUID PRIMARY KEY,
  room_id UUID REFERENCES rooms(id),
  tenant_id UUID REFERENCES users(id),
  start_date DATE,
  end_date DATE,
  status VARCHAR(20),      -- pending/confirmed/rejected/cancelled/active/ended
  created_at TIMESTAMP
)

-- Pembayaran
payments (
  id UUID PRIMARY KEY,
  booking_id UUID REFERENCES bookings(id),
  amount INTEGER,
  status VARCHAR(20),      -- pending/paid/failed/expired
  payment_url TEXT,
  external_id VARCHAR(100),  -- ID dari bayar.gg
  paid_at TIMESTAMP,
  created_at TIMESTAMP
)

-- Komplain
complaints (
  id UUID PRIMARY KEY,
  room_id UUID REFERENCES rooms(id),
  tenant_id UUID REFERENCES users(id),
  description TEXT,
  photo_url TEXT,
  status VARCHAR(20),      -- open/in_progress/resolved
  resolution TEXT,
  created_at TIMESTAMP,
  resolved_at TIMESTAMP
)

-- Long-term memory (sudah ada di repo lama)
memories (
  id UUID PRIMARY KEY,
  chat_id VARCHAR(100),    -- telegram_id
  memory_type VARCHAR(20), -- fact/episode
  content TEXT,
  embedding VECTOR(1536),  -- pgvector
  importance_score FLOAT,
  created_at TIMESTAMP
)

-- LangGraph checkpoint (sudah ada)
checkpoints (PostgresSaver tables)
```

---

## Arsitektur Bot (Dua Bot, Satu Backend)

Dua bot Telegram terpisah, tapi satu backend dan satu database.

```
@KosanTenantBot ──┐
                  ├──→ Backend + AI Layer ──→ MCP Server ──→ PostgreSQL
@KosanOwnerBot ───┘
```

**Kenapa dua bot:**
- Tidak perlu role detection — role sudah pasti dari bot mana yang dipakai
- Supervisor lebih simple, langsung routing ke task yang sesuai role
- Lebih aman — tools penyewa dan pemilik tidak bisa tertukar
- Lebih mudah dijelaskan di skripsi

**Deployment:** Satu server, dua handler (beda token Telegram).

---

## Auto-Registration (Onboarding)

User tidak perlu daftar manual. Saat pertama kali chat, akun dibuat otomatis.

### Alur

```
User pertama kali kirim pesan
  → handler cek telegram_id di tabel users
  → tidak ada → buat user baru otomatis
  → ada → pakai user yang sudah ada
  → lanjut proses pesan normal
```

### Implementasi di Handler

```typescript
async function getOrCreateUser(ctx: Context) {
  const telegramId = ctx.from.id;

  let user = await db.users.findByTelegramId(telegramId);

  if (!user) {
    user = await db.users.create({
      telegramId,
      name: ctx.from.first_name,
      // role langsung dari bot mana yang dipakai
      role: ctx.botInfo.username.includes("owner") ? "owner" : "tenant",
    });

    // Sambut user baru + mulai onboarding
    await ctx.reply(`Halo ${user.name}! Selamat datang...`);
  }

  return user;
}
```

### Data dari Telegram (Otomatis, Tanpa User Isi Form)

- `telegram_id` — unik per user, tidak bisa berubah
- `first_name`, `last_name`
- `username` (opsional, tidak semua user punya)

### Onboarding Conversational

Data tambahan dikumpulkan lewat chat, bukan form.

**Penyewa (saat pertama kali):**
```
Bot: "Halo [nama]! Selamat datang di KosanBot.
      Sebelum mulai, boleh tahu nomor HP kamu?
      (untuk konfirmasi booking)"
User: "08123456789"
Bot: "Siap! Sekarang kamu bisa mulai cari kosan."
```

**Pemilik (saat pertama kali):**
```
Bot: "Halo [nama]! Selamat datang.
      Untuk mulai, kami perlu beberapa info kosan kamu.
      Pertama, nama kosan kamu apa?"
User: "Kosan Melati"
Bot: "Alamat lengkapnya?"
User: "Jl. Mawar No. 5, Sleman, Yogyakarta"
Bot: "Siap! Kosan kamu sudah terdaftar."
```

Data onboarding ini dikumpulkan secara conversational menggunakan state machine sederhana di handler — bukan lewat LangGraph, agar tidak membebani AI untuk task yang deterministik.

---

## End-to-End Flow Booking

Alur lengkap dari penyewa cari kamar hingga booking dikonfirmasi pemilik.

```
PENYEWA                          SISTEM                        PEMILIK
   │                                │                              │
   │ "cari kamar dekat UGM          │                              │
   │  max 1 juta, ada wifi"         │                              │
   │ ─────────────────────────────► │                              │
   │                                │ SearchAgent → search_rooms   │
   │                                │ ◄── hasil kamar tersedia ──  │
   │ ◄── daftar kamar + detail ──── │                              │
   │                                │                              │
   │ "mau booking Kamar 2           │                              │
   │  mulai 1 Mei, 3 bulan"         │                              │
   │ ─────────────────────────────► │                              │
   │                                │ BookingAgent →               │
   │                                │ HITL interrupt()             │
   │ ◄── "Konfirmasi booking:        │                              │
   │      Kamar 2, 1 Mei-1 Ags      │                              │
   │      Rp 3.000.000. Lanjut?"─── │                              │
   │                                │                              │
   │ "ya"                           │                              │
   │ ─────────────────────────────► │                              │
   │                                │ create_booking() → DB        │
   │                                │ status: pending              │
   │                                │                              │
   │ ◄── "Booking berhasil, tunggu  │ ──── notifikasi ────────────►│
   │      konfirmasi pemilik" ────  │      "Ada booking baru       │
   │                                │       dari [nama] untuk      │
   │                                │       Kamar 2. Konfirmasi?"  │
   │                                │                              │
   │                                │              "konfirmasi"    │
   │                                │ ◄────────────────────────────│
   │                                │ BookingMgmtAgent →           │
   │                                │ HITL interrupt()             │
   │                                │ "Konfirmasi booking Budi     │
   │                                │  Kamar 2. Lanjut?"           │
   │                                │              "ya"            │
   │                                │ ◄────────────────────────────│
   │                                │ confirm_booking() → DB       │
   │                                │ status: confirmed            │
   │ ◄── "Booking kamu sudah        │                              │
   │      dikonfirmasi pemilik!" ── │ ◄── "Booking berhasil        │
   │                                │       dikonfirmasi" ─────────│
   │                                │                              │
   │ "mau bayar sekarang"           │                              │
   │ ─────────────────────────────► │                              │
   │                                │ PaymentAgent →               │
   │                                │ create_payment() →           │
   │                                │ bayar.gg API                 │
   │ ◄── "Silakan bayar di: [link]" │                              │
   │                                │                              │
   │  [user bayar di bayar.gg]      │                              │
   │                                │ ◄── webhook paid             │
   │                                │ update DB: status paid       │
   │ ◄── "Pembayaran berhasil!" ─── │ ──── notifikasi ────────────►│
   │                                │      "Pembayaran dari Budi   │
   │                                │       sudah masuk!"          │
```

---

## Notifikasi ke Pemilik

Saat ada event penting, sistem harus proaktif kirim pesan ke pemilik tanpa pemilik harus tanya dulu.

### Event yang Trigger Notifikasi

| Event | Notifikasi ke Pemilik |
|---|---|
| Booking baru masuk | "Ada booking baru dari [nama] untuk [kamar]" |
| Pembayaran berhasil | "Pembayaran dari [nama] sudah masuk Rp X" |
| Komplain baru | "Ada komplain baru dari [nama]: [deskripsi]" |
| Booking dibatalkan penyewa | "Booking [nama] untuk [kamar] dibatalkan" |

### Implementasi Teknis

Pemilik punya `telegram_id` yang tersimpan di tabel `users`. MCP Server bisa kirim notifikasi langsung lewat Telegram Bot API.

```typescript
// Di MCP Server (NestJS) — setelah event terjadi
async function notifyOwner(ownerId: string, message: string) {
  const owner = await db.users.findById(ownerId);
  if (!owner?.telegramId) return;

  await telegramBot.sendMessage(owner.telegramId, message);
}

// Contoh: setelah booking dibuat
async function createBooking(dto: CreateBookingDto) {
  const booking = await db.bookings.create(dto);
  const room = await db.rooms.findById(dto.roomId);
  const kosan = await db.kosan.findById(room.kosanId);
  const tenant = await db.users.findById(dto.tenantId);

  await notifyOwner(
    kosan.ownerId,
    `Ada booking baru dari ${tenant.name} untuk ${room.name}.\n` +
    `Mulai: ${dto.startDate}, durasi ${dto.duration} bulan.\n` +
    `Balas "konfirmasi" atau "tolak" di bot pemilik.`
  );

  return booking;
}
```

### Catatan Penting

- Notifikasi dikirim dari **MCP Server**, bukan dari AI layer
- MCP Server perlu inisialisasi Telegram Bot instance sendiri (pakai token yang sama dengan owner bot)
- Notifikasi ini bersifat **satu arah** — hanya kirim pesan, tidak masuk ke graph AI

---

## Semantic Search dengan pgvector

Long-term memory memakai pgvector untuk **semantic search** — mencari memori yang relevan berdasarkan makna, bukan kata kunci exact.

### Kapan Dipakai

**Saat SearchAgent cari kamar:**
```
User: "cari yang cocok buat aku"
  → sistem ambil long-term memory user via semantic search
  → dapat: "user suka kamar yang tenang, ada AC, dekat kampus"
  → SearchAgent pakai preferensi ini sebagai filter tambahan
```

**Saat agent butuh konteks tentang user:**
```
User: "gimana status booking aku yang bulan lalu?"
  → search_memory("booking bulan lalu")
  → dapat episode: "user booking Kamar 2 Kosan Melati, Maret 2025"
  → agent jawab dengan konteks yang tepat
```

### Cara Kerja

```
1. Saat simpan memori:
   content → embedding model → vector (1536 dimensi) → simpan di DB

2. Saat query memori:
   query text → embedding model → vector
   → cosine similarity search di pgvector
   → ambil top-K memori paling relevan
   → inject ke context agent
```

### Relevansi untuk Domain Kosan

| Memori yang Disimpan | Berguna Untuk |
|---|---|
| "suka kamar yang ada AC dan parkir motor" | Rekomendasi otomatis saat search |
| "budget maksimal 1 juta per bulan" | Filter harga otomatis |
| "pernah komplain soal kebisingan" | Rekomendasi kamar yang tenang |
| "booking Kamar 2 Kosan Melati aktif" | Status booking tanpa harus cek manual |
| "bayar sewa selalu di awal bulan" | Reminder pembayaran |

---

## Batasan Sistem (Limitasi)

Hal-hal yang **tidak** dikerjakan dan bisa dijelaskan sebagai limitasi di skripsi.

### Limitasi Teknis

- **Tidak ada real-time tracking pengiriman** — domain kosan tidak butuh ini
- **Upload foto hanya via Telegram** — tidak bisa dari web (fase awal)
- **Satu kamar satu pemilik** — tidak support co-ownership
- **Payment hanya via bayar.gg** — tidak ada opsi transfer manual yang terverifikasi otomatis
- **Notifikasi hanya via Telegram** — tidak ada email/SMS
- **Onboarding pemilik manual** — pemilik tidak bisa self-register, harus diverifikasi admin dulu (untuk mencegah data kosan palsu)

### Limitasi AI

- **Estimasi token kasar** — pakai `length / 4`, bukan tokenizer sesungguhnya
- **Memori tidak real-time** — long-term memory baru terupdate setelah threshold token tercapai, bukan setiap pesan
- **Supervisor bisa salah routing** — LLM tidak selalu sempurna, ada fallback reroute tapi tidak 100%
- **Bahasa** — dioptimalkan untuk Bahasa Indonesia, performa bisa turun kalau user pakai bahasa campuran

### Saran untuk Future Work

- Integrasi kurir / tracking pengiriman barang penyewa
- Multi-bahasa (Indonesia + Inggris)
- Voice message support
- Notifikasi otomatis H-3 jatuh tempo pembayaran
- Verifikasi identitas penyewa (KTP)
- Rating dan review kosan

---

## Prioritas Pengerjaan

### Fase 1: Core Chatbot (Prioritas Utama)
- [ ] Setup project baru (atau fork dari repo lama)
- [ ] Desain database schema
- [ ] Implementasi MCP tools (penyewa dulu)
- [ ] Supervisor + subagent penyewa (Search, Booking, Payment)
- [ ] Memory architecture (reuse dari repo lama)
- [ ] HITL confirmation untuk booking dan payment
- [ ] Integrasi bayar.gg

### Fase 2: Pemilik via Chatbot
- [ ] Subagent pemilik (PropertyAgent, BookingMgmt, Report)
- [ ] MCP tools pemilik
- [ ] Upload foto kamar via Telegram
- [ ] Notifikasi ke pemilik saat ada booking baru

### Fase 3: Web Dashboard
- [ ] Dashboard penyewa (riwayat booking, status bayar)
- [ ] Dashboard pemilik (laporan, kelola kamar)
- [ ] Auth via Telegram (magic link)

---

## Referensi Paper untuk Skripsi

- **MemGPT** (Packer et al., 2023) — arsitektur memori bertingkat, token budget management
- **Generative Agents** (Park et al., 2023) — memory stream, reflection, retrieval
- **ReAct** (Yao et al., 2022) — reasoning + acting pattern untuk agent
- **LangGraph** — stateful multi-agent orchestration
- **MCP (Model Context Protocol)** — tool use architecture

---

## Catatan Penting

### Bug yang Harus Dihindari

**1. Routing loop karena scan seluruh history**
```typescript
// SALAH — bisa ketemu AIMessage lama dengan tool_calls
const toolCall = getPrimaryToolCall(state.messages); // scan seluruh history

// BENAR — hanya cek pesan yang baru diproduksi agent
const lastMessage = state.messages[state.messages.length - 1];
const toolCall = (lastMessage as AIMessage).tool_calls?.[0] ?? null;
```

**2. Confirmation prompt tidak sampai ke user**
```typescript
// Setelah app.invoke(), HARUS cek interrupt state
// Jangan langsung return lastMessage.content
// karena saat interrupt, lastMessage adalah AIMessage kosong dari agent
```

**3. Dangling tool_calls**
```typescript
// Kalau user batal konfirmasi, HARUS inject ToolMessage dulu
// sebelum AIMessage cancel, agar LangGraph tidak error
```

### Role Detection

Supervisor harus tahu role user sebelum routing:
```typescript
// Di awal setiap invoke, fetch role dari DB berdasarkan telegram_id
// Inject ke system prompt supervisor:
// "User ini adalah PENYEWA / PEMILIK"
```

Atau bisa juga:
- Satu bot untuk penyewa, satu bot untuk pemilik (lebih simpel)
- Deteksi otomatis dari pola pesan (lebih complex, risiko salah)
