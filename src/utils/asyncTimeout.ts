export class OperationTimeoutError extends Error {
    stage: string;
    timeoutMs: number;
    code = "operation_timeout";

    constructor(stage: string, timeoutMs: number) {
        super(`${stage} timed out after ${timeoutMs}ms`);
        this.name = "OperationTimeoutError";
        this.stage = stage;
        this.timeoutMs = timeoutMs;
    }
}

export function isOperationTimeoutError(error: unknown): error is OperationTimeoutError {
    return error instanceof OperationTimeoutError;
}

export async function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    stage: string,
): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new OperationTimeoutError(stage, timeoutMs)), timeoutMs);
    });

    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
}

