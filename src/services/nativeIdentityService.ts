import axios from "axios";
import crypto from "crypto";
import jwt, { JwtHeader, JwtPayload } from "jsonwebtoken";

const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_JWKS_URL = `${APPLE_ISSUER}/auth/keys`;
let appleKeysCache: Array<{ kid?: string; kty?: string; crv?: string; x?: string; y?: string }> = [];
let appleKeysCachedAt = 0;

export class NativeIdentityError extends Error {
    constructor(message: string, public readonly status = 401) {
        super(message);
    }
}

export interface NativeGoogleIdentity {
    subject: string;
    email: string;
    emailVerified: boolean;
    displayName?: string;
    avatarUrl?: string;
}

export interface NativeAppleIdentity {
    subject: string;
    email?: string;
}

function configuredValues(...keys: string[]): string[] {
    return keys
        .flatMap((key) => (process.env[key] || "").split(","))
        .map((value) => value.trim())
        .filter(Boolean);
}

function requiredAppleConfig() {
    const clientId = process.env.APPLE_CLIENT_ID;
    const teamId = process.env.APPLE_TEAM_ID;
    const keyId = process.env.APPLE_KEY_ID;
    const privateKey = process.env.APPLE_PRIVATE_KEY?.replace(/\\n/g, "\n");
    if (!clientId || !teamId || !keyId || !privateKey) {
        throw new NativeIdentityError("Apple Sign In is not configured on the server.", 503);
    }
    return { clientId, teamId, keyId, privateKey };
}

async function createAppleClientSecret(): Promise<{ clientId: string; clientSecret: string }> {
    const { clientId, teamId, keyId, privateKey } = requiredAppleConfig();
    const clientSecret = jwt.sign({}, privateKey, {
        algorithm: "ES256",
        keyid: keyId,
        issuer: teamId,
        subject: clientId,
        audience: APPLE_ISSUER,
        expiresIn: "180d",
    });
    return { clientId, clientSecret };
}

async function applePublicKeyFor(header: JwtHeader): Promise<crypto.KeyObject> {
    if (!header.kid || header.alg !== "ES256") {
        throw new NativeIdentityError("Apple identity token has an invalid signing header.");
    }
    if (!appleKeysCache.length || Date.now() - appleKeysCachedAt > 6 * 60 * 60 * 1000) {
        const response = await axios.get(APPLE_JWKS_URL, { timeout: 8000 });
        appleKeysCache = Array.isArray(response.data?.keys) ? response.data.keys : [];
        appleKeysCachedAt = Date.now();
    }
    const key = appleKeysCache.find((candidate) => candidate.kid === header.kid);
    if (!key || key.kty !== "EC" || key.crv !== "P-256" || !key.x || !key.y) {
        throw new NativeIdentityError("Apple signing key was not found.");
    }
    return crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: key.x, y: key.y }, format: "jwk" });
}

export async function verifyNativeGoogleIdentity(idToken: string): Promise<NativeGoogleIdentity> {
    const clientIds = configuredValues("GOOGLE_NATIVE_CLIENT_IDS", "GOOGLE_CLIENT_ID");
    if (!clientIds.length) {
        throw new NativeIdentityError("Google Sign In is not configured on the server.", 503);
    }

    try {
        const response = await axios.get("https://oauth2.googleapis.com/tokeninfo", {
            params: { id_token: idToken },
            timeout: 8000,
        });
        const data = response.data as Record<string, unknown>;
        const audience = typeof data.aud === "string" ? data.aud : "";
        const issuer = typeof data.iss === "string" ? data.iss : "";
        const email = typeof data.email === "string" ? data.email.toLowerCase() : "";
        const subject = typeof data.sub === "string" ? data.sub : "";
        const verified = data.email_verified === true || data.email_verified === "true";

        if (!clientIds.includes(audience) || !["accounts.google.com", "https://accounts.google.com"].includes(issuer)) {
            throw new NativeIdentityError("Google identity token is not issued for CaloVie.");
        }
        if (!email || !subject || !verified) {
            throw new NativeIdentityError("Google account email is not verified.");
        }

        return {
            subject,
            email,
            emailVerified: verified,
            displayName: typeof data.name === "string" ? data.name : undefined,
            avatarUrl: typeof data.picture === "string" ? data.picture : undefined,
        };
    } catch (error) {
        if (error instanceof NativeIdentityError) throw error;
        throw new NativeIdentityError("Google identity token could not be verified.");
    }
}

export async function verifyNativeAppleIdentity(identityToken: string): Promise<NativeAppleIdentity> {
    const audiences = configuredValues("APPLE_CLIENT_IDS", "APPLE_CLIENT_ID");
    if (!audiences.length) {
        throw new NativeIdentityError("Apple Sign In is not configured on the server.", 503);
    }

    try {
        const decoded = jwt.decode(identityToken, { complete: true });
        if (!decoded || typeof decoded === "string") {
            throw new NativeIdentityError("Apple identity token is malformed.");
        }
        const key = await applePublicKeyFor(decoded.header);
        const payload = jwt.verify(identityToken, key, {
            algorithms: ["ES256"],
            issuer: APPLE_ISSUER,
            audience: audiences.length === 1 ? audiences[0] : [audiences[0], ...audiences.slice(1)],
        }) as JwtPayload;
        const subject = typeof payload.sub === "string" ? payload.sub : "";
        if (!subject) throw new NativeIdentityError("Apple identity token is missing a subject.");
        return {
            subject,
            email: typeof payload.email === "string" ? payload.email.toLowerCase() : undefined,
        };
    } catch (error) {
        if (error instanceof NativeIdentityError) throw error;
        throw new NativeIdentityError("Apple identity token could not be verified.");
    }
}

export async function exchangeAppleAuthorizationCode(code: string): Promise<string | undefined> {
    if (!code) return undefined;
    try {
        const { clientId, clientSecret } = await createAppleClientSecret();
        const body = new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            code,
            grant_type: "authorization_code",
        });
        const response = await axios.post(`${APPLE_ISSUER}/auth/token`, body.toString(), {
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            timeout: 8000,
        });
        return typeof response.data?.refresh_token === "string" ? response.data.refresh_token : undefined;
    } catch (error) {
        console.warn("[native-auth] Apple authorization code exchange failed:", error instanceof Error ? error.message : String(error));
        return undefined;
    }
}

export async function revokeAppleRefreshToken(refreshToken?: string): Promise<void> {
    if (!refreshToken) return;
    try {
        const { clientId, clientSecret } = await createAppleClientSecret();
        const body = new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            token: refreshToken,
            token_type_hint: "refresh_token",
        });
        await axios.post(`${APPLE_ISSUER}/auth/revoke`, body.toString(), {
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            timeout: 8000,
        });
    } catch (error) {
        console.warn("[native-auth] Apple token revoke failed:", error instanceof Error ? error.message : String(error));
    }
}
