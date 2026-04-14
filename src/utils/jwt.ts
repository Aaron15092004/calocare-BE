import jwt from "jsonwebtoken";

export const generateAccessToken = (userId: string): string => {
    return jwt.sign({ id: userId }, process.env.JWT_SECRET as string, {
        expiresIn: process.env.JWT_EXPIRES_IN || "1d",
    });
};

export const generateRefreshToken = (userId: string): string => {
    return jwt.sign({ id: userId }, process.env.JWT_REFRESH_SECRET as string, {
        expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "7d",
    });
};

export const verifyRefreshToken = (token: string): { id: string } => {
    return jwt.verify(token, process.env.JWT_REFRESH_SECRET as string) as { id: string };
};