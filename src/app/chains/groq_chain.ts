import { ChatGroq } from "@langchain/groq";
import {
  BaseMessage,
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import {
  Annotation,
  Command,
  StateGraph,
  START,
  END,
  interrupt,
  type LangGraphRunnableConfig,
} from "@langchain/langgraph";
import {
  SUPERVISOR_PROMPT,
  RECORDER_AGENT_PROMPT,
  SPLIT_BILL_AGENT_PROMPT,
  GENERAL_CHAT_AGENT_PROMPT,
  SUMMARIZE_PROMPT_TEMPLATE,
  CONDENSE_SUMMARY_PROMPT_TEMPLATE,
} from "@/app/chains/prompt.js";
import { cleanAIResponse } from "@/app/chains/clarification.js";
import { createInitializedCheckpointer } from "@/app/chains/checkpointer.js";
import {
  type PendingMemoryCandidate,
  extractCheckpointMemories,
  persistPromotedMemories,
  updatePendingMemoryCandidates,
} from "@/app/chains/memory-checkpoint.js";
import {
  RECENT_RAW_TAIL_COUNT,
  estimateMessagesTokens,
  estimateSummaryTokens,
  shouldSummarizeMessages,
  shouldCondenseSummary,
} from "@/app/chains/context-budget.js";
import { getLogger, truncateForLog } from "@/lib/logger.js";
import { getMcpTools } from "@/lib/mcp.js";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { StructuredTool } from "@langchain/core/tools";

const logger = getLogger("chain");

interface ReplaceableMessages extends Array<BaseMessage> {
  _replace?: boolean;
}

const LONG_TERM_MEMORY_CHECKPOINT_EVERY = 3000;

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
  tokensSinceLastMemorySave: Annotation<number>({
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
  confirmationDecision: Annotation<string>({
    reducer: (_x, y) => y ?? _x,
    default: () => "",
  }),
});

function summarizePendingCandidates(candidates: PendingMemoryCandidate[]) {
  return candidates.map((candidate) => ({
    candidateKey: candidate.candidateKey,
    memoryType: candidate.memoryType,
    category: candidate.category,
    canonicalKey: candidate.canonicalKey,
    seenCount: candidate.seenCount,
    checkpointCount: candidate.checkpointCount,
    importanceScore: candidate.importanceScore,
    confidence: candidate.confidence,
    contentPreview: truncateForLog(candidate.content, 160),
  }));
}

function summarizeMessagesForLog(messages: BaseMessage[]) {
  return messages.slice(-RECENT_RAW_TAIL_COUNT).map((message) => ({
    type: message.getType(),
    textPreview: truncateForLog(message.content.toString(), 160),
  }));
}

function summarizeStateSnapshot(state: typeof GraphState.State) {
  return {
    summaryPreview: truncateForLog(state.summary || "", 220),
    next: state.next,
    messagesCount: state.messages.length,
    tokensSinceLastMemorySave: state.tokensSinceLastMemorySave,
    pendingMemoryCandidates: summarizePendingCandidates(state.pendingMemoryCandidates),
    forceSupervisorReroute: state.forceSupervisorReroute,
    rerouteReason: state.rerouteReason,
    recentMessages: summarizeMessagesForLog(state.messages),
  };
}

function summarizeSummaryChange(previousSummary: string, nextSummary: string) {
  return {
    previousSummaryPreview: truncateForLog(previousSummary || "", 220),
    nextSummaryPreview: truncateForLog(nextSummary || "", 220),
  };
}

function summarizeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return { value: String(error) };
}

function logMemoryEvent(eventName: string, payload: Record<string, unknown>) {
  logger.info(eventName, {
    eventName,
    ...payload,
  });
}

function formatCurrency(value: unknown) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "-";
  }

  return `Rp ${value.toLocaleString("id-ID")}`;
}

function getLastToolCallingAIMessage(messages: BaseMessage[]) {
  return [...messages]
    .reverse()
    .find(
      (message) => message instanceof AIMessage && (message as AIMessage).tool_calls?.length,
    ) as AIMessage | undefined;
}

function getPrimaryToolCall(messages: BaseMessage[]) {
  return getLastToolCallingAIMessage(messages)?.tool_calls?.[0] ?? null;
}

function needsConfirmation(toolName?: string | null) {
  return ["add_transaction", "split_bill", "settle_debt"].includes(toolName ?? "");
}

