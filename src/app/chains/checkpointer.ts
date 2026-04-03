import "dotenv/config";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

export function getCheckpointDatabaseUrl() {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL wajib diisi untuk PostgresSaver.");
  }

  return databaseUrl;
}

export function createCheckpointer() {
  return PostgresSaver.fromConnString(getCheckpointDatabaseUrl(), {
    schema: "public",
  });
}

export async function createInitializedCheckpointer() {
  const checkpointer = createCheckpointer();
  await checkpointer.setup();
  return checkpointer;
}
