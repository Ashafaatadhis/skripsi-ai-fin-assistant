// src/app/chains/groq_chain.ts
import { ChatGroq } from "@langchain/groq";
import {
  BaseMessage,
  AIMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import {
  Annotation,
  StateGraph,
  MemorySaver,
  START,
  END,
  type LangGraphRunnableConfig,
} from "@langchain/langgraph";
import {
  SUPERVISOR_PROMPT,
  RECORDER_AGENT_PROMPT,
  SPLIT_BILL_AGENT_PROMPT,
  GENERAL_CHAT_AGENT_PROMPT,
  SUMMARIZE_PROMPT_TEMPLATE,
} from "@/app/chains/prompt.js";
import { cleanAIResponse } from "@/app/chains/clarification.js";
import {
  type PendingMemoryCandidate,
  extractCheckpointMemories,
  persistPromotedMemories,
  updatePendingMemoryCandidates,
} from "@/app/chains/memory-checkpoint.js";
import {
  RECENT_RAW_TAIL_COUNT,
  estimateContextSize,
  shouldSummarizeMessages,
} from "@/app/chains/context-budget.js";
import { getMcpTools } from "@/lib/mcp.js";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { StructuredTool } from "@langchain/core/tools";

// Definisi tipe data khusus agar tidak pakai 'any'
interface ReplaceableMessages extends Array<BaseMessage> {
  _replace?: boolean;
}

const LONG_TERM_MEMORY_CHECKPOINT_EVERY = 30;

function logMemoryEvent(eventName: string, payload: Record<string, unknown>) {
  console.log(`[${eventName}]`, payload);
}

function getEmptyAgentFallback(agentName: string) {
  if (agentName === "GENERAL_CHAT") {
    return "Siap, aku catat konteksnya dulu. Kalau mau, lanjut kasih tahu detail lain tentang kamu ya.";
  }

  return "Maaf, jawabanku tadi kosong. Coba ulang ya.";
}

function extractUnavailableToolName(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/attempted to call tool '([^']+)' which was not in request\.tools/i);
  return match?.[1] ?? null;
}

function finalizeShortTermSummary(nextSummary: string, previousSummary: string) {
  const cleaned = cleanAIResponse(nextSummary).trim();
  return cleaned || previousSummary;
}

// 1. Struktur State
const GraphState = Annotation.Root({
  messages: Annotation<ReplaceableMessages>({
    reducer: (x, y) => {
      if (y._replace) return y;
      return x.concat(y) as ReplaceableMessages;
    },
    default: () => [] as BaseMessage[] as ReplaceableMessages,
  }),
  summary: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),
  next: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => "supervisor",
  }),
  messagesSinceLastMemorySave: Annotation<number>({
    reducer: (x, y) => y ?? x,
    default: () => 0,
  }),
  pendingMemoryCandidates: Annotation<PendingMemoryCandidate[]>({
    reducer: (_x, y) => y ?? _x,
    default: () => [],
  }),
  forceSupervisorReroute: Annotation<boolean>({
    reducer: (_x, y) => y ?? _x,
    default: () => false,
  }),
  rerouteReason: Annotation<string>({
    reducer: (_x, y) => y ?? _x,
    default: () => "",
  }),
});

const modelRaw = new ChatGroq({
  apiKey: process.env.GROQ_API_KEY!,
  // model: "qwen/qwen3-32b",
  model: "openai/gpt-oss-20b",
  temperature: 0.7,
});

// Load tools
const allMcpTools = await getMcpTools();

// Pisahkan tools untuk agent spesifik
const recorderTools = allMcpTools.filter((t) =>
  [
    "add_transaction",
    "get_balance",
    "list_transactions",
    "find_transactions",
    "get_transaction_by_id",
  ].includes(t.name),
);
const splitBillTools = allMcpTools.filter((t) =>
  [
    "split_bill",
    "list_debts",
    "find_debts",
    "settle_debt",
    "get_debts_by_transaction",
    "get_debt_detail",
  ].includes(t.name),
);
const generalChatTools = allMcpTools.filter((t) => ["search_memory"].includes(t.name));

// --- NODES ---

