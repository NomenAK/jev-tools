import { createHash } from "node:crypto";
import { setTimeout as timerSleep } from "node:timers/promises";
import {
  HTTP_ERROR_MAX_CHARS,
  REQUEST_ATTEMPTS,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  TIMEOUT_MS,
} from "../constants.ts";
import { prepareBatches, splitGroups } from "../core/batches.ts";
import { truncate } from "../core/truncate.ts";
import { isRecord } from "../result.ts";
import { type Clock, createPool, type Pool } from "./pool.ts";
import type {
  Answer,
  JevClient,
  Json,
  Judgment,
  JudgmentMetadata,
  Question,
} from "./types.ts";
export interface JevConfig {
  url: string;
  apiKey: string;
  model: string;
}
export interface ClientDependencies extends Clock {
  fetch: typeof fetch;
  timeoutMs: number;
  pool?: Pool;
}
export function readConfig(env: NodeJS.ProcessEnv): JevConfig | undefined {
  return env.JEV_TOOLS_URL && env.JEV_TOOLS_API_KEY
    ? {
        url: env.JEV_TOOLS_URL,
        apiKey: env.JEV_TOOLS_API_KEY,
        model: env.JEV_TOOLS_MODEL || "openjev",
      }
    : undefined;
}
function httpError(body: unknown, text: string, apiKey: string): string {
  const error = isRecord(body) ? (body.error ?? body.message) : undefined;
  const detail =
    typeof error === "string"
      ? error
      : isRecord(error) && typeof error.message === "string"
        ? error.message
        : body === undefined
          ? text
          : "No error message provided.";
  const redacted = detail.replaceAll(apiKey, "[redacted]");
  return redacted.length > HTTP_ERROR_MAX_CHARS
    ? `${truncate(redacted, HTTP_ERROR_MAX_CHARS)}…`
    : redacted;
}
function isJson(value: unknown): value is Json {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (Array.isArray(value)
      ? value.every(isJson)
      : isRecord(value) && Object.values(value).every(isJson))
  );
}
function probabilities(value: unknown): value is Record<string, number> {
  return (
    isRecord(value) &&
    Object.keys(value).length > 0 &&
    Object.values(value).every(
      (p) => typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 1,
    )
  );
}
function normalize(value: unknown, question: Question): Answer {
  const invalid: Answer = {
    type: "unjudged",
    reason: "Invalid or missing Jev answer.",
  };
  if (!isRecord(value)) return invalid;
  if (question.type === "bool")
    return typeof value.noul === "number" && value.noul >= 0 && value.noul <= 1
      ? { type: "bool", p: value.noul }
      : invalid;
  if (
    typeof value.confidence !== "number" ||
    !Number.isFinite(value.confidence) ||
    !probabilities(value.probabilities)
  )
    return invalid;
  if (question.type === "choice")
    return typeof value.choice === "string" &&
      Object.hasOwn(question.criteria, value.choice) &&
      Object.hasOwn(value.probabilities, value.choice) &&
      Object.keys(value.probabilities).every((key) =>
        Object.hasOwn(question.criteria, key),
      )
      ? {
          type: "choice",
          choice: value.choice,
          confidence: value.confidence,
          probabilities: value.probabilities,
        }
      : invalid;
  return typeof value.score === "number" &&
    Number.isFinite(value.score) &&
    value.score >= 0 &&
    value.score <= question.criteria.length - 1 &&
    isJson(value.legend)
    ? {
        type: "score",
        score: value.score,
        confidence: value.confidence,
        legend: value.legend,
        probabilities: value.probabilities,
      }
    : invalid;
}
function metadata(body: unknown): JudgmentMetadata {
  if (!isRecord(body)) return {};
  const usage = body.usage;
  return {
    ...(typeof body.model === "string" ? { model: body.model } : {}),
    ...(isRecord(usage) &&
    typeof usage.input_tokens === "number" &&
    Number.isFinite(usage.input_tokens) &&
    usage.input_tokens >= 0 &&
    typeof usage.cost === "number" &&
    Number.isFinite(usage.cost) &&
    usage.cost >= 0
      ? { usage: { inputTokens: usage.input_tokens, costUsd: usage.cost } }
      : {}),
  };
}
function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key] as Json)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function hash(value: Json): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function wireQuestions(questions: Record<string, Question>) {
  return Object.fromEntries(
    Object.entries(questions).map(([id, q]) => [
      id,
      {
        ...q,
        type: q.type === "bool" ? "noul" : q.type,
        ...(q.type === "bool"
          ? {
              criteria: {
                true: q.criteria?.true ?? "Yes",
                false: q.criteria?.false ?? "No",
              },
            }
          : {}),
      },
    ]),
  );
}
export function createJevClient(
  config: JevConfig,
  injected?: Partial<ClientDependencies>,
): JevClient {
  const clock: Clock = {
    now: injected?.now ?? (() => performance.now()),
    sleep:
      injected?.sleep ??
      ((ms, signal) => timerSleep(ms, undefined, { signal })),
  };
  const processPoolKey = Symbol.for("jev-tools.request-pool");
  const processPools = globalThis as typeof globalThis & {
    [processPoolKey]?: Pool;
  };
  if (!injected) processPools[processPoolKey] ??= createPool(clock);
  const pool =
    injected?.pool ??
    (injected ? createPool(clock) : (processPools[processPoolKey] as Pool));
  const request = injected?.fetch ?? fetch;
  const timeoutMs = injected?.timeoutMs ?? TIMEOUT_MS;
  const cache = new Map<string, Answer>();
  const witnessCache = new Map<string, Record<string, Answer>>();
  let generation = 0;
  return {
    clearCache() {
      cache.clear();
      witnessCache.clear();
      generation++;
    },
    async judge(state, questions, options = {}): Promise<Judgment> {
      const planned = prepareBatches(state, questions, options);
      if (!planned.ok) return planned;
      const answers: Record<string, Answer> = {};
      const meta: JudgmentMetadata = {
        calls: 0,
        questions: 0,
        cacheHits: 0,
        cacheRequests: Object.keys(questions).length,
        batches: [],
      };
      const epoch = generation;
      const stateKey = hash(state);
      const keys = new Map(
        Object.entries(questions).map(([id, q]) => [
          id,
          `${stateKey}:${hash(JSON.parse(JSON.stringify(q)) as Json)}:${config.model}`,
        ]),
      );
      const witnesses = options.witnesses ?? [];
      const witnessSet = new Set(witnesses);
      const witnessKey = (group: readonly string[]) =>
        JSON.stringify([
          group.map((id) => keys.get(id)),
          witnesses.map((id) => keys.get(id)),
        ]);
      let stopped: string | undefined;
      let stateChecked = false;
      let failure: string | undefined;
      const addMetadata = (body: unknown) => {
        const next = metadata(body);
        if (next.model) meta.model = next.model;
        if (next.usage) {
          meta.usage ??= { inputTokens: 0, costUsd: 0 };
          meta.usage.inputTokens += next.usage.inputTokens;
          meta.usage.costUsd += next.usage.costUsd;
          options.onUsage?.(next.usage);
        }
      };
      const missing = (ids: readonly string[], reason: string) => {
        const batchAnswers = Object.fromEntries(
          ids.map((id) => [id, { type: "unjudged" as const, reason }]),
        );
        for (const [id, answer] of Object.entries(batchAnswers))
          if (!witnessSet.has(id) || !answers[id]) answers[id] = answer;
        meta.batches?.push({ questionIds: [...ids], answers: batchAnswers });
      };
      const send = async (
        groups: readonly (readonly string[])[],
        diagnostic = false,
      ): Promise<void> => {
        const ids = [...groups.flat(), ...(diagnostic ? [] : witnesses)];
        if (stopped) {
          missing(ids, stopped);
          return;
        }
        const selected = Object.fromEntries(
          ids.map((id) => [id, questions[id] as Question]),
        );
        const payload = JSON.stringify({
          model: config.model,
          state,
          questions: wireQuestions(selected),
        });
        for (let attempt = 0; attempt < REQUEST_ATTEMPTS; attempt++) {
          let release: (() => void) | undefined;
          let settle: (() => void) | undefined;
          const timeoutCancellation = new AbortController();
          let retryMs = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt);
          try {
            release = await pool.acquire(options.signal);
            if (stopped) {
              missing(ids, stopped);
              return;
            }
            await options.awaitAdmission?.();
            if (stopped) {
              missing(ids, stopped);
              return;
            }
            const admission = options.beforeRequest?.(ids.length);
            if (admission && !admission.ok) {
              // A diagnostic denied admission supplies no judgment batch and
              // must not replace the token refusal with a budget reason.
              if (diagnostic) return;
              stopped = admission.error;
              missing(ids, stopped);
              return;
            }
            settle = options.afterRequest;
            const timeout = new AbortController();
            void clock.sleep(timeoutMs, timeoutCancellation.signal).then(
              () => timeout.abort(new Error("Jev request timeout")),
              () => {},
            );
            meta.calls = (meta.calls ?? 0) + 1;
            meta.questions = (meta.questions ?? 0) + ids.length;
            const response = await request(config.url, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                Authorization: `Bearer ${config.apiKey}`,
              },
              body: payload,
              signal: options.signal
                ? AbortSignal.any([options.signal, timeout.signal])
                : timeout.signal,
            });
            const text = await response.text();
            let body: unknown;
            try {
              body = JSON.parse(text);
            } catch {
              body = undefined;
            }
            addMetadata(body);
            // Release the USD gate before any subdivision re-enters send().
            settle?.();
            settle = undefined;
            release();
            release = undefined;
            if (
              response.status === 400 &&
              text.includes("max_tokens_exceeded")
            ) {
              if (diagnostic) {
                stopped =
                  "Jev max_tokens_exceeded: state too large for a single question; remaining questions not judged.";
                return;
              }
              if (ids.length === 1) {
                missing(
                  ids,
                  "Jev max_tokens_exceeded: state too large for a single question; question not judged.",
                );
                return;
              }
              if (!stateChecked && groups.length > 1) {
                stateChecked = true;
                // Assume token cost grows with serialized question size on the
                // same state. This is not a tokenizer guarantee: non-monotone
                // cases are more conservative than main (unjudged), never
                // more optimistic. The probe answer is discarded, not cached.
                let probeId = ids[0] as string;
                let probeSize = Infinity;
                for (const [id, question] of Object.entries(
                  wireQuestions(questions),
                )) {
                  const size = JSON.stringify(question).length;
                  if (size < probeSize) {
                    probeId = id;
                    probeSize = size;
                  }
                }
                await send([[probeId]], true);
                if (stopped) {
                  missing(ids, stopped);
                  return;
                }
              }
              const split = splitGroups(groups);
              if (split.ok)
                await Promise.all(split.halves.map((half) => send(half)));
              else missing(ids, split.error);
              return;
            }
            if (response.ok && isRecord(body)) {
              if (diagnostic) return;
              const raw = isRecord(body.answers) ? body.answers : {};
              const batchAnswers = Object.fromEntries(
                ids.map((id) => [
                  id,
                  normalize(raw[id], selected[id] as Question),
                ]),
              );
              meta.batches?.push({ questionIds: ids, answers: batchAnswers });
              for (const [id, answer] of Object.entries(batchAnswers)) {
                if (!witnessSet.has(id) || !answers[id]) answers[id] = answer;
                if (
                  options.cache !== false &&
                  !witnessSet.has(id) &&
                  epoch === generation &&
                  answer.type !== "unjudged"
                )
                  cache.set(keys.get(id) as string, structuredClone(answer));
              }
              if (
                witnesses.length > 0 &&
                options.cache !== false &&
                epoch === generation &&
                witnesses.every((id) => batchAnswers[id]?.type !== "unjudged")
              ) {
                for (const group of groups) {
                  if (
                    group.every((id) => batchAnswers[id]?.type !== "unjudged")
                  )
                    witnessCache.set(
                      witnessKey(group),
                      structuredClone(
                        Object.fromEntries(
                          witnesses.map((id) => [
                            id,
                            batchAnswers[id] as Answer,
                          ]),
                        ),
                      ),
                    );
                }
              }
              return;
            }
            if (diagnostic) return;
            const retryAfter =
              response.status === 429
                ? Number(response.headers.get("retry-after"))
                : 0;
            if (
              Number.isFinite(retryAfter) &&
              retryAfter * 1_000 > RETRY_MAX_MS
            ) {
              const reason = `Jev HTTP 429, retry after ${retryAfter} s`;
              failure ??= reason;
              missing(ids, reason);
              return;
            }
            const reason = response.ok
              ? "Invalid Jev response: expected a JSON object."
              : `Jev HTTP ${response.status}: ${httpError(body, text, config.apiKey)}${response.status === 401 || response.status === 403 ? "; check JEV_TOOLS_API_KEY." : ""}`;
            if (
              !(
                response.status === 408 ||
                response.status === 429 ||
                response.status >= 500
              ) ||
              attempt === REQUEST_ATTEMPTS - 1
            ) {
              failure ??= reason;
              if (response.status === 401 || response.status === 403)
                stopped = reason;
              missing(ids, reason);
              return;
            }
            if (Number.isFinite(retryAfter) && retryAfter >= 0)
              retryMs = Math.max(retryMs, retryAfter * 1_000);
          } catch (error) {
            // A failed diagnostic is not evidence of a token limit. Continue
            // ordinary subdivision without delivering its answer or error.
            if (diagnostic) return;
            const reason = `Jev request failed: ${String(error).replaceAll(config.apiKey, "[redacted]")}`;
            if (options.signal?.aborted || attempt === REQUEST_ATTEMPTS - 1) {
              failure ??= reason;
              missing(ids, reason);
              return;
            }
          } finally {
            settle?.();
            release?.();
            timeoutCancellation.abort();
          }
          try {
            await clock.sleep(retryMs, options.signal);
          } catch (error) {
            const reason = `Jev request failed: ${String(error).replaceAll(config.apiKey, "[redacted]")}`;
            failure ??= reason;
            missing(ids, reason);
            return;
          }
        }
      };
      const pending = planned.batches
        .map((batch) =>
          batch.filter((group) => {
            if (
              options.cache === false ||
              !group.every((id) => cache.has(keys.get(id) as string)) ||
              (witnesses.length > 0 && !witnessCache.has(witnessKey(group)))
            )
              return true;
            for (const id of group) {
              answers[id] = structuredClone(
                cache.get(keys.get(id) as string) as Answer,
              );
              meta.cacheHits = (meta.cacheHits ?? 0) + 1;
            }
            const observedWitnesses = structuredClone(
              witnessCache.get(witnessKey(group)) ?? {},
            );
            for (const [id, answer] of Object.entries(observedWitnesses)) {
              if (!answers[id]) {
                answers[id] = answer;
                meta.cacheHits = (meta.cacheHits ?? 0) + 1;
              }
            }
            const cachedIds = [...group, ...witnesses];
            meta.batches?.push({
              questionIds: cachedIds,
              answers: Object.fromEntries(
                cachedIds.map((id) => [
                  id,
                  witnessSet.has(id)
                    ? (observedWitnesses[id] as Answer)
                    : structuredClone(
                        cache.get(keys.get(id) as string) as Answer,
                      ),
                ]),
              ),
            });
            return false;
          }),
        )
        .filter((batch) => batch.length);
      await Promise.all(pending.map((batch) => send(batch)));
      if (
        failure &&
        !Object.values(answers).some((answer) => answer.type !== "unjudged")
      )
        return { ok: false, error: failure, ...meta };
      return { ok: true, answers, ...meta };
    },
  };
}
