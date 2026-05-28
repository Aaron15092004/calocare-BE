import { IVectorStore, VectorItem, VectorQueryOptions, VectorQueryResult } from "./VectorStoreService";

/**
 * Qdrant Cloud fallback implementation.
 * Activate via VECTOR_STORE=qdrant env var.
 * Requires: QDRANT_URL, QDRANT_API_KEY.
 * Install: npm install @qdrant/js-client-rest
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type QdrantClient = any;

export class QdrantVectorStore implements IVectorStore {
    private client: QdrantClient;

    constructor() {
        const url = process.env.QDRANT_URL;
        const apiKey = process.env.QDRANT_API_KEY;
        if (!url) throw new Error("QDRANT_URL is not set");

        // Dynamic import u2014 only loaded when VECTOR_STORE=qdrant
        // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
        const { QdrantClient } = require("@qdrant/js-client-rest");
        this.client = new QdrantClient({ url, apiKey }) as QdrantClient;
    }

    async ensureCollection(name: string, vectorSize: number): Promise<void> {
        const existing = await this.client.getCollections();
        const found = existing.collections.find((c: { name: string }) => c.name === name);
        if (!found) {
            await this.client.createCollection(name, {
                vectors: { size: vectorSize, distance: "Cosine" },
            });
        }
    }

    async upsert(collection: string, items: VectorItem[]): Promise<void> {
        if (items.length === 0) return;
        await this.client.upsert(collection, {
            wait: true,
            points: items.map((item) => ({
                id: item.id,
                vector: item.vector,
                payload: item.payload ?? {},
            })),
        });
    }

    async query(
        collection: string,
        vector: number[],
        opts: VectorQueryOptions = {},
    ): Promise<VectorQueryResult[]> {
        const topK = opts.topK ?? 15;
        const mustConditions = opts.filter ? this._buildMust(opts.filter) : [];
        // Allergen exclusion via Qdrant must_not
        const mustNotConditions = opts.excludeTags?.length
            ? [{ key: "diet_tags", match: { any: opts.excludeTags } }]
            : [];

        const filter = (mustConditions.length > 0 || mustNotConditions.length > 0)
            ? {
                  ...(mustConditions.length > 0 ? { must: mustConditions } : {}),
                  ...(mustNotConditions.length > 0 ? { must_not: mustNotConditions } : {}),
              }
            : undefined;

        const results = await this.client.search(collection, {
            vector,
            limit: topK,
            with_payload: true,
            score_threshold: opts.minScore,
            filter,
        });

        return results.map((r: { id: string | number; score: number; payload: Record<string, unknown> }) => ({
            id: String(r.id),
            score: r.score,
            payload: r.payload as Record<string, unknown>,
        }));
    }

    async deleteByIds(collection: string, ids: string[]): Promise<void> {
        await this.client.delete(collection, { wait: true, points: ids });
    }

    async count(collection: string): Promise<number> {
        const info = await this.client.getCollection(collection);
        return (info.points_count as number) ?? 0;
    }

    private _buildMust(filter: Record<string, unknown>): object[] {
        const must: object[] = [];
        for (const [key, value] of Object.entries(filter)) {
            if (Array.isArray(value)) {
                must.push({ key, match: { any: value } });
            } else {
                must.push({ key, match: { value } });
            }
        }
        return must;
    }
}