// 1. Supervisor Node: Menentukan agen mana yang harus dipanggil
const supervisorNode = async (state: typeof GraphState.State) => {
  const options = ["RECORDER", "SPLIT_BILL", "GENERAL_CHAT"];

  const modelWithRouting = modelRaw;

  const now = new Date();
  const dateStr = now.toLocaleDateString("id-ID", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const prompt = [
    new SystemMessage(
      `${SUPERVISOR_PROMPT}\n\nINFO SISTEM:\nTanggal hari ini: ${dateStr}${state.forceSupervisorReroute && state.rerouteReason ? `\nREROUTE ERROR: ${state.rerouteReason}` : ""}`,
    ),
    ...state.messages.slice(-6),
    new HumanMessage(
      `Berdasarkan percakapan di atas, siapa agen yang paling tepat untuk merespon? Balas HANYA dengan salah satu kode nama agen berikut: ${options.join(", ")}.`,
    ),
  ];

  const response = await modelWithRouting.invoke(prompt);
  const decision = cleanAIResponse(response.content.toString()).toUpperCase();

  let next = "general_chat";
  if (decision.includes("RECORDER")) next = "recorder";
  if (decision.includes("SPLIT_BILL")) next = "split_bill";
  if (decision.includes("GENERAL_CHAT")) next = "general_chat";

  console.log(`🚀 Supervisor mengarahkan ke: ${next}`);
  return { next, forceSupervisorReroute: false, rerouteReason: "" };
};

// 2. Agen Nodes
const createAgentNode = (
  agentName: string,
  agentPrompt: string,
  tools: StructuredTool[],
) => {
  const agentModel = modelRaw.bindTools(tools);

  return async (
    state: typeof GraphState.State,
    config: LangGraphRunnableConfig,
  ) => {
    const chatId = config.configurable?.thread_id || "unknown";
    console.log(
      `🤖 Agen [${agentName}] dipanggil dengan ${tools.length} alat.`,
    );

    const now = new Date();
    const dateStr = now.toLocaleDateString("id-ID", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    const timeStr = now.toLocaleTimeString("id-ID", {
      hour: "2-digit",
      minute: "2-digit",
    });

    const context = `
INFO WAKTU (Gunakan hanya untuk referensi tanggal/waktu transaksi, jangan disebutkan ke user kecuali relevan):
${dateStr}, pukul ${timeStr}

RINGKASAN: ${state.summary || "Nihil"}
ID CHAT: ${chatId}
`.trim();

    const prompt = [
      new SystemMessage(`${agentPrompt}\n\nKONTEKS PENTING:\n${context}`),
      ...state.messages.slice(-6),
    ];

    let response;
    try {
      response = await agentModel.invoke(prompt);
    } catch (error) {
      const unavailableToolName = extractUnavailableToolName(error);
      if (unavailableToolName) {
        console.warn(
          `⚠️ Agent ${agentName} mencoba tool di luar scope: ${unavailableToolName}. Reroute ke supervisor.`,
        );
        return {
          forceSupervisorReroute: true,
          rerouteReason: `Agent ${agentName} salah memilih tool ${unavailableToolName}. Pilih agent lain yang memang punya tool itu.`,
        };
      }

      throw error;
    }

    if (!response.tool_calls || response.tool_calls.length === 0) {
      const cleanedContent = cleanAIResponse(response.content.toString()).trim();
      response.content = cleanedContent || getEmptyAgentFallback(agentName);
    }

    return {
      messages: [response],
    };
  };
};

const recorderNode = createAgentNode(
  "RECORDER",
  RECORDER_AGENT_PROMPT,
  recorderTools,
);
const splitBillNode = createAgentNode(
  "SPLIT_BILL",
  SPLIT_BILL_AGENT_PROMPT,
  splitBillTools,
);
const generalChatNode = createAgentNode(
  "GENERAL_CHAT",
  GENERAL_CHAT_AGENT_PROMPT,
  generalChatTools,
);

const summarizeMessages = async (
  state: typeof GraphState.State,
  config: LangGraphRunnableConfig,
) => {
  const { messages, summary, messagesSinceLastMemorySave, pendingMemoryCandidates } = state;
  if (shouldSummarizeMessages(messages, summary)) {
    const chatId = config.configurable?.thread_id || "unknown";
    const droppedMessages = messages.slice(0, -RECENT_RAW_TAIL_COUNT);
    if (droppedMessages.length === 0) {
      return {};
    }

    const nextCounter = messagesSinceLastMemorySave + droppedMessages.length;
    const estimatedContextSize = estimateContextSize(messages, summary);
    logMemoryEvent("MEMORY_SHORT_TERM_SUMMARY_TRIGGER", {
      chatId,
      messageCount: messages.length,
      droppedMessageCount: droppedMessages.length,
      contextSize: estimatedContextSize,
      pendingCandidateCount: pendingMemoryCandidates.length,
      messagesSinceLastMemorySave,
      nextCheckpointCounter: nextCounter,
    });

    const summaryInput = await SUMMARIZE_PROMPT_TEMPLATE.invoke({
      summary: summary || "Belum ada",
      messages: droppedMessages,
    });
    const response = await modelRaw.invoke(summaryInput);
    const nextSummary = finalizeShortTermSummary(
      response.content.toString(),
      summary,
    );
    logMemoryEvent("MEMORY_SHORT_TERM_SUMMARY_DONE", {
      chatId,
      summaryLength: nextSummary.length,
      keptRawMessageCount: RECENT_RAW_TAIL_COUNT,
    });

    let nextMemorySaveCounter = nextCounter;
    let nextPendingMemoryCandidates = pendingMemoryCandidates;
    if (nextCounter >= LONG_TERM_MEMORY_CHECKPOINT_EVERY) {
      try {
        logMemoryEvent("MEMORY_LONG_TERM_CHECKPOINT_TRIGGER", {
          chatId,
          checkpointCounter: nextCounter,
          threshold: LONG_TERM_MEMORY_CHECKPOINT_EVERY,
        });

        const extraction = await extractCheckpointMemories({
          summary: nextSummary,
          recentMessages: messages.slice(-RECENT_RAW_TAIL_COUNT),
          model: modelRaw,
        });
        const { pendingCandidates, promotedCandidates } = updatePendingMemoryCandidates(
          pendingMemoryCandidates,
          extraction,
          new Date().toISOString(),
        );

        logMemoryEvent("MEMORY_LONG_TERM_PENDING_UPDATED", {
          chatId,
          factCount: extraction.facts.length,
          hasEpisodeSummary: Boolean(extraction.episodeSummary),
          pendingCount: pendingCandidates.length,
          promotedCount: promotedCandidates.length,
        });

        await persistPromotedMemories(chatId, promotedCandidates);
        nextPendingMemoryCandidates = pendingCandidates;
        nextMemorySaveCounter = 0;
        logMemoryEvent("MEMORY_LONG_TERM_CHECKPOINT_DONE", {
          chatId,
          pendingCount: nextPendingMemoryCandidates.length,
          promotedCount: promotedCandidates.length,
        });
      } catch (error) {
        console.error("[MEMORY_LONG_TERM_CHECKPOINT_FAILED]", { chatId, error });
      }
    }

    const trimmedMessages: ReplaceableMessages = messages.slice(-RECENT_RAW_TAIL_COUNT);
    trimmedMessages._replace = true;

    return {
      summary: nextSummary,
      messages: trimmedMessages,
      messagesSinceLastMemorySave: nextMemorySaveCounter,
      pendingMemoryCandidates: nextPendingMemoryCandidates,
    };
  }
  return {};
};

const workflow = new StateGraph(GraphState)
  .addNode("summarize", summarizeMessages)
  .addNode("supervisor", supervisorNode)
  .addNode("recorder", recorderNode)
  .addNode("split_bill", splitBillNode)
  .addNode("general_chat", generalChatNode)
  .addNode("tools", new ToolNode(allMcpTools))

  .addEdge(START, "summarize")
  .addEdge("summarize", "supervisor")

  .addConditionalEdges("supervisor", (state) => state.next, {
    recorder: "recorder",
    split_bill: "split_bill",
    general_chat: "general_chat",
  })

  .addConditionalEdges("recorder", (state) => {
    if (state.forceSupervisorReroute) return "supervisor";
    const lastMsg = state.messages[state.messages.length - 1] as AIMessage;
    return (lastMsg.tool_calls?.length ?? 0) > 0 ? "tools" : END;
  })
  .addConditionalEdges("split_bill", (state) => {
    if (state.forceSupervisorReroute) return "supervisor";
    const lastMsg = state.messages[state.messages.length - 1] as AIMessage;
    return (lastMsg.tool_calls?.length ?? 0) > 0 ? "tools" : END;
  })
  .addConditionalEdges("general_chat", (state) => {
    if (state.forceSupervisorReroute) return "supervisor";
    const lastMsg = state.messages[state.messages.length - 1] as AIMessage;
    return (lastMsg.tool_calls?.length ?? 0) > 0 ? "tools" : END;
  })

  .addConditionalEdges("tools", (state) => {
    const lastAI = [...state.messages]
      .reverse()
      .find(
        (m) => m instanceof AIMessage && (m as AIMessage).tool_calls?.length,
      ) as AIMessage;
    if (lastAI) {
      const toolName = lastAI.tool_calls?.[0]?.name;
      if (
        [
          "add_transaction",
          "get_balance",
          "list_transactions",
          "find_transactions",
          "get_transaction_by_id",
        ].includes(toolName!)
      )
        return "recorder";
      if (
        [
          "split_bill",
          "list_debts",
          "find_debts",
          "settle_debt",
          "get_debts_by_transaction",
          "get_debt_detail",
        ].includes(toolName!)
      )
        return "split_bill";
      if (["search_memory"].includes(toolName!)) return "general_chat";
    }
    return "supervisor";
  });

const checkpointer = new MemorySaver();
export const app = workflow.compile({ checkpointer });

export async function runNaturalChat(chatId: string, userInput: string) {
  const config = { configurable: { thread_id: chatId } };
  const output = await app.invoke(
    { messages: [new HumanMessage(userInput)] },
    config,
  );
  const lastMessage = output.messages[output.messages.length - 1];
  return lastMessage?.content.toString().trim() || "Maaf, jawabanku tadi kosong. Coba ulang ya.";
}

export async function clearChatHistory(chatId: string) {
  const config = { configurable: { thread_id: chatId } };
  await app.updateState(config, {
    messages: [],
    summary: "",
    messagesSinceLastMemorySave: 0,
    pendingMemoryCandidates: [],
    forceSupervisorReroute: false,
    rerouteReason: "",
  });
  return "Sesi berhasil direset!";
}
