# Hermes - Message Orchestration Service

Central message router and orchestrator for the WebOrdinary platform, managing email ingestion, session tracking, and container coordination.

## 🏗️ Current Architecture (Sprint 7+)

```
┌─────────────────────────────────────────────────────────────┐
│                     Hermes Workflow                          │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  Email → SES → SQS Email Queue                              │
│                    ↓                                          │
│              Hermes Service                                  │
│                    ↓                                          │
│          Parse Email Structure                               │
│                    ↓                                          │
│         Extract/Create Thread ID                             │
│                    ↓                                          │
│        Identify Project + User                               │
│                    ↓                                          │
│    Check Container Ownership (DynamoDB)                      │
│                    ↓                                          │
│         Route to Queues:                                     │
│    ┌───────────────┴───────────────┐                        │
│    ↓                               ↓                         │
│  Project+User Queue          Unclaimed Queue                │
│  (Has active claim)          (No active claim)              │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

## 📋 Key Features

- **Email Processing**: Parses SES messages and extracts instructions
- **Thread Management**: Maps email threads to git branches (`thread-{id}`)
- **Project+User Routing**: Routes messages based on ownership claims
- **Queue Management**: Maintains project-specific and unclaimed queues
- **Session Tracking**: Stores thread mappings in DynamoDB
- **Health Monitoring**: Minimal HTTP endpoint for ECS health checks

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- AWS credentials configured
- Docker for containerized deployment

### Environment Setup

Create `.env`:
```bash
# AWS Configuration
AWS_REGION=us-west-2
AWS_ACCOUNT_ID=942734823970

# Queue Configuration
EMAIL_QUEUE_URL=https://sqs.us-west-2.amazonaws.com/942734823970/webordinary-email-queue
EMAIL_DLQ_URL=https://sqs.us-west-2.amazonaws.com/942734823970/webordinary-email-dlq
UNCLAIMED_QUEUE_URL=https://sqs.us-west-2.amazonaws.com/942734823970/webordinary-unclaimed

# DynamoDB Tables
THREAD_MAPPINGS_TABLE=webordinary-thread-mappings
CONTAINER_OWNERSHIP_TABLE=webordinary-container-ownership
SESSION_TABLE=webordinary-edit-sessions

# Service Configuration
SERVICE_NAME=hermes
CONSUMER_NAME=hermes-email-consumer
LOG_LEVEL=info

# Health Check
HEALTH_CHECK_PATH=/hermes/health
```

### Local Development

```bash
# Install dependencies
npm install

# Run locally
npm run start:dev

# Run with Docker
docker build --platform linux/amd64 -t webordinary/hermes .
docker run -p 3000:3000 --env-file .env webordinary/hermes

# Or use Docker Compose
docker compose -f docker-compose.local.yml up hermes
```

## 📨 Message Processing

### Input: SES Email Format
```typescript
interface SESMessage {
  messageId: string;
  content: string;  // Raw email content including headers
}

// Parsed email structure
interface ParsedEmail {
  from: string;           // Sender email
  to: string;             // Destination (buddy@webordinary.com)
  subject: string;        // Email subject
  messageId: string;      // Email Message-ID header
  inReplyTo?: string;     // Thread reference
  references?: string[];  // Thread chain
  text: string;           // Plain text body
  html?: string;          // HTML body
}
```

### Output: Routed Message
```typescript
interface RoutedMessage {
  // Session Info
  sessionId: string;      // Session identifier
  threadId: string;       // Email thread ID
  
  // Routing Info
  projectId: string;      // Project (e.g., 'amelia')
  userId: string;         // User identifier
  userEmail: string;      // User's email address
  
  // Content
  instruction: string;    // Extracted instruction
  repoUrl?: string;       // Repository URL (if known)
  
  // Metadata
  timestamp: number;      // Processing timestamp
  messageId: string;      // Original email ID
  commandId: string;      // Unique command ID
}
```

## 🔄 Processing Workflow

1. **Receive Email**: Poll SQS email queue for new messages
2. **Parse Structure**: Extract headers and body using mailparser
3. **Extract Thread ID**: 
   - Check In-Reply-To and References headers
   - Extract from Message-ID if new thread
   - Generate if not found
4. **Extract Instruction**: Parse email body, remove quotes/signatures
5. **Identify Project+User**:
   - Check thread mappings table
   - Determine from email context
   - Default to configured project
6. **Check Ownership**: Query container ownership table
7. **Route Message**:
   - If claimed: Send to project+user input queue
   - If unclaimed: Send to both project queue and unclaimed queue
8. **Store Mapping**: Save thread → session mapping

## 🧪 Testing

### Unit Tests
```bash
npm test                        # All unit tests
npm test message-router         # Message routing tests
npm test email-processor        # Email parsing tests
```

### Integration Tests
```bash
AWS_PROFILE=personal npm run test:integration
AWS_PROFILE=personal npm run test:e2e
```

### Test Scenarios
- Email parsing with various formats
- Thread ID extraction and continuity
- Project+user identification
- Queue routing logic
- Error handling and DLQ management

## 🚢 Deployment

### Build and Push to ECR
```bash
# Build container
docker build --platform linux/amd64 -t webordinary/hermes .