function formatAddTransactionConfirmation(args: Record<string, unknown>) {
  return [
    "Konfirmasi pencatatan transaksi:",
    `- Tipe: ${String(args.type ?? "-")}`,
    `- Jumlah: ${formatCurrency(args.amount)}`,
    `- Kategori: ${String(args.category ?? "-")}`,
    `- Merchant: ${String(args.merchant ?? "-")}`,
    'Balas "ya" untuk lanjut atau "batal" untuk membatalkan.',
  ].join("\n");
}

function formatSplitBillConfirmation(args: Record<string, unknown>) {
  const participants = Array.isArray(args.participants)
    ? args.participants.map((value) => String(value)).join(", ")
    : "-";

  return [
    "Konfirmasi split bill:",
    `- Total: ${formatCurrency(args.totalAmount)}`,
    `- Merchant: ${String(args.merchant ?? "-")}`,
    `- Peserta: ${participants || "-"}`,
    'Balas "ya" untuk lanjut atau "batal" untuk membatalkan.',
  ].join("\n");
}

function formatSettleDebtConfirmation(args: Record<string, unknown>) {
  return [
    "Konfirmasi pelunasan hutang:",
    `- Debt ID: ${String(args.debtId ?? "-")}`,
    `- Nama: ${String(args.personName ?? "-")}`,
    'Balas "ya" untuk lanjut atau "batal" untuk membatalkan.',
  ].join("\n");
}

function formatConfirmation(toolCall: { name: string; args?: Record<string, unknown> }) {
  const args = toolCall.args ?? {};
  switch (toolCall.name) {
    case "add_transaction":
      return formatAddTransactionConfirmation(args);
    case "split_bill":
      return formatSplitBillConfirmation(args);
    case "settle_debt":
      return formatSettleDebtConfirmation(args);
    default:
      return [
        `Konfirmasi menjalankan tool ${toolCall.name}.`,
        'Balas "ya" untuk lanjut atau "batal" untuk membatalkan.',
      ].join("\n");
  }
}

function normalizeConfirmationResponse(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function isConfirmed(value: unknown) {
  return ["ya", "y", "lanjut", "oke"].includes(normalizeConfirmationResponse(value));
}

function isRejected(value: unknown) {
  return ["tidak", "ga", "batal", "cancel"].includes(normalizeConfirmationResponse(value));
}

function buildCancelledConfirmationResult(
  toolCall: { id?: string; name: string },
  text: string,
) {
  const messages: BaseMessage[] = [];
  if (toolCall.id) {
    messages.push(
      new ToolMessage({
        content: "[TOOL_CANCELLED] User rejected confirmation.",
        tool_call_id: toolCall.id,
      }),
    );
  }
  messages.push(new AIMessage(text));

  return {
    confirmationDecision: "rejected",
    messages,
  };
}

const modelRaw = new ChatGroq({
  apiKey: process.env.GROQ_API_KEY!,
  model: "openai/gpt-oss-20b",
  temperature: 0.7,
});

const allMcpTools = await getMcpTools();

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

const supervisorNode = async (state: typeof GraphState.State) => {
  const options = ["RECORDER", "SPLIT_BILL", "GENERAL_CHAT"];

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

  const response = await modelRaw.invoke(prompt);
  const decision = cleanAIResponse(response.content.toString()).toUpperCase();

  let next = "general_chat";
  if (decision.includes("RECORDER")) next = "recorder";
  if (decision.includes("SPLIT_BILL")) next = "split_bill";
  if (decision.includes("GENERAL_CHAT")) next = "general_chat";

  logger.info("Supervisor selected next agent", {
    eventName: "SUPERVISOR_ROUTING_DECISION",
    next,
    state: summarizeStateSnapshot(state),
  });

  return { next, forceSupervisorReroute: false, rerouteReason: "" };
};

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

    logger.info("Agent invoked", {
      eventName: "AGENT_INVOKED",
      agentName,
      chatId,
      toolNames: tools.map((tool) => tool.name),
      state: summarizeStateSnapshot(state),
    });

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
        logger.warn("Agent tried to call unavailable tool and will reroute", {
          eventName: "AGENT_REROUTE_UNAVAILABLE_TOOL",
          agentName,
          chatId,
          unavailableToolName,
        });
        return {
          forceSupervisorReroute: true,
          rerouteReason: `Agent ${agentName} salah memilih tool ${unavailableToolName}. Pilih agent lain yang memang punya tool itu.`,
        };
      }

      logger.error("Agent invocation failed", {
        eventName: "AGENT_INVOKE_FAILED",
        agentName,
        chatId,
        error: summarizeError(error),
      });
      throw error;
    }

    if (!response.tool_calls || response.tool_calls.length === 0) {
      const cleanedContent = cleanAIResponse(response.content.toString()).trim();
      response.content = cleanedContent || getEmptyAgentFallback(agentName);
    }

    logger.info("Agent completed", {
      eventName: "AGENT_COMPLETED",
      agentName,
      chatId,
      toolCallNames: (response.tool_calls ?? []).map((toolCall) => toolCall.name),
      contentPreview: truncateForLog(response.content.toString(), 220),
    });

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

