import { BedrockChat } from "@langchain/community/chat_models/bedrock";
import { HumanMessage, SystemMessage, AIMessage } from "@langchain/core/messages";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { interrupt } from "@langchain/langgraph";
import { BedrockModel } from "src/core/enum/bedrock-model";
import { SiteStateAnnotation } from "./site-state.annotation";
import { PlanStep } from "../types/site-state.interface";
import { createTools } from "../tools";

const PLANNER_PROMPT = `You are a website management assistant. Based on the user's email request, create a detailed plan of CMS API calls and actions needed to fulfill their request.

Output a JSON array of plan steps. Each step should have:
- tool: the tool name to call
- args: the arguments for that tool
- description: a brief description of what this step does

Consider:
1. What content needs to be created/updated/deleted?
2. Does this require user confirmation (e.g., deletions)?
3. Should we build a preview first before publishing?
4. Are there any ambiguities that need clarification?

Available tools:
- cms.addPhoto: Add photos
- cms.updatePage: Update page content
- cms.deletePage: Delete pages (requires confirmation)
- cms.createPost: Create blog posts
- cms.updatePost: Update blog posts
- cms.listContent: List existing content
- netlify.build: Trigger builds (preview or production)
- email.reply: Send email responses
- human: Ask for user input

Output ONLY the JSON array, no other text.`;

const EXECUTOR_PROMPT = `You are executing a step in a website management plan. Use the appropriate tool to complete the task.`;

export async function ingestEmail(state: typeof SiteStateAnnotation.State) {
  const { email } = state;
  const summary = `Email from ${email.from?.text || 'unknown'} with subject: ${email.subject || 'no subject'}. 
Body: ${email.text?.substring(0, 500) || 'no text content'}`;
  
  return {
    messages: [new SystemMessage(summary)],
  };
}

export async function planner(
  state: typeof SiteStateAnnotation.State,
  config: { llm: BedrockChat }
) {
  const { messages } = state;
  const { llm } = config;
  
  const plannerMessages = [
    new SystemMessage(PLANNER_PROMPT),
    ...messages,
    new HumanMessage("Create a plan based on the above request."),
  ];
  
  const response = await llm.invoke(plannerMessages);
  
  try {
    const planContent = response.content as string;
    const plan = JSON.parse(planContent) as PlanStep[];
    
    return {
      plan,
      stepIndex: 0,
      messages: [response],
    };
  } catch (error) {
    console.error("Failed to parse plan:", error);
    return {
      plan: null,
      messages: [
        new AIMessage(`Failed to create plan: ${error.message}. Please try rephrasing your request.`),
      ],
    };
  }
}

export function needUserInfo(state: typeof SiteStateAnnotation.State): "true" | "false" {
  const { plan, lastResult } = state;
  
  if (!plan || plan.length === 0) return "false";
  
  // Check if current step requires user confirmation
  const currentStep = plan[state.stepIndex || 0];
  if (currentStep?.tool.includes("delete")) return "true";
  
  // Check if last execution had an error that needs user input
  if (lastResult?.error && lastResult.requiresUserInput) return "true";
  
  // Check if we have missing info flagged
  if (state.missingInfo && state.missingInfo.length > 0) return "true";
  
  return "false";
}

export async function askUser(state: typeof SiteStateAnnotation.State) {
  const { plan, stepIndex, missingInfo } = state;
  
  let questions: string[] = [];
  
  if (missingInfo && missingInfo.length > 0) {
    questions = missingInfo;
  } else if (plan && stepIndex !== null) {
    const currentStep = plan[stepIndex];
    if (currentStep?.tool.includes("delete")) {
      questions = [
        `Are you sure you want to ${currentStep.description || 'perform this action'}?`,
        "Please reply 'yes' to confirm or provide alternative instructions.",
      ];
    }
  }
  
  // Use interrupt to pause execution and wait for user input
  interrupt({
    draftPlan: plan,
    questions,
    awaitingConfirmation: true,
  });
  
  return {
    awaitingUser: true,
    messages: [
      new AIMessage(
        questions.join("\n") + 
        "\n\nI've paused to wait for your response. Please reply to this email to continue."
      ),
    ],
  };
}

export async function replan(
  state: typeof SiteStateAnnotation.State,
  config: { llm: BedrockChat }
) {
  // After user provides input, replan if needed
  return planner(state, config);
}

export async function executeStep(
  state: typeof SiteStateAnnotation.State,
  config: { toolExecutor: ToolNode }
) {
  const { plan, stepIndex } = state;
  const { toolExecutor } = config;
  
  if (!plan || stepIndex === null || stepIndex >= plan.length) {
    return { lastResult: { error: "No step to execute" } };
  }
  
  const currentStep = plan[stepIndex];
  
  try {
    const result = await toolExecutor.invoke({
      tool: currentStep.tool,
      toolInput: currentStep.args,
    });
    
    return {
      lastResult: { success: true, result },
      messages: [
        new AIMessage(`Completed: ${currentStep.description || currentStep.tool}`),
      ],
    };
  } catch (error) {
    return {
      lastResult: { 
        success: false, 
        error: error.message,
        requiresUserInput: error.message.includes("permission") || 
                          error.message.includes("not found"),
      },
      messages: [
        new AIMessage(`Error executing ${currentStep.tool}: ${error.message}`),
      ],
    };
  }
}

export function incOrFinish(state: typeof SiteStateAnnotation.State) {
  const { plan, stepIndex, lastResult } = state;
  
  if (!plan || stepIndex === null) {
    return { routing: "done" };
  }
  
  // If last step had an error that requires user input, ask user
  if (lastResult?.requiresUserInput) {
    return { routing: "askUser" };
  }
  
  // If we've completed all steps, we're done
  if (stepIndex >= plan.length - 1) {
    return { routing: "done" };
  }
  
  // Otherwise, move to next step
  return {
    stepIndex: stepIndex + 1,
    routing: "executeStep",
  };
}

export async function triggerBuild(
  state: typeof SiteStateAnnotation.State,
  config: { toolExecutor: ToolNode }
) {
  const { toolExecutor } = config;
  
  try {
    const result = await toolExecutor.invoke({
      tool: "netlify.build",
      toolInput: { environment: "preview" },
    });
    
    return {
      lastResult: { buildResult: result },
      messages: [
        new AIMessage("Preview build triggered successfully. You'll receive the preview URL shortly."),
      ],
    };
  } catch (error) {
    return {
      lastResult: { buildError: error.message },
      messages: [
        new AIMessage(`Failed to trigger build: ${error.message}`),
      ],
    };
  }
}

export async function notifyUser(state: typeof SiteStateAnnotation.State) {
  const { plan, lastResult, messages } = state;
  
  // Compile summary of what was done
  const completedSteps = plan?.map(step => step.description || step.tool).join("\n- ") || "";
  const previewUrl = lastResult?.buildResult?.result?.previewUrl;
  
  const summary = `Task completed successfully!

Actions performed:
- ${completedSteps}

${previewUrl ? `Preview your changes: ${previewUrl}` : ''}

Reply to this email if you need any adjustments.`;
  
  return {
    messages: [new AIMessage(summary)],
    awaitingUser: false,
  };
}