# Tag for ECR
docker tag webordinary/hermes:latest \
  942734823970.dkr.ecr.us-west-2.amazonaws.com/webordinary/hermes:latest

# Push to ECR
docker push 942734823970.dkr.ecr.us-west-2.amazonaws.com/webordinary/hermes:latest
```

### Deploy to ECS
```bash
# Update service
AWS_PROFILE=personal aws ecs update-service \
  --cluster webordinary-edit-cluster \
  --service webordinary-hermes-service \
  --force-new-deployment

# Scale service
AWS_PROFILE=personal aws ecs update-service \
  --cluster webordinary-edit-cluster \
  --service webordinary-hermes-service \
  --desired-count 1  # or 0 to stop
```

## 📊 Monitoring

### CloudWatch Logs
```bash
# View logs
AWS_PROFILE=personal aws logs tail /ecs/hermes --since 10m

# Filter for specific thread
AWS_PROFILE=personal aws logs tail /ecs/hermes \
  --filter-pattern "thread-123" --since 1h
```

### Queue Metrics
```bash
# Email queue depth
AWS_PROFILE=personal aws sqs get-queue-attributes \
  --queue-url https://sqs.us-west-2.amazonaws.com/942734823970/webordinary-email-queue \
  --attribute-names ApproximateNumberOfMessages

# DLQ messages
AWS_PROFILE=personal aws sqs get-queue-attributes \
  --queue-url https://sqs.us-west-2.amazonaws.com/942734823970/webordinary-email-dlq \
  --attribute-names ApproximateNumberOfMessages
```

### DynamoDB Tables
```bash
# Check thread mappings
AWS_PROFILE=personal aws dynamodb scan \
  --table-name webordinary-thread-mappings \
  --limit 10

# Check container ownership
AWS_PROFILE=personal aws dynamodb scan \
  --table-name webordinary-container-ownership \
  --filter-expression "attribute_exists(containerId)"
```

## 🔧 Troubleshooting

### Common Issues

| Issue | Solution |
|-------|----------|
| Messages in DLQ | Check for malformed emails or parsing errors |
| Thread ID not found | Verify email headers are preserved |
| Wrong project routing | Check thread mappings and defaults |
| Container not claiming | Verify unclaimed queue processing |
| Health check fails | Ensure path is `/hermes/health` |

### Debug Commands
```bash
# View DLQ messages
AWS_PROFILE=personal aws sqs receive-message \
  --queue-url https://sqs.us-west-2.amazonaws.com/942734823970/webordinary-email-dlq \
  --max-number-of-messages 1

# Check specific thread
AWS_PROFILE=personal aws dynamodb get-item \
  --table-name webordinary-thread-mappings \
  --key '{"threadId": {"S": "thread-123"}}'

# View email queue messages (without deleting)
AWS_PROFILE=personal aws sqs receive-message \
  --queue-url https://sqs.us-west-2.amazonaws.com/942734823970/webordinary-email-queue \
  --visibility-timeout 0
```

## 🏛️ Architecture Decisions

### Why Email-Based Interface?
- Natural conversation flow
- Thread continuity built-in
- Works with any email client
- Async by design
- Audit trail included

### Why Project+User Routing?
- Efficient container utilization
- Workspace persistence
- Reduced cold starts
- Natural work grouping

### Why SQS Over Direct Processing?
- Decoupled architecture
- Natural retry mechanism
- DLQ for error handling
- Scalable processing
- Message durability

## 📚 API Reference

### Health Check Endpoint

**GET** `/hermes/health`

Returns service health status for ECS monitoring.

Response:
```json
{
  "status": "healthy",
  "timestamp": "2024-01-13T10:00:00Z",
  "service": "hermes-message-router"
}
```

## 🔄 Migration from Legacy

### Removed Features
- ❌ Session management endpoints (`/api/sessions/*`)
- ❌ Preview URL generation
- ❌ Container wake endpoints
- ❌ Direct HTTP routing to containers
- ❌ Session-per-container pattern

### New Patterns
- ✅ Pure message routing via SQS
- ✅ Project+user ownership model
- ✅ Thread-to-branch mapping
- ✅ Minimal HTTP (health only)
- ✅ DynamoDB for all state

## 📈 Performance Targets

- Email parsing: < 500ms
- Message routing: < 1s
- Queue delivery: < 2s
- Thread lookup: < 100ms
- Health check: < 50ms

## 🔐 Security

- No credentials in messages
- IAM roles for AWS access
- Private subnets in VPC
- Encrypted queues and tables
- No public endpoints (except health)

## 📝 Message Format Validation

Hermes validates and rejects:
- Test messages with `unknown` fields
- Messages missing required fields
- Malformed email structures
- Invalid thread IDs
- Spam/automated messages

Valid messages must:
- Come from recognized email format
- Have clear instruction text
- Include valid sender email
- Target buddy@webordinary.com

## 🚨 Alerts and Monitoring

Configure CloudWatch alarms for:
- DLQ message count > 10
- Email queue age > 5 minutes
- Processing errors > 5/minute
- Memory usage > 80%
- No messages processed > 10 minutes

## 📝 License

Proprietary - WebOrdinary 2025

---

For system architecture, see [Architecture Overview](../refactor-authority/README.md)