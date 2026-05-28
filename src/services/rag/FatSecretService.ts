/**
 * FatSecret Platform API v4 (REST) — OAuth 1.0 consumer credential flow.
 * Fetches foods filtered to Vietnam (locale=vi) for enrichment and search.
 *
 * Setup: add FATSECRET_KEY and FATSECRET_SECRET to .env
 * Docs: https://platform.fatsecret.com/rest-api/
 */
import crypto from "crypto";

const BASE_URL = "https://platform.fatsecret.com/rest/server.api";

export interface FatSecretFoodImage {
    image_url: string;
    image_type: string; // "small thumbnail" | "regular" | "large"
}

export interface FatSecretFood {
    food_id: string;
    food_name: string;
    food_type: string;       // "Generic" | "Brand"
    food_url?: string;
    food_images?: {
        food_image?: FatSecretFoodImage | FatSecretFoodImage[];
    };
    servings?: {
        serving: FatSecretServing | FatSecretServing[];
    };
}

export interface FatSecretServing {
    serving_id: string;
    serving_description: string;
    serving_url?: string;
    metric_serving_amount?: string;
    metric_serving_unit?: string;
    calories?: string;
    protein?: string;
    carbohydrate?: string;
    fat?: string;
    fiber?: string;
    sugar?: string;
    sodium?: string;
}

export interface FatSecretSearchResult {
    food_id: string;
    food_name: string;
    food_type: string;
    brand_name?: string;
    food_description: string;
    food_url: string;
}

// ── OAuth 1.0 helpers ──────────────────────────────────────────────────────

