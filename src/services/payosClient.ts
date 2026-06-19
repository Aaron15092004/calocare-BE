import { PayOS } from "@payos/node";

let payos: PayOS | null = null;

export function isPayOSConfigured(): boolean {
    return Boolean(
        process.env.PAYOS_CLIENT_ID
        && process.env.PAYOS_API_KEY
        && process.env.PAYOS_CHECKSUM_KEY,
    );
}

export function getPayOS(): PayOS {
    if (!payos) {
        const clientId = process.env.PAYOS_CLIENT_ID;
        const apiKey = process.env.PAYOS_API_KEY;
        const checksumKey = process.env.PAYOS_CHECKSUM_KEY;

        if (!clientId || !apiKey || !checksumKey) {
            throw new Error("PayOS env vars not configured (PAYOS_CLIENT_ID / PAYOS_API_KEY / PAYOS_CHECKSUM_KEY)");
        }

        payos = new PayOS({ clientId, apiKey, checksumKey });
    }

    return payos;
}

export function getClientUrl(): string {
    return process.env.CLIENT_URL || process.env.FRONTEND_URL || "http://localhost:2004";
}
