import { getLLMService } from "./LLMService";

export type ChatIntent = "faq" | "personal" | "action";

interface IntentPattern {
    intent: ChatIntent;
    patterns: RegExp[];
}

const INTENT_PATTERNS: IntentPattern[] = [
    {
        intent: "action",
        patterns: [
            /thêm.*(vào|diary|nhật ký)/i,
            /ghi.*(lại|vào)/i,
            /log.*(món|ăn|thức)/i,
            /tạo kế hoạch/i,
            /lên thực đơn/i,
            /add.*(food|meal|diary)/i,
            /create.*(plan|meal)/i,
        ],
    },
    {
        intent: "personal",
        patterns: [
            /tôi nên/i,
            /tư vấn cho tôi/i,
            /mục tiêu.*tôi/i,
            /của tôi/i,
            /hôm nay.*ăn gì/i,
            /bữi.*tôi/i,
            /phù hợp.*tôi/i,
            /my (goal|diet|plan)/i,
            /what should i eat/i,
            /recommend.*me/i,
            // Profile-related
            /tôi nặng/i,
            /cân nặng/i,
            /chiều cao/i,
            /bmi.*tôi/i,
            /tôi.*bmi/i,
            /tôi ăn/i,
            /tôi đã ăn/i,
            /hôm nay tôi/i,
            /tuổi.*tôi/i,
            /tôi.*tuổi/i,
            /sức khỏe.*tôi/i,
            /thể trạng/i,
            /i (weigh|am|have)/i,
            /my (weight|height|age|bmi|health)/i,
        ],
    },
];

export class IntentClassifier {
    private readonly llm = getLLMService();

    classify(message: string): ChatIntent {
        for (const { intent, patterns } of INTENT_PATTERNS) {
            if (patterns.some((p) => p.test(message))) {
                return intent;
            }
        }
        return "faq";
    }

    async classifyWithLLM(message: string): Promise<ChatIntent> {
        // Fast regex path — covers the majority of messages without LLM cost
        const regexResult = this.classify(message);
        if (regexResult !== "faq") return regexResult;

        // Skip LLM for short-to-medium messages — the extra model hop adds
        // noticeable latency and often does not improve intent quality.
        const wordCount = message.trim().split(/\s+/).length;
        if (wordCount <= 12) return "faq";

        // LLM fallback only for longer ambiguous messages where context matters
        try {
            const response = await this.llm.generate(
                [
                    {
                        role: "system",
                        content:
                            "Classify the user message into one of: faq, personal, action.\n" +
                            "faq: general nutrition/food questions.\n" +
                            "personal: personalized advice based on user profile.\n" +
                            "action: user wants to log food, create meal plan, or perform an action.\n" +
                            "Reply with ONLY the single word: faq, personal, or action.",
                    },
                    { role: "user", content: message },
                ],
                { temperature: 0, maxTokens: 10 },
            );
            const intent = response.content.trim().toLowerCase() as ChatIntent;
            if (["faq", "personal", "action"].includes(intent)) return intent;
        } catch {
            // fallback to faq
        }
        return "faq";
    }
}

let _instance: IntentClassifier | null = null;
export function getIntentClassifier(): IntentClassifier {
    if (!_instance) _instance = new IntentClassifier();
    return _instance;
}
