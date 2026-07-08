import ApiUsage from "../models/ApiUsage";

/**
 * Durable AI usage counters, bucketed per hour in ApiUsage.
 * ChatSession messages get trimmed by auto-summarize, so admin cost reports
 * need counters written at call time instead of derived from session content.
 *
 * Services tracked here (in addition to "gemini"/"groq_vision"/"voyage"
 * written by VisionService/EmbeddingService):
 *   - "chat_msg":       one per user chat message handled by ChatbotService
 *   - "meal_plan":      one per AI meal plan generated
 *   - "meal_plan_day":  one per day inside a generated plan (cost driver)
 */
export function trackAiUsage(service: string, count = 1): void {
    if (count <= 0) return;
    const hour = new Date().toISOString().slice(0, 13);
    ApiUsage.findOneAndUpdate(
        { service, hour },
        { $inc: { count } },
        { upsert: true },
    ).exec().catch(() => {});
}
