import axios from "axios";
import ApiUsage from "../../models/ApiUsage";

export interface UnsplashAttribution {
    source: "unsplash";
    photographer_name: string;
    photographer_url: string;  // with utm_source=calocare&utm_medium=referral
    photo_url: string;         // with utm_source=calocare&utm_medium=referral
    download_location: string; // Unsplash tracking endpoint — must be called (ToS)
}

export interface FatSecretAttribution {
    source: "fatsecret";
}

export type ImageAttribution = UnsplashAttribution | FatSecretAttribution;

export interface ImageFetchResult {
    url: string;
    attribution: ImageAttribution;
}

// Thrown when Unsplash API responds 429 or 403. Caller should skip image and
// allow natural re-queue on the next search/scan trigger.
export class UnsplashRateLimitError extends Error {
    constructor() {
        super("Unsplash API rate limit (429/403)");
        this.name = "UnsplashRateLimitError";
    }
}

export class ImageService {
    private get hourlyLimit(): number {
        return process.env.UNSPLASH_TIER === "production" ? 5000 : 50;
    }

    async fetchFoodImage(nameEn: string): Promise<ImageFetchResult | null> {
        const key = process.env.UNSPLASH_ACCESS_KEY;
        if (!key) {
            console.warn("[ImageService] UNSPLASH_ACCESS_KEY not set, skipping image fetch");
            return null;
        }

        // Check persistent hourly budget (survives process restarts)
        if (!(await this._checkAndIncrementUsage())) {
            return null; // quota exhausted — caller marks job imported, natural re-queue handles retry
        }

        try {
            const res = await axios.get<{
                results: Array<{
                    urls: { regular: string };
                    links: { html: string; download_location: string };
                    user: { name: string; links: { html: string } };
                }>;
            }>("https://api.unsplash.com/search/photos", {
                params: {
                    query: nameEn,
                    per_page: 1,
                    orientation: "landscape",
                    client_id: key,
                },
                timeout: 8000,
            });

            const photo = res.data?.results?.[0];
            if (!photo) return null;

            // Required by Unsplash ToS: trigger download tracking
            this._triggerDownload(photo.links.download_location, key).catch(() => {});

            return {
                url: photo.urls.regular,
                attribution: {
                    source: "unsplash",
                    photographer_name: photo.user.name,
                    photographer_url: `${photo.user.links.html}?utm_source=calocare&utm_medium=referral`,
                    photo_url: `${photo.links.html}?utm_source=calocare&utm_medium=referral`,
                    download_location: photo.links.download_location,
                },
            };
        } catch (err) {
            if (axios.isAxiosError(err)) {
                const status = err.response?.status;
                if (status === 429 || status === 403) {
                    throw new UnsplashRateLimitError();
                }
            }
            console.warn("[ImageService] Unsplash fetch failed:", err instanceof Error ? err.message : String(err));
            return null;
        }
    }

    private async _checkAndIncrementUsage(): Promise<boolean> {
        const hour = new Date().toISOString().slice(0, 13); // "2026-04-30T08"
        try {
            const usage = await ApiUsage.findOneAndUpdate(
                { service: "unsplash", hour },
                { $inc: { count: 1 } },
                { upsert: true, new: true },
            );
            if (usage.count > this.hourlyLimit) {
                console.warn(
                    `[ImageService] Unsplash hourly quota reached (${usage.count - 1}/${this.hourlyLimit}) — skipping fetch`,
                );
                return false;
            }
            return true;
        } catch {
            return true; // fail open — don't block enrichment on DB error
        }
    }

    private async _triggerDownload(downloadLocation: string, accessKey: string): Promise<void> {
        await axios.get(downloadLocation, {
            params: { client_id: accessKey },
            timeout: 5000,
        });
    }
}

let _instance: ImageService | null = null;
export function getImageService(): ImageService {
    if (!_instance) _instance = new ImageService();
    return _instance;
}
