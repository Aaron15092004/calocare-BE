/**
 * Rule-based diet tagging. Trade-off: ~5-10% false positive rate acceptable.
 * LLM tagging can replace for high-priority subsets later.
 */

const NON_VEG_KEYWORDS = [
    // English
    "chicken", "beef", "pork", "fish", "shrimp", "lamb", "turkey", "duck",
    "veal", "venison", "bison", "rabbit", "goat", "lobster", "crab", "clam",
    "oyster", "mussel", "scallop", "squid", "octopus", "anchovy", "sardine",
    "tuna", "salmon", "tilapia", "catfish", "shrimp", "prawn", "bacon",
    "ham", "sausage", "hot dog", "pepperoni", "salami", "lard", "gelatin",
    // Vietnamese
    "gu00e0", "bu00f2", "heo", "lu1ee3n", "cu00e1", "tu00f4m", "vu1ecbt", "cu1eeb u", "du00ea",
    "cu1eeba", "ghu1eb9", "nghu00eau", "su00f2", "tu1ef1c", "mu1ef1c", "bu1ea1ch tuu1ed9c", "cu00e1 ngu1eeb",
    "cu00e1 hu1ed3i", "thu1ecbt",
];

const DAIRY_KEYWORDS = [
    "milk", "cheese", "butter", "cream", "yogurt", "whey", "casein",
    "lactose", "dairy", "su1eefa", "phu00f4 mai", "bu01a1", "kem",
];

const GLUTEN_KEYWORDS = [
    "wheat", "barley", "rye", "flour", "bread", "pasta", "noodle",
    "cracker", "cereal", "mu00ec", "bu00e1nh mu00ec", "gluten",
];

const EGG_KEYWORDS = [
    "egg", "eggs", "trứng", "mayonnaise", "meringue", "albumin",
];

const SHELLFISH_KEYWORDS = [
    "shrimp", "crab", "lobster", "prawn", "crawfish", "crayfish",
    "tu00f4m", "cu1eeba", "ghu1eb9", "u0111u1ea7u u0111u1ecf",
];

const PEANUT_KEYWORDS = [
    "peanut", "groundnut", "lu1ea1c", "u0111u1eadu phu1ed9ng",
];

function containsAny(text: string, keywords: string[]): boolean {
    const lower = text.toLowerCase();
    return keywords.some((kw) => lower.includes(kw.toLowerCase()));
}

export function extractDietTags(searchText: string): string[] {
    const tags: string[] = [];

    if (containsAny(searchText, NON_VEG_KEYWORDS)) {
        tags.push("non-vegetarian");
    } else {
        tags.push("vegetarian");
    }

    if (containsAny(searchText, DAIRY_KEYWORDS)) tags.push("contains-dairy");
    if (containsAny(searchText, GLUTEN_KEYWORDS)) tags.push("contains-gluten");
    if (containsAny(searchText, EGG_KEYWORDS)) tags.push("contains-eggs");
    if (containsAny(searchText, SHELLFISH_KEYWORDS)) tags.push("contains-shellfish");
    if (containsAny(searchText, PEANUT_KEYWORDS)) tags.push("contains-peanut");

    return tags;
}
