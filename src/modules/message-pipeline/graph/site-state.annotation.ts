import { Annotation } from "@langchain/langgraph";
import { BaseMessage } from "@langchain/core/messages";
import { ParsedMail } from "mailparser";
import { PlanStep } from "../types/site-state.interface";

export const SiteStateAnnotation = Annotation.Root({
  email: Annotation<ParsedMail>,
  messages: Annotation<BaseMessage[]>({
    reducer: (x, y) => x.concat(y),
    default: () => [],
  }),
  plan: Annotation<PlanStep[] | null>({
    reducer: (x, y) => (x ? x.concat(y ?? []) : y ?? null),
    default: () => null,
  }),
  stepIndex: Annotation<number | null>({
    reducer: (x, y) => y,
    default: () => null,
  }),
  lastResult: Annotation<any | null>({
    reducer: (x, y) => y,
    default: () => null,
  }),
  awaitingUser: Annotation<boolean>({
    reducer: (x, y) => y,
    default: () => false,
  }),
  threadId: Annotation<string>,
  summary: Annotation<string | undefined>({
    reducer: (x, y) => y,
    default: () => undefined,
  }),
  missingInfo: Annotation<string[] | undefined>({
    reducer: (x, y) => (x ? x.concat(y ?? []) : y ?? undefined),
    default: () => undefined,
  }),
  routing: Annotation<string | undefined>({
    reducer: (x, y) => y,
    default: () => undefined,
  }),
});