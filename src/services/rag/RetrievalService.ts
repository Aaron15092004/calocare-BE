import mongoose from "mongoose";
import { getEmbeddingService } from "./EmbeddingService";
import { getVectorStore, VectorQueryResult } from "./VectorStoreService";
import { reciprocalRankFusion, RankedResult } from "../../utils/rrfMerge";

export type SourceType = "food" | "recipe" | "usda";

export interface SearchOptions {
    topK?: number;
    sources?: SourceType[];
    filter?: Record<string, unknown>;
    excludeTags?: string[];
    minScore?: number;
}

export interface UnifiedSearchResult {
    source_type: SourceType;
    source_id: string;
    name: string;
    score: number;
    diet_tags: string[];
    is_approved?: boolean;
    // USDA-specific
    fdc_id?: number;
    imported_to_foods?: boolean;
    imported_food_id?: string;
}

// Mongoose collection names (lowercase plural of model name)
const COLLECTION_MAP: Record<SourceType, string> = {
    usda: "usdafoods",
    food: "foodvectors",
    recipe: "recipevectors",
};

export class RetrievalService {
    private readonly embedding = getEmbeddingService();
    private readonly store = getVectorStore();

    async vectorSearch(
        source: SourceType,
        queryVector: number[],
        opts: SearchOptions = {},
    ): Promise<VectorQueryResult[]> {
        const collection = this._collectionName(source);
        return this.store.query(collection, queryVector, {
            topK: opts.topK ?? 15,
            filter: opts.filter,
            excludeTags: opts.excludeTags,
            minScore: opts.minScore,
        });
    }

    /**
     * Hybrid search: vector + MongoDB text search merged via RRF.
     * Text search helps exact match queries like "phở bò".
     */
    async hybridSearch(
        query: string,
        source: SourceType,
        opts: SearchOptions = {},
    ): Promise<UnifiedSearchResult[]> {
        const queryVector = await this.embedding.embed(query, "query");

        const [vectorResults, textResults] = await Promise.all([
            this.vectorSearch(source, queryVector, opts),
            this._textSearch(source, query, opts.topK ?? 15),
        ]);

        const vectorRanked: RankedResult[] = vectorResults.map((r) => ({
            id: r.id,
            source_type: source,
            source_id: r.payload?.source_id as string ?? r.id,
            score: r.score,
            data: r.payload,
        }));

        const textRanked: RankedResult[] = textResults.map((r) => ({
            id: r.id,
            source_type: source,
            source_id: r.payload?.source_id as string ?? r.id,
            score: r.score,
            data: r.payload,
        }));

        const merged = reciprocalRankFusion([vectorRanked, textRanked], opts.topK ?? 15);
        return merged.map((r) => this._toUnified(r, source));
    }

    /**
     * Hybrid search across all requested sources in parallel.
     * Each source runs vector + text search, merged per-source via RRF,
     * then all per-source lists are merged globally via a second RRF pass.
     */
    async searchAll(
        query: string,
        opts: SearchOptions = {},
    ): Promise<UnifiedSearchResult[]> {
        const sources = opts.sources ?? ["usda", "food", "recipe"];
        const topK = opts.topK ?? 10;
        const queryVector = await this.embedding.embed(query, "query");

        const perSourceLists = await Promise.all(
            sources.map(async (source): Promise<RankedResult[]> => {
                const [vectorResults, textResults] = await Promise.all([
                    this.vectorSearch(source, queryVector, { topK: 15, filter: opts.filter, excludeTags: opts.excludeTags })
                        .catch(() => [] as VectorQueryResult[]),
                    this._textSearch(source, query, 15).catch(() => [] as VectorQueryResult[]),
                ]);

                const toRanked = (r: VectorQueryResult): RankedResult => ({
                    id: r.id,
                    source_type: source,
                    source_id: r.payload?.source_id as string ?? r.id,
                    score: r.score,
                    data: r.payload,
                });

                const vectorRanked = vectorResults.map(toRanked);
                const textRanked = textResults.map(toRanked);

                // Per-source RRF: fuse vector and text results
                return reciprocalRankFusion([vectorRanked, textRanked], topK + 5);
            }),
        );

        // Global RRF: fuse across all sources
        const merged = reciprocalRankFusion(perSourceLists, topK);
        return merged.map((r) => this._toUnified(r, r.source_type as SourceType));
    }

    private async _textSearch(
        source: SourceType,
        query: string,
        limit: number,
    ): Promise<VectorQueryResult[]> {
        const db = mongoose.connection.db;
        if (!db) return [];

        const collectionName = source === "usda" ? "usdafoods" :
            source === "food" ? "foods" : "recipes";

        const nameField = source === "recipe" ? "name_vi" : source === "food" ? "name_vi" : "description_vi";

        try {
            const results = await db
                .collection(collectionName)
                .find({ $text: { $search: query } }, { projection: { score: { $meta: "textScore" } } })
                .sort({ score: { $meta: "textScore" } })
                .limit(limit)
                .toArray();

            return results.map((r) => ({
                id: r._id.toString(),
                score: r.score as number ?? 0,
                payload: {
                    source_id: r._id.toString(),
                    name: r[nameField] as string ?? "",
                    diet_tags: r.diet_tags as string[] ?? [],
                    is_approved: r.is_approved as boolean ?? false,
                    fdc_id: r.fdc_id as number | undefined,
                    imported_to_foods: r.imported_to_foods as boolean | undefined,
                },
            }));
        } catch {
            return [];
        }
    }

    private _collectionName(source: SourceType): string {
        return COLLECTION_MAP[source];
    }

    private _toUnified(r: RankedResult, source: SourceType): UnifiedSearchResult {
        const payload = r.data as Record<string, unknown> | undefined;
        // UsdaFood documents store name in description_vi/description_en, not in "name"
        const name = (payload?.name as string | undefined)
            ?? (payload?.description_vi as string | undefined)
            ?? (payload?.description_en as string | undefined)
            ?? "";
        return {
            source_type: source,
            source_id: r.source_id,
            name,
            score: r.score,
            diet_tags: payload?.diet_tags as string[] ?? [],
            is_approved: payload?.is_approved as boolean | undefined,
            fdc_id: payload?.fdc_id as number | undefined,
            imported_to_foods: payload?.imported_to_foods as boolean | undefined,
            imported_food_id: payload?.imported_food_id as string | undefined,
        };
    }
}

let _instance: RetrievalService | null = null;
export function getRetrievalService(): RetrievalService {
    if (!_instance) _instance = new RetrievalService();
    return _instance;
}
