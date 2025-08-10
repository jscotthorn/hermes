# Hermes Integration Testing

This directory contains comprehensive integration and load tests for the multi-session SQS architecture.

## Test Structure

```
test/
├── integration/           # Integration tests
│   └── multi-session.spec.ts
├── load/                 # Load testing
│   └── concurrent-sessions.spec.ts
├── jest-integration.json # Integration test config
├── jest-load.json       # Load test config
└── setup-integration.ts # Test setup and utilities
```

## Test Categories

### 1. Integration Tests (`test/integration/`)

Tests the complete multi-session SQS architecture:

- **Container Sharing**: Verifies containers are reused for same user+project
- **Interrupt Handling**: Tests graceful interruption of running commands
- **Queue Management**: Validates queue lifecycle and persistence
- **Message Processing**: Ensures message ordering and isolation
- **Container Lifecycle**: Tests session counting and container restart

### 2. Load Tests (`test/load/`)

Performance and scalability testing:

- **Concurrent Sessions**: 10-25 simultaneous sessions
- **Burst Load**: Rapid session creation
- **Sustained Load**: Continuous load over time
- **Resource Monitoring**: Tracks containers and queues created

## Running Tests

### Prerequisites

1. **AWS Credentials**: Ensure AWS credentials are configured
2. **Environment Variables**: Create `.env.test` file:

```bash
AWS_REGION=us-west-2
AWS_ACCOUNT_ID=942734823970
ECS_CLUSTER_ARN=arn:aws:ecs:us-west-2:942734823970:cluster/webordinary-edit-cluster
QUEUE_TRACKING_TABLE=webordinary-queue-tracking
THREAD_MAPPING_TABLE=webordinary-thread-mappings
CONTAINER_TABLE=webordinary-containers
SESSION_TABLE=webordinary-edit-sessions
```

### Test Commands

```bash
# Run all unit tests
npm test

# Run integration tests
npm run test:integration

# Run load tests
npm run test:load

# Run all tests
npm run test:all

# Run specific test file
npm run test:integration -- multi-session.spec.ts

# Run with coverage
npm run test:cov
```

### Test Options

```bash
# Run tests in watch mode
npm run test:watch

# Debug tests
npm run test:debug

# Run specific test suite
npm run test:integration -- --testNamePattern="Container Sharing"

# Run with verbose output
npm run test:integration -- --verbose
```

## Test Scenarios

### Integration Test Scenarios

1. **Container Sharing**
   - Same user+project → same container
   - Different projects → different containers
   - Different users → different containers

2. **Interrupt Handling**
   - New message interrupts current processing
   - Multiple interrupts handled gracefully
   - Partial work saved on interrupt

3. **Queue Management**
   - One queue set per container
   - Queue persistence in DynamoDB
   - Queue cleanup on termination

4. **Message Processing**
   - Messages processed in order
   - Session isolation maintained
   - Cross-session contamination prevented

5. **Container Lifecycle**
   - Session counting accuracy
   - Container restart handling
   - Idle timeout behavior

### Load Test Scenarios

1. **10 Concurrent Sessions**
   - 3 projects, multiple users
   - Container sharing validation
   - Response time metrics

2. **25 Sessions with Commands**
   - Mixed operations
   - Interrupt handling under load
   - Resource utilization

3. **Burst Load (15 sessions)**
   - Rapid session creation
   - System stability
   - Error rate tracking

4. **Sustained Load (1 minute)**
   - 2 sessions per second
   - Performance consistency
   - Success rate monitoring

## Metrics Collected

### Performance Metrics
- Average response time
- Max/min response times
- Success/failure rates
- Interrupts handled

### Resource Metrics
- Containers created
- Queue sets created
- Active sessions
- Memory usage

### Test Results Format

```typescript
interface LoadTestMetrics {
  totalSessions: number;
  successfulSessions: number;
  failedSessions: number;
  averageResponseTime: number;
  maxResponseTime: number;
  minResponseTime: number;
  containersCreated: number;
  queueSetsCreated: number;
  interruptsHandled: number;
  totalDuration: number;
}
```

## Success Criteria

### Integration Tests
- ✅ All tests pass
- ✅ Container sharing works correctly
- ✅ Interrupts handled gracefully
- ✅ Queue lifecycle managed properly
- ✅ Message ordering preserved
- ✅ No session contamination

### Load Tests
- ✅ 90%+ success rate under load
- ✅ Average response time < 5 seconds
- ✅ Max response time < 15 seconds
- ✅ Container sharing effective
- ✅ No resource leaks

## Troubleshooting

### Common Issues

1. **AWS Credentials Error**
   ```
   Solution: Configure AWS credentials or set environment variables
   ```

2. **Table Not Found**
   ```
   Solution: Deploy CDK stacks first (SqsStack, ContainerLifecycleStack)
   ```

3. **Timeout Errors**
   ```
   Solution: Increase test timeout in jest config or ensure containers are running
   ```

4. **Queue Already Exists**
   ```
   Solution: Clean up orphaned queues with cleanup Lambda
   ```

## CI/CD Integration

Add to GitHub Actions workflow:

```yaml
- name: Run Integration Tests
  run: npm run test:integration
  env:
    AWS_REGION: us-west-2
    AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
    AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}

- name: Run Load Tests
  run: npm run test:load
  if: github.event_name == 'push' && github.ref == 'refs/heads/main'
```

## Monitoring During Tests

Watch CloudWatch metrics:
- Queue message counts
- Container task count
- DLQ messages
- Lambda invocations

## Cleanup

After tests, ensure resources are cleaned:

```bash
# List test queues
aws sqs list-queues --queue-name-prefix webordinary-test-

# Check running containers
aws ecs list-tasks --cluster webordinary-edit-cluster --desired-status RUNNING

# Manual cleanup if needed
aws sqs delete-queue --queue-url <queue-url>
aws ecs stop-task --cluster webordinary-edit-cluster --task <task-arn>
```