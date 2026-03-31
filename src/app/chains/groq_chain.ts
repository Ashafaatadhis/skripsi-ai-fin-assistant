// src/app/chains/groq_chain.ts
import { ChatGroq } from "@langchain/groq";
import {
  HumanMessage,
  BaseMessage,
  AIMessage,
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
  MEMORY_AGENT_PROMPT,
  GENERAL_CHAT_AGENT_PROMPT,
  SUMMARIZE_PROMPT_TEMPLATE,
} from "@/app/chains/prompt.js";
import { getMcpTools } from "@/lib/mcp.js";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { StructuredTool } from "@langchain/core/tools";

// Definisi tipe data khusus agar tidak pakai 'any'
interface ReplaceableMessages extends Array<BaseMessage> {
  _replace?: boolean;
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
  ["add_transaction", "get_balance", "list_transactions", "get_transaction_by_id"].includes(t.name),
);
const splitBillTools = allMcpTools.filter((t) =>
  ["split_bill", "list_debts", "settle_debt", "get_debts_by_transaction", "get_debt_detail"].includes(t.name),
);
const memoryTools = allMcpTools.filter((t) =>
  ["search_memory", "save_memory"].includes(t.name),
);

const cleanAIResponse = (text: string) =>
  text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

// --- NODES ---

// 1. Supervisor Node: Menentukan agen mana yang harus dipanggil
const supervisorNode = async (state: typeof GraphState.State) => {
  const options = ["RECORDER", "SPLIT_BILL", "MEMORY", "GENERAL_CHAT"];

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
      `${SUPERVISOR_PROMPT}\n\nINFO SISTEM:\nTanggal hari ini: ${dateStr}`,
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
  if (decision.includes("MEMORY")) next = "memory";
  if (decision.includes("GENERAL_CHAT")) next = "general_chat";

  console.log(`🚀 Supervisor mengarahkan ke: ${next}`);
  return { next };
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

    const response = await agentModel.invoke(prompt);

    if (!response.tool_calls || response.tool_calls.length === 0) {
      response.content = cleanAIResponse(response.content.toString());
    }

    return { messages: [response] };
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
const memoryNode = createAgentNode("MEMORY", MEMORY_AGENT_PROMPT, memoryTools);
const generalChatNode = createAgentNode(
  "GENERAL_CHAT",
  GENERAL_CHAT_AGENT_PROMPT,
  [],
);

const summarizeMessages = async (state: typeof GraphState.State) => {
  const { messages, summary } = state;
  if (messages.length > 8) {
    console.log(
      `🧹 Membersihan memori aktif... (Jumlah pesan: ${messages.length})`,
    );
    const summaryInput = await SUMMARIZE_PROMPT_TEMPLATE.invoke({
      summary: summary || "Belum ada",
      messages: messages.slice(0, -2),
    });
    const response = await modelRaw.invoke(summaryInput);

    const trimmedMessages: ReplaceableMessages = messages.slice(-6);
    trimmedMessages._replace = true;

    return {
      summary: cleanAIResponse(response.content.toString()),
      messages: trimmedMessages,
    };
  }
  return {};
};

const workflow = new StateGraph(GraphState)
  .addNode("summarize", summarizeMessages)
  .addNode("supervisor", supervisorNode)
  .addNode("recorder", recorderNode)
  .addNode("split_bill", splitBillNode)
  .addNode("memory", memoryNode)
  .addNode("general_chat", generalChatNode)
  .addNode("tools", new ToolNode(allMcpTools))

  .addEdge(START, "summarize")
  .addEdge("summarize", "supervisor")

  .addConditionalEdges("supervisor", (state) => state.next, {
    recorder: "recorder",
    split_bill: "split_bill",
    memory: "memory",
    general_chat: "general_chat",
  })

  .addConditionalEdges("recorder", (state) => {
    const lastMsg = state.messages[state.messages.length - 1] as AIMessage;
    return (lastMsg.tool_calls?.length ?? 0) > 0 ? "tools" : END;
  })
  .addConditionalEdges("split_bill", (state) => {
    const lastMsg = state.messages[state.messages.length - 1] as AIMessage;
    return (lastMsg.tool_calls?.length ?? 0) > 0 ? "tools" : END;
  })
  .addConditionalEdges("memory", (state) => {
    const lastMsg = state.messages[state.messages.length - 1] as AIMessage;
    return (lastMsg.tool_calls?.length ?? 0) > 0 ? "tools" : END;
  })
  .addConditionalEdges("general_chat", () => {
    return END;
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
        ["add_transaction", "get_balance", "list_transactions", "get_transaction_by_id"].includes(
          toolName!,
        )
      )
        return "recorder";
      if (["split_bill", "list_debts", "settle_debt", "get_debts_by_transaction", "get_debt_detail"].includes(toolName!))
        return "split_bill";
      if (["search_memory", "save_memory"].includes(toolName!)) return "memory";
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
  return lastMessage?.content.toString() || "";
}

export async function clearChatHistory(chatId: string) {
  const config = { configurable: { thread_id: chatId } };
  await app.updateState(config, { messages: [], summary: "" });
  return "Sesi berhasil direset!";
}
