import { Type } from "@sinclair/typebox";
import {
  CHOICE_MAX_OPTIONS,
  SCORE_MAX_LEVELS,
  SCORE_MIN_LEVELS,
} from "../constants.ts";

const criteria = Type.Record(Type.String(), Type.String(), {
  minProperties: 1,
  maxProperties: CHOICE_MAX_OPTIONS,
});
const question = Type.Union([
  Type.Object(
    {
      type: Type.Literal("bool"),
      instructions: Type.String({ minLength: 1 }),
      criteria: Type.Optional(
        Type.Object(
          {
            true: Type.Optional(Type.String()),
            false: Type.Optional(Type.String()),
          },
          { additionalProperties: false },
        ),
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("choice"),
      instructions: Type.String({ minLength: 1 }),
      criteria,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("score"),
      instructions: Type.String({ minLength: 1 }),
      criteria: Type.Array(Type.String(), {
        minItems: SCORE_MIN_LEVELS,
        maxItems: SCORE_MAX_LEVELS,
      }),
    },
    { additionalProperties: false },
  ),
]);
const fullAskSchema = Type.Union(
  createAskVariants({ about: Type.Optional(Type.String({ minLength: 1 })) }),
);
const filesAskSchema = Type.Union(createAskVariants({}).slice(0, -1));
export function askSchema<S extends "ask" | "files">(
  surface: S,
): S extends "ask" ? typeof fullAskSchema : typeof filesAskSchema;
export function askSchema(surface: "ask" | "files") {
  return surface === "ask" ? fullAskSchema : filesAskSchema;
}
function createAskVariants<A extends object>(about: A) {
  const variants = [
    Type.Object(
      { intent: Type.Literal("free"), ...about, question },
      { additionalProperties: false },
    ),
    Type.Object(
      { intent: Type.Literal("verify"), ...about, claims: criteria },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        intent: Type.Literal("classify"),
        ...about,
        categories: criteria,
        pick: Type.Optional(
          Type.Union([Type.Literal("one"), Type.Literal("many")]),
        ),
        by: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      { intent: Type.Literal("decide"), ...about, hypotheses: criteria },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        intent: Type.Literal("rate"),
        ...about,
        dimension: Type.String(),
        levels: Type.Array(Type.String(), {
          minItems: SCORE_MIN_LEVELS,
          maxItems: SCORE_MAX_LEVELS,
        }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        intent: Type.Literal("locate"),
        ...about,
        target: Type.String(),
        among: Type.Array(Type.String(), { minItems: 1 }),
        count: Type.Optional(
          Type.Union([Type.Literal("one"), Type.Literal("many")]),
        ),
        attribution: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false },
    ),
  ];
  return variants;
}
export function asksParameter<S extends "ask" | "files">(surface: S) {
  const ask = askSchema(surface);
  return Type.Union([ask, Type.Array(ask, { minItems: 1 }), Type.String()]);
}
