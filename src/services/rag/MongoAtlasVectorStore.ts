import mongoose from "mongoose";
import { IVectorStore, VectorItem, VectorQueryOptions, VectorQueryResult } from "./VectorStoreService";

/**
 * Atlas Vector Search implementation.
 * Uses $vectorSearch aggregation stage.
 * Vectors are stored directly in the MongoDB collection.
 *
 * NOTE: The Atlas Vector Search index must be created manually via Atlas UI.
 * See docs/atlas-vector-index-setup.md for index definitions.
 */
export class MongoAtlasVectorStore implements IVectorStore {
    /**
     * Atlas does not have a programmatic "create collection" for vector indexes.
     * The index must be created via Atlas UI or Admin API.
     * This method is a no-op but logs a reminder.
     */
    async ensureCollection(name: string, _vectorSize: number): Promise<void> {
        const db = mongoose.connection.db;
        if (!db) throw new Error("MongoDB not connected");
        const collections = await db.listCollections({ name }).toArray();
        if (collections.length === 0) {
            await db.createCollection(name);
        }
    }

    // Verify the vector_index exists by attempting a minimal $vectorSearch.
    // Call this at startup to detect missing indexes before the first real query.
    async verifyVectorIndex(collection: string): Promise<boolean> {
        const db = mongoose.connection.db;
        if (!db) return false;
        try {
            const dummyVector = new Array(1024).fill(0);
            await db.collection(collection).aggregate([
                {
                    $vectorSearch: {
                        index: "vector_index",
                        path: "embedding",
                        queryVector: dummyVector,
                        numCandidates: 1,
                        limit: 1,
                    },
                },
            ]).toArray();
            return true;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(
                `[MongoAtlasVectorStore] vector_index MISSING for collection "${collection}". ` +
                `Create it via Atlas UI — see docs/atlas-vector-index-setup.md. Error: ${msg}`,
            );
            return false;
        }
    }

    async upsert(collection: string, items: VectorItem[]): Promise<void> {
        if (items.length === 0) return;
        const db = mongoose.connection.db;
        if (!db) throw new Error("MongoDB not connected");
        const col = db.collection(collection);

        const ops = items.map((item) => ({
            updateOne: {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                filter: { _id: item.id as any },
                update: {
                    $set: {
                        embedding: item.vector,
                        ...(item.payload ?? {}),
                        updated_at: new Date(),
                    },
                    $setOnInsert: { created_at: new Date() },
                },
                upsert: true,
            },
        }));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await col.bulkWrite(ops as any, { ordered: false });
    }

    async query(
        collection: string,
        vector: number[],
        opts: VectorQueryOptions = {},
    ): Promise<VectorQueryResult[]> {
        const db = mongoose.connection.db;
        if (!db) throw new Error("MongoDB not connected");
        const col = db.collection(collection);

        const topK = opts.topK ?? 15;

        // Merge explicit filter with allergen exclusion (pre-filter at vector search level).
        // diet_tags must be declared as a filter field in the Atlas Vector Search index.
        let vectorFilter: Record<string, unknown> | undefined = opts.filter ? { ...opts.filter } : undefined;
        if (opts.excludeTags?.length) {
            vectorFilter = { ...(vectorFilter ?? {}), diet_tags: { $nin: opts.excludeTags } };
        }

        const pipeline: object[] = [
            {
                $vectorSearch: {
                    index: "vector_index",
                    path: "embedding",
                    queryVector: vector,
                    numCandidates: topK * 10,
                    limit: topK,
                    ...(vectorFilter ? { filter: vectorFilter } : {}),
                },
            },
            {
                $project: {
                    _id: 1,
                    score: { $meta: "vectorSearchScore" },
                    // FoodVector / RecipeVector fields
                    source_id: 1,
                    source_type: 1,
                    name: 1,
                    is_approved: 1,
                    // UsdaFood fields (stored in the same collection, different schema)
                    description_vi: 1,
                    description_en: 1,
                    fdc_id: 1,
                    imported_to_foods: 1,
                    // Shared
                    diet_tags: 1,
                },
            },
        ];

        if (opts.minScore !== undefined) {
            pipeline.push({ $match: { score: { $gte: opts.minScore } } });
        }

        const results = await col.aggregate(pipeline).toArray();
        return results.map((r) => ({
            id: r._id.toString(),
            score: r.score as number,
            payload: r,
        }));
    }

    async deleteByIds(collection: string, ids: string[]): Promise<void> {
        const db = mongoose.connection.db;
        if (!db) throw new Error("MongoDB not connected");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await db.collection(collection).deleteMany({ _id: { $in: ids as any[] } });
    }

    async count(collection: string): Promise<number> {
        const db = mongoose.connection.db;
        if (!db) throw new Error("MongoDB not connected");
        return db.collection(collection).countDocuments();
    }
}