const confirmToolNode = async (state: typeof GraphState.State) => {
  const toolCall = getPrimaryToolCall(state.messages);
  if (!toolCall) {
    logger.warn("Confirmation requested but no tool call was found", {
      eventName: "TOOL_CONFIRMATION_MISSING_TOOL_CALL",
    });
    return {
      confirmationDecision: "rejected",
      messages: [new AIMessage("Maaf, aku tidak menemukan aksi yang perlu dikonfirmasi.")],
    };
  }

  const confirmationText = formatConfirmation({
    name: toolCall.name,
    args: (toolCall.args ?? {}) as Record<string, unknown>,
  });

  logger.info("Tool confirmation required", {
    eventName: "TOOL_CONFIRMATION_REQUIRED",
    toolName: toolCall.name,
    toolArgs: toolCall.args ?? {},
  });

  const firstResponse = interrupt({
    type: "tool_confirmation",
    toolName: toolCall.name,
    prompt: confirmationText,
    retryCount: 0,
  });

  if (isConfirmed(firstResponse)) {
    logger.info("Tool confirmation accepted", {
      eventName: "TOOL_CONFIRMATION_ACCEPTED",
      toolName: toolCall.name,
      userResponse: String(firstResponse ?? ""),
    });
    return { confirmationDecision: "confirmed" };
  }

  if (isRejected(firstResponse)) {
    logger.info("Tool confirmation rejected", {
      eventName: "TOOL_CONFIRMATION_REJECTED",
      toolName: toolCall.name,
      userResponse: String(firstResponse ?? ""),
    });
    return buildCancelledConfirmationResult(
      toolCall.id
        ? { id: toolCall.id, name: toolCall.name }
        : { name: toolCall.name },
      "Oke, aku batalkan aksinya ya.",
    );
  }

  logger.info("Tool confirmation ambiguous, asking once more", {
    eventName: "TOOL_CONFIRMATION_AMBIGUOUS",
    toolName: toolCall.name,
    userResponse: String(firstResponse ?? ""),
  });

  const secondResponse = interrupt({
    type: "tool_confirmation",
    toolName: toolCall.name,
    prompt: `${confirmationText}\n\nBalas hanya dengan: ya / batal`,
    retryCount: 1,
  });

  if (isConfirmed(secondResponse)) {
    logger.info("Tool confirmation accepted after retry", {
      eventName: "TOOL_CONFIRMATION_ACCEPTED_AFTER_RETRY",
      toolName: toolCall.name,
      userResponse: String(secondResponse ?? ""),
    });
    return { confirmationDecision: "confirmed" };
  }

  logger.info("Tool confirmation cancelled after ambiguous retry", {
    eventName: "TOOL_CONFIRMATION_CANCELLED_AFTER_RETRY",
    toolName: toolCall.name,
    userResponse: String(secondResponse ?? ""),
  });
  return buildCancelledConfirmationResult(
    toolCall.id
      ? { id: toolCall.id, name: toolCall.name }
      : { name: toolCall.name },
    "Aku batalkan dulu ya karena jawabannya belum jelas.",
  );
};

