import { HumanMessage, SystemMessage, AIMessage } from "@langchain/core/messages";
import { BedrockChat } from "@langchain/community/chat_models/bedrock";
import * as nodes from './nodes';
import { SiteStateAnnotation } from './site-state.annotation';
import { PlanStep } from '../types/site-state.interface';

describe('Graph Nodes', () => {
  describe('planner', () => {
    it('should create a valid plan from user request', async () => {
      const mockLlm = {
        invoke: jest.fn().mockResolvedValue({
          content: JSON.stringify([
            {
              tool: 'cms.updatePage',
              args: { id: 'homepage', title: 'New Title' },
              description: 'Update homepage title',
            },
            {
              tool: 'netlify.build',
              args: { environment: 'preview' },
              description: 'Build preview site',
            },
          ]),
        }),
      } as unknown as BedrockChat;

      const state = {
        messages: [
          new SystemMessage('Email from user@example.com: Update homepage title'),
          new HumanMessage('Please update the homepage title to "New Title"'),
        ],
      } as typeof SiteStateAnnotation.State;

      const result = await nodes.planner(state, { llm: mockLlm });

      expect(result.plan).toHaveLength(2);
      expect(result.plan[0].tool).toBe('cms.updatePage');
      expect(result.plan[1].tool).toBe('netlify.build');
      expect(result.stepIndex).toBe(0);
    });

    it('should handle invalid JSON response gracefully', async () => {
      const mockLlm = {
        invoke: jest.fn().mockResolvedValue({
          content: 'Invalid JSON response',
        }),
      } as unknown as BedrockChat;

      const state = {
        messages: [new HumanMessage('Test request')],
      } as typeof SiteStateAnnotation.State;

      const result = await nodes.planner(state, { llm: mockLlm });

      expect(result.plan).toBeNull();
      expect(result.messages[0]).toBeInstanceOf(AIMessage);
      expect(result.messages[0].content).toContain('Failed to create plan');
    });
  });

  describe('needUserInfo', () => {
    it('should return true for delete operations', () => {
      const state = {
        plan: [
          { tool: 'cms.deletePage', args: { id: '123' }, description: 'Delete page' },
        ],
        stepIndex: 0,
      } as typeof SiteStateAnnotation.State;

      const result = nodes.needUserInfo(state);
      expect(result).toBe(true);
    });

    it('should return true when missing info is flagged', () => {
      const state = {
        plan: [{ tool: 'cms.updatePage', args: {}, description: 'Update page' }],
        stepIndex: 0,
        missingInfo: ['Which page should I update?'],
      } as typeof SiteStateAnnotation.State;

      const result = nodes.needUserInfo(state);
      expect(result).toBe(true);
    });

    it('should return false for normal operations', () => {
      const state = {
        plan: [{ tool: 'cms.createPost', args: { title: 'New Post' }, description: 'Create post' }],
        stepIndex: 0,
      } as typeof SiteStateAnnotation.State;

      const result = nodes.needUserInfo(state);
      expect(result).toBe(false);
    });
  });

  describe('executeStep', () => {
    it('should execute a tool successfully', async () => {
      const mockToolExecutor = {
        invoke: jest.fn().mockResolvedValue({
          success: true,
          id: 'new-post-123',
        }),
      };

      const state = {
        plan: [
          { tool: 'cms.createPost', args: { title: 'Test Post' }, description: 'Create a test post' },
        ],
        stepIndex: 0,
      } as typeof SiteStateAnnotation.State;

      const result = await nodes.executeStep(state, { toolExecutor: mockToolExecutor });

      expect(mockToolExecutor.invoke).toHaveBeenCalledWith({
        tool: 'cms.createPost',
        toolInput: { title: 'Test Post' },
      });
      expect(result.lastResult.success).toBe(true);
      expect(result.messages[0].content).toContain('Completed: Create a test post');
    });

    it('should handle tool execution errors', async () => {
      const mockToolExecutor = {
        invoke: jest.fn().mockRejectedValue(new Error('API error: not found')),
      };

      const state = {
        plan: [
          { tool: 'cms.updatePage', args: { id: '404' }, description: 'Update missing page' },
        ],
        stepIndex: 0,
      } as typeof SiteStateAnnotation.State;

      const result = await nodes.executeStep(state, { toolExecutor: mockToolExecutor });

      expect(result.lastResult.success).toBe(false);
      expect(result.lastResult.error).toBe('API error: not found');
      expect(result.lastResult.requiresUserInput).toBe(true);
    });
  });

  describe('incOrFinish', () => {
    it('should route to next step', () => {
      const state = {
        plan: [
          { tool: 'cms.createPost', args: {}, description: 'Step 1' },
          { tool: 'cms.updatePage', args: {}, description: 'Step 2' },
        ],
        stepIndex: 0,
        lastResult: { success: true },
      } as typeof SiteStateAnnotation.State;

      const result = nodes.incOrFinish(state);

      expect(result.stepIndex).toBe(1);
      expect(result.routing).toBe('executeStep');
    });

    it('should route to done when all steps completed', () => {
      const state = {
        plan: [
          { tool: 'cms.createPost', args: {}, description: 'Step 1' },
        ],
        stepIndex: 0,
        lastResult: { success: true },
      } as typeof SiteStateAnnotation.State;

      const result = nodes.incOrFinish(state);

      expect(result.routing).toBe('done');
    });

    it('should route to askUser on error requiring input', () => {
      const state = {
        plan: [
          { tool: 'cms.updatePage', args: {}, description: 'Update page' },
        ],
        stepIndex: 0,
        lastResult: { success: false, requiresUserInput: true },
      } as typeof SiteStateAnnotation.State;

      const result = nodes.incOrFinish(state);

      expect(result.routing).toBe('askUser');
    });
  });

  describe('ingestEmail', () => {
    it('should create system message from email', async () => {
      const mockEmail = {
        from: { text: 'user@example.com' },
        subject: 'Test Subject',
        text: 'This is a test email body that should be summarized',
      };

      const state = {
        email: mockEmail,
      } as typeof SiteStateAnnotation.State;

      const result = await nodes.ingestEmail(state);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toBeInstanceOf(SystemMessage);
      expect(result.messages[0].content).toContain('user@example.com');
      expect(result.messages[0].content).toContain('Test Subject');
    });
  });
});