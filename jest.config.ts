import type { Config } from "jest";

const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["<rootDir>/src/__tests__/**/*.test.ts"],
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: { esModuleInterop: true, module: "CommonJS" } }],
  },
  clearMocks: true,
  testTimeout: 10000,
  verbose: true,
};

export default config;
