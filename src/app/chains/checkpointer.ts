import "dotenv/config";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { getLogger } from "@/lib/logger.js";

const logger = getLogger("checkpointer");

export function getCheckpointDatabaseUrl() {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    logger.error("Checkpoint database URL is missing", {
      eventName: "CHECKPOINTER_DATABASE_URL_MISSING",
    });
    throw new Error("DATABASE_URL wajib diisi untuk PostgresSaver.");
  }

  return databaseUrl;
}

export function createCheckpointer() {
  logger.info("Creating PostgresSaver checkpointer", {
    eventName: "CHECKPOINTER_CREATE",
    schema: "public",
  });

  return PostgresSaver.fromConnString(getCheckpointDatabaseUrl(), {
    schema: "public",
  });
}

export async function createInitializedCheckpointer() {
  const checkpointer = createCheckpointer();
  await checkpointer.setup();
  logger.info("Checkpointer setup completed", {
    eventName: "CHECKPOINTER_SETUP_DONE",
  });
  return checkpointer;
}
