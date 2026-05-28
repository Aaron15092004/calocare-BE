/**
 * Reciprocal Rank Fusion (RRF) for merging ranked lists from multiple sources.
 * k=60 is the standard constant from the original RRF paper.
 */

export interface RankedResult {
    id: string;
    source_type: "food" | "recipe" | "usda";
    source_id: string;
    score: number;
    data?: unknown;
}

const RRF_K = 60;

export function reciprocalRankFusion(
    rankedLists: RankedResult[][],
    topK: number,
): RankedResult[] {
    const scoreMap = new Map<string, { rrf_score: number; result: RankedResult }>();

    for (const list of rankedLists) {
        list.forEach((item, rank) => {
            const key = `${item.source_type}:${item.source_id}`;
            const rrf = 1 / (RRF_K + rank + 1);
            const existing = scoreMap.get(key);
            if (existing) {
                existing.rrf_score += rrf;
            } else {
                scoreMap.set(key, { rrf_score: rrf, result: item });
            }
        });
    }

    return Array.from(scoreMap.values())
        .sort((a, b) => b.rrf_score - a.rrf_score)
        .slice(0, topK)
        .map(({ rrf_score, result }) => ({ ...result, score: rrf_score }));
}
