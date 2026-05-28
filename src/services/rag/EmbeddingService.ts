import axios from "axios";
import ApiUsage from "../../models/ApiUsage";

const VOYAGE_API_URL = "https://api.voyageai.com/v1/embeddings";
const VOYAGE_MODEL = "voyage-4-lite";
const VOYAGE_BATCH_MAX = 128;

export type VoyageInputType = "document" | "query";

interface VoyageResponse {
    data: Array<{ embedding: number[]; index: number }>;
}

const CACHE_MAX = 1000; // increased from 500 to reduce re-embedding on warm traffic

// Circuit breaker: after FAILURE_THRESHOLD consecutive failures, stop hammering Voyage
// for RESET_MS milliseconds and immediately reject with a descriptive error.
const CB_FAILURE_THRESHOLD = 3;
const CB_RESET_MS = 60_000; // 1 minute half-open window

class CircuitBreaker {
    private failures = 0;
    private openedAt = 0;

    isOpen(): boolean {
        if (this.failures < CB_FAILURE_THRESHOLD) return false;
        if (Date.now() - this.openedAt > CB_RESET_MS) {
            // Half-open: allow one trial through
            this.failures = 0;
            return false;
        }
        return true;
    }

    recordSuccess(): void {
        this.failures = 0;
    }

    recordFailure(): void {
        this.failures++;
        if (this.failures >= CB_FAILURE_THRESHOLD) {
            this.openedAt = Date.now();
        }
    }
}

const _circuitBreaker = new CircuitBreaker();

export class EmbeddingService {
    private readonly apiKey: string;
    private readonly _cache = new Map<string, number[]>();

    constructor() {
        const key = process.env.VOYAGE_API_KEY;
        if (!key) throw new Error("VOYAGE_API_KEY is not set");
        this.apiKey = key;
    }

    async embed(text: string, inputType: VoyageInputType = "query"): Promise<number[]> {
        const results = await this.embedBatch([text], inputType);
        return results[0];
    }

    async embedBatch(
        texts: string[],
        inputType: VoyageInputType = "document",
        batchSize = VOYAGE_BATCH_MAX,
    ): Promise<number[][]> {
        const results: (number[] | undefined)[] = new Array(texts.length).fill(undefined);
        const missIndices: number[] = [];

        for (let i = 0; i < texts.length; i++) {
            const cached = this._cacheGet(`${inputType}:${texts[i]}`);
            if (cached) results[i] = cached;
            else missIndices.push(i);
        }

        const missTexts = missIndices.map((i) => texts[i]);
        for (let i = 0; i < missTexts.length; i += batchSize) {
            const chunk = missTexts.slice(i, i + batchSize);
            const embeddings = await this._callAPI(chunk, inputType);
            for (let j = 0; j < chunk.length; j++) {
                const orig = missIndices[i + j];
                results[orig] = embeddings[j];
                this._cacheSet(`${inputType}:${texts[orig]}`, embeddings[j]);
            }
        }

        return results as number[][];
    }

    private _cacheGet(key: string): number[] | undefined {
        const v = this._cache.get(key);
        if (v) {
            // Move to end (LRU)
            this._cache.delete(key);
            this._cache.set(key, v);
        }
        return v;
    }

    private _cacheSet(key: string, v: number[]): void {
        if (this._cache.has(key)) this._cache.delete(key);
        else if (this._cache.size >= CACHE_MAX) {
            const first = this._cache.keys().next().value;
            if (first !== undefined) this._cache.delete(first);
        }
        this._cache.set(key, v);
    }

    private async _callAPI(
        inputs: string[],
        inputType: VoyageInputType,
        retries = 4,
    ): Promise<number[][]> {
        if (_circuitBreaker.isOpen()) {
            throw new Error(
                "EmbeddingService: Voyage AI circuit breaker is open — service temporarily unavailable. " +
                "Will retry in ~60s.",
            );
        }

        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                const response = await axios.post<VoyageResponse>(
                    VOYAGE_API_URL,
                    { input: inputs, model: VOYAGE_MODEL, input_type: inputType },
                    {
                        headers: {
                            Authorization: `Bearer ${this.apiKey}`,
                            "Content-Type": "application/json",
                        },
                        timeout: 60_000,
                    },
                );

                const sorted = response.data.data.sort((a, b) => a.index - b.index);
                _circuitBreaker.recordSuccess();
                // Track actual API call count (cache misses only) — fire-and-forget
                const hour = new Date().toISOString().slice(0, 13);
                ApiUsage.findOneAndUpdate(
                    { service: "voyage", hour },
                    { $inc: { count: inputs.length } },
                    { upsert: true },
                ).exec().catch(() => {});
                return sorted.map((d) => d.embedding);
            } catch (err) {
                if (attempt === retries) {
                    _circuitBreaker.recordFailure();
                    throw err;
                }

                const status = (err as { response?: { status?: number; headers?: Record<string, string> } })?.response?.status;
                if (status === 429) {
                    const retryAfter = Math.min(
                        parseInt((err as { response?: { headers?: Record<string, string> } })?.response?.headers?.["retry-after"] ?? "15"),
                        15,
                    );
                    const waitMs = (retryAfter + 1) * 1000;
                    console.warn(`[EmbeddingService] 429 rate limit, waiting ${waitMs / 1000}s (attempt ${attempt + 1}/${retries})`);
                    await new Promise((r) => setTimeout(r, waitMs));
                } else if (status && status >= 500) {
                    // Server error — counts toward circuit breaker
                    _circuitBreaker.recordFailure();
                    await new Promise((r) => setTimeout(r, 2000 * Math.pow(2, attempt)));
                } else {
                    await new Promise((r) => setTimeout(r, 2000 * Math.pow(2, attempt)));
                }
            }
        }
        throw new Error("EmbeddingService: max retries exceeded");
    }
}

// Singleton
let _instance: EmbeddingService | null = null;
export function getEmbeddingService(): EmbeddingService {
    if (!_instance) _instance = new EmbeddingService();
    return _instance;
}
