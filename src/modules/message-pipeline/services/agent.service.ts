import { Injectable } from '@nestjs/common';
import { BedrockChat } from "@langchain/community/chat_models/bedrock";
import { BedrockModel } from 'src/core/enum/bedrock-model';
import { ConfigService } from '@nestjs/config';
import {
  START,
  END,
  StateGraph,
  MemorySaver,
} from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { v4 as uuidv4 } from "uuid";
import { ParsedMail } from "mailparser";
import { SiteStateAnnotation } from '../graph/site-state.annotation';
import { createTools } from '../tools';
import * as nodes from '../graph/nodes';
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { HumanMessage } from "@langchain/core/messages";

@Injectable()
export class AgentService {
  #opus: BedrockChat;  // Use Opus for planning
  #sonnet: BedrockChat;  // Use Sonnet for execution
  #app: any;
  #checkpointer: SqliteSaver;
  #tools: any[];
  #toolNode: ToolNode;

  constructor(private configService: ConfigService) {
    // Initialize Opus for planning (better reasoning)
    // Note: Using Sonnet for now as Opus model ID may need verification
    this.#opus = new BedrockChat({
      model: BedrockModel.OPUS4_1,
      region: this.configService.get('aws.bedrockRegion'),
      credentials: {
        accessKeyId: this.configService.get<string>('aws.accessKeyId') ?? '',
        secretAccessKey: this.configService.get<string>('aws.secretAccessKey') ?? '',
      },
      modelKwargs: {
        temperature: 0,
        max_tokens: 4096,
      },
    });

    // Initialize Sonnet for execution (cost-effective)
    this.#sonnet = new BedrockChat({
      model: BedrockModel.SONNET4,
      region: this.configService.get('aws.bedrockRegion'),
      credentials: {
        accessKeyId: this.configService.get<string>('aws.accessKeyId') ?? '',
        secretAccessKey: this.configService.get<string>('aws.secretAccessKey') ?? '',
      },
      modelKwargs: {
        temperature: 0,
        max_tokens: 2048,
      },
    });

    // Initialize tools
    this.#tools = createTools();
    this.#toolNode = new ToolNode(this.#tools);

    // Initialize checkpointer
    const dbPath = process.env.CHECKPOINT_DB || 'sqlite://tmp/langgraph.db';
    this.#checkpointer = SqliteSaver.fromConnString(dbPath);

    // Build the graph
    this.#buildGraph();
  }

  #buildGraph() {
    const workflow = new StateGraph(SiteStateAnnotation)
      // Add nodes
      .addNode("ingestEmail", nodes.ingestEmail)
      .addNode("planner", (state) => nodes.planner(state, { llm: this.#opus }))
      .addNode("askUser", nodes.askUser)
      .addNode("replan", (state) => nodes.replan(state, { llm: this.#opus }))
      .addNode("executeStep", (state) => nodes.executeStep(state, { toolExecutor: this.#toolNode }))
      .addNode("incOrFinish", nodes.incOrFinish)
      .addNode("triggerBuild", (state) => nodes.triggerBuild(state, { toolExecutor: this.#toolNode }))
      .addNode("notifyUser", nodes.notifyUser);

    // Add edges
    workflow
      .addEdge(START, "ingestEmail")
      .addEdge("ingestEmail", "planner")
      .addConditionalEdges(
        "planner",
        nodes.needUserInfo,
        {
          "true": "askUser",
          "false": "executeStep",
        }
      )
      .addEdge("askUser", END)  // Exit to wait for user response
      .addEdge("replan", "planner")
      .addEdge("executeStep", "incOrFinish")
      .addConditionalEdges(
        "incOrFinish",
        (state) => state.routing || "done",
        {
          executeStep: "executeStep",
          askUser: "askUser",
          done: "triggerBuild",
        }
      )
      .addEdge("triggerBuild", "notifyUser")
      .addEdge("notifyUser", END);

    // Compile with checkpointer
    this.#app = workflow.compile({
      checkpointer: this.#checkpointer,
      interruptBefore: ["askUser"],
    });
  }

  async invokeApp(email: ParsedMail, threadId?: string) {
    const thread_id = threadId ?? uuidv4();
    const config = { configurable: { thread_id } };

    try {
      // Check if this is a continuation of an existing conversation
      const existingState = await this.#checkpointer.getTuple(config);

      let input;
      if (existingState?.checkpoint) {
        // Resume from interrupt - add new message
        input = {
          messages: [new HumanMessage(email.text || "")],
          awaitingUser: false,
        };
      } else {
        // New conversation
        input = {
          email,
          threadId: thread_id,
          messages: [],
        };
      }

      const output = await this.#app.invoke(input, config);

      return {
        thread_id,
        response: output.messages[output.messages.length - 1],
        state: output,
      };
    } catch (error) {
      console.error("Error in agent execution:", error);
      throw error;
    }
  }

  async getThreadState(threadId: string) {
    const config = { configurable: { thread_id: threadId } };
    const state = await this.#checkpointer.getTuple(config);
    return state?.checkpoint;
  }

}
