import { isOperationTimeoutError } from "./asyncTimeout";

export interface UserFacingError {
    /** Machine-readable code the clients can branch on. */
    code: "ai_busy" | "ai_timeout" | "ai_parse" | "ai_error";
    /** Friendly Vietnamese message safe to render verbatim. */
    message: string;
    /** HTTP status the route should respond with (SSE routes ignore this). */
    status: number;
}

const BUSY_PATTERNS = /(^|\D)(429|503)(\D|$)|rate.?limit|overloaded|quota|resource.?exhausted|too many requests|service unavailable/i;
const PARSE_PATTERNS = /invalid json|unexpected token|json parse|returned invalid/i;

/**
 * Map any internal/provider error to a client-safe payload. Raw provider
 * messages (Groq/Gemini/Voyage stack text, circuit-breaker states, HTTP
 * bodies) must never reach end users — log them server-side instead.
 */
export function toUserError(err: unknown): UserFacingError {
    const raw = err instanceof Error ? err.message : String(err ?? "");

    if (isOperationTimeoutError(err) || /timed? ?out/i.test(raw)) {
        return {
            code: "ai_timeout",
            message: "Xử lý lâu hơn bình thường, bạn thử lại nhé.",
            status: 504,
        };
    }
    if (BUSY_PATTERNS.test(raw)) {
        return {
            code: "ai_busy",
            message: "AI đang bận, bạn thử lại sau ít phút nhé.",
            status: 503,
        };
    }
    if (PARSE_PATTERNS.test(raw)) {
        return {
            code: "ai_parse",
            message: "AI trả kết quả chưa đúng định dạng, bạn thử lại nhé.",
            status: 502,
        };
    }
    return {
        code: "ai_error",
        message: "Có lỗi xảy ra, bạn thử lại sau nhé.",
        status: 500,
    };
}
