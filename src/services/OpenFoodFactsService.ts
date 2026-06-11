import axios from "axios";

const BASE_URL = "https://world.openfoodfacts.org/cgi/search.pl";
const TIMEOUT_MS = 8000;

export const searchImage = async (name: string): Promise<string | null> => {
    try {
        const response = await axios.get(BASE_URL, {
            params: {
                search_terms: name,
                action: "process",
                json: 1,
                page_size: 5,
                fields: "image_front_url,product_name",
            },
            timeout: TIMEOUT_MS,
            headers: { "User-Agent": "CaloVie/1.0 (nutrition app; contact@CaloVie.vn)" },
        });

        const products: Array<{ image_front_url?: string; product_name?: string }> =
            response.data?.products ?? [];

        for (const p of products) {
            if (p.image_front_url && p.image_front_url.startsWith("http")) {
                return p.image_front_url;
            }
        }
        return null;
    } catch (err) {
        console.warn("[OpenFoodFactsService] Search failed:", err instanceof Error ? err.message : String(err));
        return null;
    }
};
