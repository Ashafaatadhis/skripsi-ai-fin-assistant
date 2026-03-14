// src/app/chains/groq_chain.ts
import { ChatGroq } from "@langchain/groq";
import {
  HumanMessage,
  SystemMessage,
  BaseMessage,
  AIMessage,
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
  FINANCE_PROMPT_TEMPLATE,
  SUMMARIZE_PROMPT_TEMPLATE,
  MEMORY_EXTRACTOR_PROMPT_TEMPLATE,
} from "@/app/chains/prompt.js";
import { saveToLongTermMemory, searchLongTermMemory } from "@/lib/memory.js";
import { getMcpTools } from "@/lib/mcp.js";
import { ToolNode } from "@langchain/langgraph/prebuilt";

// 1. Definisikan Struktur State
const GraphState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (x, y) => x.concat(y),
    default: () => [],
  }),
  context: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),
  summary: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),
});

const modelRaw = new ChatGroq({
  apiKey: process.env.GROQ_API_KEY!,
  model: "qwen/qwen3-32b",
  temperature: 0.7,
});

// Load tools from MCP server
const mcpTools = await getMcpTools();
const model = modelRaw.bindTools(mcpTools);
const toolNode = new ToolNode(mcpTools);

const cleanAIResponse = (text: string) =>
  text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

// 2. Node Retrieval
const retrieveMemory = async (
  state: typeof GraphState.State,
  config: LangGraphRunnableConfig,
) => {
  const chatId = config.configurable?.thread_id;
  if (!chatId) return { context: "" };

  const lastMessage = state.messages.findLast((m) => m.type === "human");
  if (!lastMessage) return { context: "" };

  console.log(`🔍 Mencari memori untuk: "${lastMessage.content}"`);
  const pastMemories = await searchLongTermMemory(
    chatId,
    lastMessage.content.toString(),
  );

  if (pastMemories) {
    console.log(`✅ Memori ditemukan:\n${pastMemories}`);
  } else {
    console.log(`❌ Tidak ada memori relevan ditemukan di DB.`);
  }

  return { context: pastMemories };
};

// 5. Node Memorize: Ekstrak fakta berharga dan simpan ke database
const memorizeInfo = async (
  state: typeof GraphState.State,
  config: LangGraphRunnableConfig,
) => {
  const chatId = config.configurable?.thread_id;
  if (!chatId) return {};

  const lastUserMessage = state.messages.findLast((m) => m.type === "human");
  if (!lastUserMessage) return {};

  const input = await MEMORY_EXTRACTOR_PROMPT_TEMPLATE.invoke({
    userInput: lastUserMessage.content.toString(),
  });

  const response = await model.invoke(input);
  const fact = cleanAIResponse(response.content.toString());
  console.log(fact, "CEK FAKTA (BERSIH)");

  if (fact !== "NIHIL" && fact !== "" && !fact.includes("NIHIL")) {
    console.log(`🧠 AI Mengidentifikasi Fakta Baru: ${fact}`);
    await saveToLongTermMemory(chatId, fact);
  }

  return {};
};

// 3. Node Summarization
const summarizeMessages = async (state: typeof GraphState.State) => {
  const { messages, summary } = state;

  if (messages.length > 6) {
    const summaryInput = await SUMMARIZE_PROMPT_TEMPLATE.invoke({
      summary: summary || "Belum ada",
      messages: messages.slice(0, -2), // Ringkas semua kecuali 2 terakhir
    });

    const response = await model.invoke(summaryInput);
    const cleanSummary = cleanAIResponse(response.content.toString());

    return {
      summary: cleanSummary,
      messages: messages.slice(-2),
    };
  }

  return { summary, messages };
};

// 4. Node Agent
const callModel = async (
  state: typeof GraphState.State,
  config: LangGraphRunnableConfig,
) => {
  const chatId = config.configurable?.thread_id || "unknown";

  const fullContext = `
RINGKASAN PERCAKAPAN:
${state.summary || "Tidak ada."}

MEMORI JANGKA PANJANG:
${state.context || "Tidak ada."}

ID CHAT USER: ${chatId}
(Penting: Selalu gunakan ID CHAT ini jika ingin memanggil tool transaksi keuangan)
`.trim();

  const input = await FINANCE_PROMPT_TEMPLATE.invoke({
    context: fullContext,
    messages: state.messages,
  });

  const response = await model.invoke(input);

  // Jika tidak ada tool calls, bersihkan response dari tag <think> jika ada
  if (
    !(response instanceof AIMessage) ||
    !response.tool_calls ||
    response.tool_calls.length === 0
  ) {
    const cleanContent = cleanAIResponse(response.content.toString());
    response.content = cleanContent;
  }

  return { messages: [response] };
};

// 5. Build Graph
const workflow = new StateGraph(GraphState)
  .addNode("retrieve", retrieveMemory)
  .addNode("summarize", summarizeMessages)
  .addNode("agent", callModel)
  .addNode("tools", toolNode)
  .addNode("memorize", memorizeInfo)
  .addEdge(START, "retrieve")
  .addEdge("retrieve", "summarize")
  .addEdge("summarize", "agent")
  .addConditionalEdges("agent", (state) => {
    const lastMsg = state.messages[state.messages.length - 1];
    if (
      lastMsg instanceof AIMessage &&
      lastMsg.tool_calls &&
      lastMsg.tool_calls.length > 0
    ) {
      return "tools";
    }
    return "memorize";
  })
  .addEdge("tools", "agent")
  .addEdge("memorize", END);

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
  await app.updateState(config, { messages: [], summary: "", context: "" });
  return "Sesi berhasil direset!";
}