function percentEncode(s: string): string {
    return encodeURIComponent(s)
        .replace(/!/g, "%21")
        .replace(/'/g, "%27")
        .replace(/\(/g, "%28")
        .replace(/\)/g, "%29")
        .replace(/\*/g, "%2A");
}

function buildOAuthHeader(
    method: string,
    url: string,
    consumerKey: string,
    consumerSecret: string,
    extraParams: Record<string, string>,
): string {
    const oauthParams: Record<string, string> = {
        oauth_consumer_key: consumerKey,
        oauth_nonce: crypto.randomBytes(16).toString("hex"),
        oauth_signature_method: "HMAC-SHA1",
        oauth_timestamp: String(Math.floor(Date.now() / 1000)),
        oauth_version: "1.0",
    };

    const allParams = { ...oauthParams, ...extraParams };
    const sortedKeys = Object.keys(allParams).sort();
    const paramString = sortedKeys
        .map((k) => `${percentEncode(k)}=${percentEncode(allParams[k])}`)
        .join("&");

    const baseString = [
        method.toUpperCase(),
        percentEncode(url),
        percentEncode(paramString),
    ].join("&");

    const signingKey = `${percentEncode(consumerSecret)}&`;
    const signature = crypto
        .createHmac("sha1", signingKey)
        .update(baseString)
        .digest("base64");

    oauthParams.oauth_signature = signature;

    const headerValue =
        "OAuth " +
        Object.entries(oauthParams)
            .map(([k, v]) => `${percentEncode(k)}="${percentEncode(v)}"`)
            .join(", ");

    return headerValue;
}

// ── Additional response types ─────────────────────────────────────────────

/** One food item returned by the Image Recognition v2 API */
export interface FatSecretRecognizedFood {
    food_id: string;
    food_name: string;
    brand_name?: string;
    food_type?: string;
    serving_description?: string;
    metric_serving_amount?: string;   // estimated grams from the image
    metric_serving_unit?: string;
    // Inline per-serving nutrition (when include_food_data=false)
    calories?: string;
    carbohydrate?: string;
    protein?: string;
    fat?: string;
    fiber?: string;
    // Full food detail (populated when include_food_data=true)
    food_data?: FatSecretFood;
}

/** Normalised result returned by recognizeImage() */
export interface FatSecretRecognitionResult {
    food_id: string;
    food_name: string;
    detected_grams: number;
    per100g: {
        energy_kcal: number;
        protein: number;
        lipid: number;
        glucid: number;
        fiber: number;
    };
    image_url?: string;
}

// ── FatSecret Service ───────────────────────────────────────────────────────

export class FatSecretService {
    private readonly key: string;
    private readonly secret: string;

    constructor() {
        const key = process.env.FATSECRET_KEY;
        const secret = process.env.FATSECRET_SECRET;
        if (!key || !secret) {
            throw new Error("FATSECRET_KEY and FATSECRET_SECRET must be set in .env");
        }
        this.key = key;
        this.secret = secret;
    }

    private async _call<T>(params: Record<string, string>): Promise<T> {
        const queryParams: Record<string, string> = {
            ...params,
            format: "json",
            // Request Vietnamese locale for Vietnam-specific foods
            locale: "vi",
            region: "VN",
        };

        const oauthHeader = buildOAuthHeader("GET", BASE_URL, this.key, this.secret, queryParams);

        const qs = new URLSearchParams(queryParams).toString();
        const url = `${BASE_URL}?${qs}`;

        const res = await fetch(url, {
            headers: { Authorization: oauthHeader },
            signal: AbortSignal.timeout(15_000),
        });

        if (!res.ok) {
            throw new Error(`FatSecret API error: ${res.status} ${res.statusText}`);
        }

        return res.json() as Promise<T>;
    }

    /**
     * Search foods by keyword, returns up to maxResults entries.
     * Primarily returns Vietnamese/regional foods when region=VN.
     */
    async searchFoods(
        query: string,
        maxResults = 10,
        pageNumber = 0,
    ): Promise<FatSecretSearchResult[]> {
        type SearchResponse = {
            foods?: {
                food?: FatSecretSearchResult | FatSecretSearchResult[];
                max_results?: string;
                total_results?: string;
                page_number?: string;
            };
            error?: { code: string; message: string };
        };

        const data = await this._call<SearchResponse>({
            method: "foods.search",
            search_expression: query,
            max_results: String(maxResults),
            page_number: String(pageNumber),
        });

        if (data.error) {
            throw new Error(`FatSecret: ${data.error.message} (code ${data.error.code})`);
        }

        const raw = data.foods?.food;
        if (!raw) return [];

        return Array.isArray(raw) ? raw : [raw];
    }

    /**
     * SF-06: Look up a food by barcode (EAN/UPC).
     * Requires FatSecret Premium plan for production use; may return null on free tier.
     */
    async findByBarcode(barcode: string): Promise<FatSecretFood | null> {
        type BarcodeResponse = {
            food_id?: { value?: string };
            error?: { code: string; message: string };
        };

        const data = await this._call<BarcodeResponse>({
            method: "food.find_id_for_barcode",
            barcode,
        });

        if (data.error || !data.food_id?.value) return null;
        return this.getFoodById(data.food_id.value);
    }

    /**
     * Get full nutritional detail for a single food by ID.
     * Returns per-serving nutrition data.
     */
    async getFoodById(foodId: string): Promise<FatSecretFood | null> {
        type FoodResponse = {
            food?: FatSecretFood;
            error?: { code: string; message: string };
        };

        const data = await this._call<FoodResponse>({
            method: "food.get.v4",
            food_id: foodId,
        });

        if (data.error) {
            throw new Error(`FatSecret: ${data.error.message} (code ${data.error.code})`);
        }

        return data.food ?? null;
    }

    /**
     * Extract the best available image URL from a FatSecretFood response.
     * Returns null when no images are present (common in free tier).
     */
    extractImage(food: FatSecretFood): string | null {
        const raw = food.food_images?.food_image;
        if (!raw) return null;
        const images = Array.isArray(raw) ? raw : [raw];
        // Prefer "regular" size; fall back to any available
        const regular = images.find((i) => i.image_type === "regular") ?? images[0];
        return regular?.image_url ?? null;
    }

    /**
     * foods.search.v5 — dedicated v5 URL, returns full serving nutrition inline.
     * No region/language params (Premier Free plan does not support region filtering).
     * Pass an English query for best results.
     */
    async searchFoodsV5(query: string, maxResults = 5): Promise<FatSecretFood[]> {
        const V5_URL = "https://platform.fatsecret.com/rest/foods/search/v5";

        const params: Record<string, string> = {
            search_expression: query,
            max_results: String(maxResults),
            format: "json",
        };

        const oauthHeader = buildOAuthHeader("GET", V5_URL, this.key, this.secret, params);
        const qs = new URLSearchParams(params).toString();

        const res = await fetch(`${V5_URL}?${qs}`, {
            headers: { Authorization: oauthHeader },
            signal: AbortSignal.timeout(15_000),
        });

        if (!res.ok) {
            throw new Error(`FatSecret v5 search error: ${res.status} ${res.statusText}`);
        }

        type V5Response = {
            foods_search?: { results?: { food?: FatSecretFood | FatSecretFood[] } };
            error?: { code: string; message: string };
        };
        const data = await res.json() as V5Response;

        if (data.error) {
            throw new Error(`FatSecret v5: ${data.error.message} (code ${data.error.code})`);
        }

        const raw = data.foods_search?.results?.food;
        if (!raw) return [];
        return Array.isArray(raw) ? raw : [raw];
    }

    /**
     * Image Recognition v2 — identifies food items in a photo and returns matched foods
     * with per-serving nutrition from the FatSecret VN database.
     * Requires the Premier Image Recognition add-on.
     */
    async recognizeImage(imageBase64: string): Promise<FatSecretRecognitionResult[]> {
        const url = "https://platform.fatsecret.com/rest/image-recognition/v2";

        // For JSON-body POST, OAuth 1.0 signature covers only the URL + OAuth header params
        // (the JSON body is NOT part of the base string per the spec)
        const oauthHeader = buildOAuthHeader("POST", url, this.key, this.secret, {});

        const body = JSON.stringify({
            image_b64: imageBase64,
            include_food_data: true,
            region: "VN",
            language: "vi",
        });

        const res = await fetch(url, {
            method: "POST",
            headers: {
                Authorization: oauthHeader,
                "Content-Type": "application/json",
            },
            body,
            signal: AbortSignal.timeout(45_000),
        });

        if (!res.ok) {
            throw new Error(`FatSecret image recognition error: ${res.status} ${res.statusText}`);
        }

        const data = await res.json() as Record<string, unknown>;

        // FatSecret returns errors as 200 responses with an "error" body field
        const apiError = data.error as { code?: string; message?: string } | undefined;
        if (apiError?.code) {
            throw new Error(`FatSecret image recognition not available (code ${apiError.code}): ${apiError.message}`);
        }

        // Normalise food_response array (FatSecret may wrap single item as object)
        const rawItems: FatSecretRecognizedFood[] = [];
        const foodResponse = (data as any).food_response;
        if (Array.isArray(foodResponse)) {
            rawItems.push(...foodResponse as FatSecretRecognizedFood[]);
        } else if (foodResponse && typeof foodResponse === "object") {
            const food = (foodResponse as any).food;
            if (Array.isArray(food)) rawItems.push(...(food as FatSecretRecognizedFood[]));
            else if (food) rawItems.push(food as FatSecretRecognizedFood);
        }

        const results: FatSecretRecognitionResult[] = [];
        for (const item of rawItems) {
            // Per-100g nutrition: prefer food_data (most accurate), fall back to inline values
            let per100g: FatSecretRecognitionResult["per100g"] | null = null;
            let image_url: string | undefined;

            if (item.food_data) {
                per100g = this.extractPer100g(item.food_data);
                image_url = this.extractImage(item.food_data) ?? undefined;
            }

            if (!per100g && item.calories != null) {
                // Inline per-serving values — normalise to per-100g
                const servingG = parseFloat(item.metric_serving_amount ?? "100") || 100;
                const f = 100 / servingG;
                per100g = {
                    energy_kcal: Math.round((parseFloat(item.calories) || 0) * f),
                    protein:     Math.round((parseFloat(item.protein ?? "0") || 0) * f * 10) / 10,
                    lipid:       Math.round((parseFloat(item.fat ?? "0") || 0) * f * 10) / 10,
                    glucid:      Math.round((parseFloat(item.carbohydrate ?? "0") || 0) * f * 10) / 10,
                    fiber:       Math.round((parseFloat(item.fiber ?? "0") || 0) * f * 10) / 10,
                };
            }

            if (!per100g) continue; // skip items with no nutrition at all

            const detectedG = parseFloat(item.metric_serving_amount ?? "0") || 200;
            results.push({
                food_id: item.food_id,
                food_name: item.food_name,
                detected_grams: Math.max(10, detectedG),
                per100g,
                image_url,
            });
        }

        return results;
    }

    /**
     * Extract per-100g nutrition from the first matching serving.
     * FatSecret servings vary (per piece, per cup, etc.) — we normalise to 100g.
     */
    extractPer100g(food: FatSecretFood): {
        energy_kcal: number;
        protein: number;
        lipid: number;
        glucid: number;
        fiber: number;
    } | null {
        const servings = food.servings?.serving;
        const servingArr = Array.isArray(servings) ? servings : servings ? [servings] : [];

        // Prefer the serving that explicitly describes 100g
        const serving100g =
            servingArr.find(
                (s) =>
                    s.metric_serving_amount === "100" &&
                    s.metric_serving_unit?.toLowerCase() === "g",
            ) ?? servingArr[0];

        if (!serving100g) return null;

        const gramAmount = parseFloat(serving100g.metric_serving_amount ?? "100") || 100;
        const factor = 100 / gramAmount;

        return {
            energy_kcal: Math.round((parseFloat(serving100g.calories ?? "0") || 0) * factor),
            protein: Math.round((parseFloat(serving100g.protein ?? "0") || 0) * factor * 10) / 10,
            lipid: Math.round((parseFloat(serving100g.fat ?? "0") || 0) * factor * 10) / 10,
            glucid: Math.round((parseFloat(serving100g.carbohydrate ?? "0") || 0) * factor * 10) / 10,
            fiber: Math.round((parseFloat(serving100g.fiber ?? "0") || 0) * factor * 10) / 10,
        };
    }
}

let _instance: FatSecretService | null = null;

export function getFatSecretService(): FatSecretService {
    if (!_instance) _instance = new FatSecretService();
    return _instance;
}
