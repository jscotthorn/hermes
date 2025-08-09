import { Test, TestingModule } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { ClaudeExecutorService } from './claude-executor.service';
import { of, throwError } from 'rxjs';
import { AxiosResponse } from 'axios';

describe('ClaudeExecutorService', () => {
  let service: ClaudeExecutorService;
  let httpService: HttpService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ClaudeExecutorService,
        {
          provide: HttpService,
          useValue: {
            post: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<ClaudeExecutorService>(ClaudeExecutorService);
    httpService = module.get<HttpService>(HttpService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should execute instruction successfully', async () => {
    const mockResponse: AxiosResponse = {
      data: {
        success: true,
        summary: 'Changes completed',
        filesChanged: ['file1.ts', 'file2.ts'],
      },
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {} as any,
    };

    jest.spyOn(httpService, 'post').mockReturnValue(of(mockResponse));

    const result = await service.executeInstruction(
      'test-session',
      'Update the homepage',
      'user@example.com',
    );

    expect(result.success).toBe(true);
    expect(result.message).toContain('Changes completed');
    expect(result.changes).toHaveLength(2);
    expect(result.previewUrl).toContain('test-session');
  });

  it('should handle approval required responses', async () => {
    const mockResponse: AxiosResponse = {
      data: {
        requiresApproval: true,
        plan: ['Step 1: Delete files', 'Step 2: Rebuild'],
      },
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {} as any,
    };

    jest.spyOn(httpService, 'post').mockReturnValue(of(mockResponse));

    const result = await service.executeInstruction(
      'test-session',
      'Delete all files',
      'user@example.com',
    );

    expect(result.requiresApproval).toBe(true);
    expect(result.plan).toBeDefined();
    expect(result.approvalToken).toBeDefined();
  });

  it('should handle errors gracefully', async () => {
    jest.spyOn(httpService, 'post').mockReturnValue(
      throwError(() => ({
        response: { status: 404 },
        message: 'Not found',
      })),
    );

    const result = await service.executeInstruction(
      'test-session',
      'Test instruction',
      'user@example.com',
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('SESSION_NOT_FOUND');
  });

  it('should detect planning requirements', () => {
    expect((service as any).requiresPlanning('Please delete all files')).toBe(true);
    expect((service as any).requiresPlanning('Update the title')).toBe(false);
    expect((service as any).requiresPlanning('Remove the header')).toBe(true);
  });

  it('should format changes correctly', () => {
    const result = {
      filesChanged: ['file1.ts', { path: 'file2.ts', action: 'Created' }],
      gitCommit: 'abc123',
    };

    const changes = (service as any).formatChanges(result);
    expect(changes).toContain('Modified: file1.ts');
    expect(changes).toContain('Created: file2.ts');
    expect(changes).toContain('Git commit: abc123');
  });
});