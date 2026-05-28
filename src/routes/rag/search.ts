import { Router, Request, Response } from "express";
import { z } from "zod";
import { optionalAuthenticate } from "../../middleware/auth";
import { ragRateLimit } from "../../middleware/ragRateLimit";
import { getFoodSearchService, UserPreferences } from "../../services/rag/FoodSearchService";
import { getFatSecretService, FatSecretSearchResult } from "../../services/rag/FatSecretService";
import { getFatSecretImportService, FatSecretImportService } from "../../services/rag/FatSecretImportService";
import { getTranslationService, TranslatedFood } from "../../services/rag/TranslationService";
import { IUser } from "../../models/User";
import { logRag } from "../../utils/logger";

// Detect Vietnamese by presence of diacritics or common Vietnamese-only characters
const isVietnamese = (text: string) => /[À-ɏḀ-ỿ]/.test(text);

const router = Router();

const SearchRequestSchema = z.object({
    query: z.string().min(1).max(500),
    top_k: z.number().int().min(1).max(50).optional().default(10),
    include_sources: z
        .array(z.enum(["food", "recipe", "usda"]))
        .optional(),
});

router.post("/", optionalAuthenticate, ragRateLimit("search"), async (req: Request, res: Response) => {
    const parsed = SearchRequestSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
        return;
    }

    const user  = req.user as IUser | undefined;
    const prefs = user?.preferences as UserPreferences | undefined;
    const t0    = Date.now();

    try {
        const service          = getFoodSearchService();
        const hasFatSec        = FatSecretImportService.isAvailable();
        const queryIsVi        = isVietnamese(parsed.data.query);
        const translationSvc   = getTranslationService();

        // Local search starts immediately (no translation needed)
        const localSearchPromise = service.search({
            query: parsed.data.query,
            top_k: parsed.data.top_k,
            include_sources: parsed.data.include_sources,
            user_preferences: prefs,
        });

        // FatSecret: translate query Vi→En first (cached → near-zero latency after first call),
        // then search. Runs in parallel with local search.
        const fatSecretPromise: Promise<FatSecretSearchResult[]> = hasFatSec
            ? (queryIsVi
                ? translationSvc
                    .translateViToEn([parsed.data.query])
                    .then((r) => r[0] || parsed.data.query)
                    .catch(() => parsed.data.query)
                : Promise.resolve(parsed.data.query)
              ).then((enQuery) => getFatSecretService().searchFoods(enQuery, 5).catch(() => []))
            : Promise.resolve([]);

        const [localResults, fatSecretRaw] = await Promise.all([
            localSearchPromise,
            fatSecretPromise,
        ]);

        // Translate FatSecret food names En→Vi AND classify each as dish/ingredient.
        // One Groq call handles both — cached after first use (near-zero cost on repeats).
        const rawNames = fatSecretRaw.map((r) => r.food_name);
        const classified: TranslatedFood[] = rawNames.length > 0
            ? await translationSvc.translateAndClassify(rawNames).catch(() =>
                  rawNames.map((n) => ({ name_vi: n, type: "ingredient" as const })),
              )
            : [];

        // Convert FatSecret results → FoodSearchResultItem-compatible objects with real nutrition
        const localNameSet = new Set(localResults.map((r) => r.name?.toLowerCase().trim()));
        const importService = hasFatSec ? getFatSecretImportService() : null;

        const fatSecretResults = fatSecretRaw
            .map((r, i) => ({ r, ...classified[i] ?? { name_vi: r.food_name, type: "ingredient" as const } }))
            // Deduplicate against local results using both Vi and En names
            .filter(({ r, name_vi }) =>
                !localNameSet.has(r.food_name?.toLowerCase().trim()) &&
                !localNameSet.has(name_vi?.toLowerCase().trim()),
            )
            .map(({ r, name_vi, type }) => {
                const nutrition = FatSecretImportService.parseFoodDescription(r.food_description);

                // Route background upsert: dishes → recipes, ingredients → foods
                if (importService && nutrition) {
                    if (type === "dish") {
                        importService.upsertFromSearchResultAsRecipe(r, name_vi).catch(() => {});
                    } else {
                        importService.upsertFromSearchResult(r, name_vi).catch(() => {});
                    }
                }

                return {
                    source_type: "fatsecret" as const,
                    source_id:   `FS-${r.food_id}`,
                    name:        name_vi,       // Vietnamese name for display
                    name_en:     r.food_name,   // Original English name kept
                    score: 0.5,
                    energy_kcal: nutrition?.energy_kcal ?? null,
                    protein:     nutrition?.protein     ?? null,
                    lipid:       nutrition?.lipid       ?? null,
                    glucid:      nutrition?.glucid      ?? null,
                    fiber:       nutrition?.fiber       ?? null,
                    brand_name:  r.brand_name ?? null,
                    diet_tags:   [],
                    is_approved: true,
                };
            })
            // Only include results with actual nutrition data
            .filter((r) => r.energy_kcal !== null);

        const combined = [...localResults, ...fatSecretResults];

        logRag({
            endpoint: "search",
            userId: user?._id?.toString(),
            query: parsed.data.query,
            latency_ms: Date.now() - t0,
            result_count: combined.length,
            status: "ok",
        });

        res.json({ results: combined, count: combined.length });
    } catch (err) {
        const msg = err instanceof Error ? err.message : "Search failed";
        logRag({
            endpoint: "search",
            userId: user?._id?.toString(),
            query: parsed.data.query,
            latency_ms: Date.now() - t0,
            status: "error",
            error: msg,
        });
        res.status(500).json({ error: msg });
    }
});

export default router;
