import jwt from "jsonwebtoken";
import type { SignOptions } from "jsonwebtoken";

const accessTokenExpiresIn = (process.env.JWT_EXPIRES_IN || "1d") as SignOptions["expiresIn"];
const refreshTokenExpiresIn = (process.env.JWT_REFRESH_EXPIRES_IN || "7d") as SignOptions["expiresIn"];

export const generateAccessToken = (userId: string): string => {
    return jwt.sign({ id: userId }, process.env.JWT_SECRET as string, {
        expiresIn: accessTokenExpiresIn,
    });
};

export const generateRefreshToken = (userId: string): string => {
    return jwt.sign({ id: userId }, process.env.JWT_REFRESH_SECRET as string, {
        expiresIn: refreshTokenExpiresIn,
    });
};

export const verifyRefreshToken = (token: string): { id: string } => {
    return jwt.verify(token, process.env.JWT_REFRESH_SECRET as string) as { id: string };
};
