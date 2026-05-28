import { Document } from "mongoose";

export interface VectorItem {
    id: string;
    vector: number[];
    payload?: Record<string, unknown>;
}

export interface VectorQueryOptions {
    topK?: number;
    filter?: Record<string, unknown>;
    // Tags to exclude at the vector store level (pre-filter, not post-filter).
    // Used for allergen exclusion. Each store translates this to its own syntax.
    excludeTags?: string[];
    minScore?: number;
}

export interface VectorQueryResult {
    id: string;
    score: number;
    payload?: Record<string, unknown>;
}

/**
 * Provider-agnostic vector store interface.
 * Implementations: MongoAtlasVectorStore, QdrantVectorStore.
 */
export interface IVectorStore {
    ensureCollection(name: string, vectorSize: number): Promise<void>;
    upsert(collection: string, items: VectorItem[]): Promise<void>;
    query(collection: string, vector: number[], opts?: VectorQueryOptions): Promise<VectorQueryResult[]>;
    deleteByIds(collection: string, ids: string[]): Promise<void>;
    count(collection: string): Promise<number>;
}

let _instance: IVectorStore | null = null;

export function getVectorStore(): IVectorStore {
    if (_instance) return _instance;

    const provider = process.env.VECTOR_STORE ?? "atlas";
    if (provider === "qdrant") {
        const { QdrantVectorStore } = require("./QdrantVectorStore") as typeof import("./QdrantVectorStore");
        _instance = new QdrantVectorStore();
    } else {
        const { MongoAtlasVectorStore } = require("./MongoAtlasVectorStore") as typeof import("./MongoAtlasVectorStore");
        const store = new MongoAtlasVectorStore();
        _instance = store;

        // Verify vector indexes exist after MongoDB connects.
        // Runs once, non-blocking — logs a clear error if any index is missing.
        const INDEXED_COLLECTIONS = ["usdafoods", "foodvectors", "recipevectors"];
        setImmediate(() => {
            Promise.all(INDEXED_COLLECTIONS.map((col) => store.verifyVectorIndex(col))).catch(() => {});
        });
    }

    return _instance;
}
