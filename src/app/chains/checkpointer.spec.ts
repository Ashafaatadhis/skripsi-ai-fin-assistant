import assert from "node:assert/strict";
import test from "node:test";
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";
import { createInitializedCheckpointer } from "./checkpointer.js";

test("PostgresSaver can setup, persist, read, list, and delete checkpoints", async (t) => {
  if (!process.env.DATABASE_URL) {
    t.skip("DATABASE_URL belum diisi, integration test PostgresSaver dilewati.");
    return;
  }

  const checkpointer = await createInitializedCheckpointer();
  const threadId = `test-thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const checkpointId = `checkpoint-${Date.now()}`;
  const writeConfig = {
    configurable: {
      thread_id: threadId,
      checkpoint_ns: "",
    },
  };
  const readConfig = {
    configurable: {
      thread_id: threadId,
    },
  };

  try {
    const checkpoint = {
      ...emptyCheckpoint(),
      id: checkpointId,
      ts: new Date().toISOString(),
      channel_values: {
        messages: ["hello checkpoint"],
      },
      channel_versions: {
        __start__: 1,
        messages: 2,
      },
      versions_seen: {
        __input__: {},
        __start__: {
          __start__: 1,
        },
      },
      pending_sends: [],
    };

    const savedConfig = await checkpointer.put(
      writeConfig,
      checkpoint,
      {
        source: "input",
        step: 0,
        parents: {},
      },
      {},
    );
    assert.equal(savedConfig.configurable?.thread_id, threadId);

    const loadedTuple = await checkpointer.getTuple(readConfig);
    assert.ok(loadedTuple);
    assert.equal(loadedTuple?.checkpoint.id, checkpointId);
    assert.ok(loadedTuple.metadata);
    assert.equal(loadedTuple.metadata?.source, "input");
    assert.equal(loadedTuple.config.configurable?.thread_id, threadId);

    const listedIds: string[] = [];
    for await (const listedTuple of checkpointer.list(readConfig)) {
      listedIds.push(listedTuple.checkpoint.id);
    }

    assert.ok(listedIds.includes(checkpointId));

    await checkpointer.deleteThread(threadId);
    const deletedTuple = await checkpointer.getTuple(readConfig);
    assert.equal(deletedTuple, undefined);
  } finally {
    await checkpointer.end();
  }
});
