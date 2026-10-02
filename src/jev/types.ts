import type { Result } from "../result.ts";
export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
export type State = { [key: string]: Json };
export type Question =
  | {
      type: "bool";
      instructions: string;
      criteria?: { true?: string; false?: string };
    }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };
export type Answer =
  | { type: "unjudged"; reason: string }
  | { type: "bool"; p: number }
  | {
      type: "choice";
      choice: string;
      confidence: number;
      probabilities: Record<string, number>;
    }
  | {
      type: "score";
      score: number;
      confidence: number;
      legend: Json;
      probabilities: Record<string, number>;
    };
export interface JudgmentMetadata {
  usage?: { inputTokens: number; costUsd: number };
  model?: string;
  calls?: number;
  questions?: number;
  cacheHits?: number;
  cacheRequests?: number;
  batches?: { questionIds: string[]; answers: Record<string, Answer> }[];
}
export type Judgment = Result<{ answers: Record<string, Answer> }> &
  JudgmentMetadata;
export interface JudgmentOptions {
  signal?: AbortSignal;
  groups?: readonly (readonly string[])[];
  witnesses?: readonly string[];
  cache?: boolean;
  beforeRequest?: (questionCount: number) => Result<object>;
  onUsage?: (usage: { inputTokens: number; costUsd: number }) => void;
}
export interface JevClient {
  judge(
    state: State,
    questions: Record<string, Question>,
    options?: JudgmentOptions,
  ): Promise<Judgment>;
  clearCache(): void;
}