const summarizeMessages = async (
  state: typeof GraphState.State,
  config: LangGraphRunnableConfig,
) => {
  const { messages, summary, tokensSinceLastMemorySave, pendingMemoryCandidates } = state;
  if (shouldSummarizeMessages(messages)) {
    const chatId = config.configurable?.thread_id || "unknown";
    const droppedMessages = messages.slice(0, -RECENT_RAW_TAIL_COUNT);
    if (droppedMessages.length === 0) {
      return {};
    }

    const droppedTokens = estimateMessagesTokens(droppedMessages);
    const nextCounter = tokensSinceLastMemorySave + droppedTokens;
    logMemoryEvent("MEMORY_SHORT_TERM_SUMMARY_TRIGGER", {
      chatId,
      messageCount: messages.length,
      droppedMessageCount: droppedMessages.length,
      droppedTokens,
      messagesTokens: estimateMessagesTokens(messages),
      summaryTokens: estimateSummaryTokens(summary),
      pendingCandidateCount: pendingMemoryCandidates.length,
      tokensSinceLastMemorySave,
      nextCheckpointCounter: nextCounter,
      previousSummaryPreview: truncateForLog(summary || "", 220),
      droppedMessages: summarizeMessagesForLog(droppedMessages),
    });

    const summaryInput = await SUMMARIZE_PROMPT_TEMPLATE.invoke({
      summary: summary || "Belum ada",
      messages: droppedMessages,
    });
    const response = await modelRaw.invoke(summaryInput);
    let nextSummary = finalizeShortTermSummary(
      response.content.toString(),
      summary,
    );

    if (shouldCondenseSummary(nextSummary)) {
      logMemoryEvent("MEMORY_SHORT_TERM_SUMMARY_CONDENSE_TRIGGER", {
        chatId,
        summaryTokens: estimateSummaryTokens(nextSummary),
      });
      const condenseInput = await CONDENSE_SUMMARY_PROMPT_TEMPLATE.invoke({
        summary: nextSummary,
      });
      const condenseResponse = await modelRaw.invoke(condenseInput);
      nextSummary = finalizeShortTermSummary(
        condenseResponse.content.toString(),
        nextSummary,
      );
      logMemoryEvent("MEMORY_SHORT_TERM_SUMMARY_CONDENSE_DONE", {
        chatId,
        summaryTokens: estimateSummaryTokens(nextSummary),
      });
    }

    logMemoryEvent("MEMORY_SHORT_TERM_SUMMARY_DONE", {
      chatId,
      summaryTokens: estimateSummaryTokens(nextSummary),
      keptRawMessageCount: RECENT_RAW_TAIL_COUNT,
      ...summarizeSummaryChange(summary, nextSummary),
    });

    let nextMemorySaveCounter = nextCounter;
    let nextPendingMemoryCandidates = pendingMemoryCandidates;
    if (nextCounter >= LONG_TERM_MEMORY_CHECKPOINT_EVERY) {
      try {
        logMemoryEvent("MEMORY_LONG_TERM_CHECKPOINT_TRIGGER", {
          chatId,
          checkpointCounter: nextCounter,
          threshold: LONG_TERM_MEMORY_CHECKPOINT_EVERY,
          pendingMemoryCandidates: summarizePendingCandidates(pendingMemoryCandidates),
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
          pendingMemoryCandidates: summarizePendingCandidates(pendingCandidates),
          promotedCandidates: summarizePendingCandidates(promotedCandidates),
        });

        await persistPromotedMemories(chatId, promotedCandidates);
        nextPendingMemoryCandidates = pendingCandidates;
        nextMemorySaveCounter = 0;
        logMemoryEvent("MEMORY_LONG_TERM_CHECKPOINT_DONE", {
          chatId,
          pendingCount: nextPendingMemoryCandidates.length,
          promotedCount: promotedCandidates.length,
          tokensSinceLastMemorySave: nextMemorySaveCounter,
        });
      } catch (error) {
        logger.error("Long-term memory checkpoint failed", {
          eventName: "MEMORY_LONG_TERM_CHECKPOINT_FAILED",
          chatId,
          error: summarizeError(error),
        });
      }
    }

    const trimmedMessages: ReplaceableMessages = messages.slice(-RECENT_RAW_TAIL_COUNT);
    trimmedMessages._replace = true;

    logMemoryEvent("MEMORY_STATE_AFTER_SUMMARY", {
      chatId,
      state: {
        summaryPreview: truncateForLog(nextSummary, 220),
        messagesCount: trimmedMessages.length,
        tokensSinceLastMemorySave: nextMemorySaveCounter,
        pendingMemoryCandidates: summarizePendingCandidates(nextPendingMemoryCandidates),
        recentMessages: summarizeMessagesForLog(trimmedMessages),
      },
    });

    return {
      summary: nextSummary,
      messages: trimmedMessages,
      tokensSinceLastMemorySave: nextMemorySaveCounter,
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
  .addNode("confirm_tool", confirmToolNode)
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
    const toolCall = getPrimaryToolCall(state.messages);
    if (!toolCall) return END;
    return needsConfirmation(toolCall.name) ? "confirm_tool" : "tools";
  })
  .addConditionalEdges("split_bill", (state) => {
    if (state.forceSupervisorReroute) return "supervisor";
    const toolCall = getPrimaryToolCall(state.messages);
    if (!toolCall) return END;
    return needsConfirmation(toolCall.name) ? "confirm_tool" : "tools";
  })
  .addConditionalEdges("general_chat", (state) => {
    if (state.forceSupervisorReroute) return "supervisor";
    const toolCall = getPrimaryToolCall(state.messages);
    if (!toolCall) return END;
    return needsConfirmation(toolCall.name) ? "confirm_tool" : "tools";
  })

  .addConditionalEdges("confirm_tool", (state) => {
    return state.confirmationDecision === "confirmed" ? "tools" : END;
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

const checkpointer = await createInitializedCheckpointer();
export const app = workflow.compile({ checkpointer });

export async function runNaturalChat(chatId: string, userInput: string, options?: { resume?: boolean }) {
  const config = { configurable: { thread_id: chatId } };
  const isResume = options?.resume === true;

  logger.info("Starting app invoke", {
    eventName: isResume ? "APP_RESUME_START" : "APP_INVOKE_START",
    chatId,
    userInputPreview: truncateForLog(userInput, 250),
  });

  try {
    const output = await app.invoke(
      isResume
        ? new Command({ resume: userInput })
        : { messages: [new HumanMessage(userInput)] },
      config,
    );
    const lastMessage = output.messages[output.messages.length - 1];

    logger.info("App invoke completed", {
      eventName: "APP_INVOKE_DONE",
      chatId,
      outputState: {
        summaryPreview: truncateForLog(output.summary || "", 220),
        next: output.next,
        messagesCount: output.messages.length,
        tokensSinceLastMemorySave: output.tokensSinceLastMemorySave,
        pendingMemoryCandidates: summarizePendingCandidates(output.pendingMemoryCandidates),
        recentMessages: summarizeMessagesForLog(output.messages),
      },
      response: {
        lastMessageType: lastMessage?.constructor?.name ?? null,
        lastMessagePreview: lastMessage
          ? truncateForLog(lastMessage.content.toString(), 250)
          : null,
      },
    });

    const postInvokeState = await app.getState(config);
    const activeInterrupt = postInvokeState.tasks
      .flatMap((task) => task.interrupts ?? [])
      .find((active) => {
        const value = active.value as { type?: string } | undefined;
        return value?.type === "tool_confirmation";
      });

    if (activeInterrupt) {
      const interruptValue = activeInterrupt.value as { prompt?: string };
      logger.info("Returning active confirmation prompt to user", {
        eventName: "APP_INTERRUPT_PROMPT_RETURNED",
        chatId,
        promptPreview: truncateForLog(interruptValue.prompt ?? "", 250),
      });
      return interruptValue.prompt ?? "Balas ya atau batal.";
    }

    return lastMessage?.content.toString().trim() || "Maaf, jawabanku tadi kosong. Coba ulang ya.";
  } catch (error) {
    logger.error("App invoke failed", {
      eventName: "APP_INVOKE_FAILED",
      chatId,
      userInputPreview: truncateForLog(userInput, 250),
      error: summarizeError(error),
    });
    throw error;
  }
}

export async function clearChatHistory(chatId: string) {
  const config = { configurable: { thread_id: chatId } };
  await app.updateState(config, {
    messages: [],
    summary: "",
    tokensSinceLastMemorySave: 0,
    pendingMemoryCandidates: [],
    forceSupervisorReroute: false,
    rerouteReason: "",
    confirmationDecision: "",
  });

  logger.info("Chat history cleared", {
    eventName: "APP_CLEAR_CHAT_HISTORY",
    chatId,
    resetState: {
      summary: "",
      messagesCount: 0,
      tokensSinceLastMemorySave: 0,
      pendingMemoryCandidates: [],
      forceSupervisorReroute: false,
      rerouteReason: "",
      confirmationDecision: "",
    },
  });

  return "Sesi berhasil direset!";
}
