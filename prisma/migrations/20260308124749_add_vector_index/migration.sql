-- DropIndex
DROP INDEX "embedding_idx";
CREATE INDEX IF NOT EXISTS "embedding_idx" ON "LongTermMemory" USING hnsw (embedding vector_cosine_ops);