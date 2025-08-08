import { BaseMessage } from "@langchain/core/messages";
import { ParsedMail } from "mailparser";

export interface PlanStep {
  tool: string;
  args: Record<string, any>;
  description?: string;
}

export interface SiteState {
  email: ParsedMail;                     // original SES/SNS payload after parsing
  messages: BaseMessage[];               // running chat history
  plan: PlanStep[] | null;              // plan = [{ tool: "cms.addPhoto", args: { … } }, …]
  stepIndex: number | null;             // which step we're on
  lastResult: any | null;               // result or error of last tool run
  awaitingUser: boolean;                // true when agent has asked for input
  threadId: string;                     // conversation thread ID
  summary?: string;                     // conversation summary for long-term memory
  missingInfo?: string[];               // missing information needed from user
  routing?: string;                     // routing decision for conditional edges
}

export interface PlanExecutionResult {
  success: boolean;
  result?: any;
  error?: string;
  requiresUserInput?: boolean;
  questions?: string[];
}