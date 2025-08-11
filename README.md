# Hermes - Message Orchestration Service

Hermes orchestrates the multi-session SQS architecture, handling message processing, session management, and container lifecycle for the Webordinary edit platform.

## Architecture

### Core Functions
- **SQS Message Processing**: Routes messages between services
- **Container Management**: One container per user+project
- **Session Tracking**: DynamoDB-backed session persistence
- **S3 Deployment**: Containers build and deploy to S3 buckets
- **Queue Lifecycle**: Dynamic queue creation and cleanup

### AWS Services
- **SQS**: Message queues for container communication
- **DynamoDB**: Session and container state storage
- **ECS**: Container orchestration on Fargate
- **CloudWatch**: Logging and monitoring
- **S3**: Static site deployment target

## Deployment

### ECS/Fargate Service
```bash
# Scale up for development
AWS_PROFILE=personal aws ecs update-service \
  --cluster webordinary-edit-cluster \
  --service webordinary-hermes-service \
  --desired-count 1

# Deploy new version
./build-and-push.sh

# Scale down to save costs
AWS_PROFILE=personal aws ecs update-service \
  --cluster webordinary-edit-cluster \
  --service webordinary-hermes-service \
  --desired-count 0
```

**Service Details**:
- Container: `942734823970.dkr.ecr.us-west-2.amazonaws.com/webordinary/hermes`
- Health: `/hermes/health`
- Cost: $0/month idle, ~$12-15/month active

## Development

### Local Setup
```bash
# Install dependencies
npm install

# Run locally
npm run start:dev

# Build for production
npm run build
```

### Testing
```bash
# Unit tests
npm test

# Integration tests (requires AWS)
AWS_PROFILE=personal npm run test:integration

# E2E tests
npm run test:e2e

# Coverage
npm run test:cov
```

## Environment Variables

Create `.env.local`:
```bash
AWS_PROFILE=personal
AWS_REGION=us-west-2
AWS_ACCOUNT_ID=942734823970

# DynamoDB Tables
QUEUE_TRACKING_TABLE=webordinary-queue-tracking
THREAD_MAPPING_TABLE=webordinary-thread-mappings
CONTAINER_TABLE=webordinary-containers
SESSION_TABLE=webordinary-edit-sessions

# ECS Configuration
ECS_CLUSTER_ARN=arn:aws:ecs:us-west-2:942734823970:cluster/webordinary-edit-cluster
```

## Message Flow

### Current S3 Architecture (Sprint 6/7)
1. **Inbound**: Email/SMS/Chat → SQS → Hermes
2. **Container**: Find/start container for user+project
3. **Processing**: Send to container's input queue
4. **Build & Deploy**: Container builds Astro → syncs to S3
5. **Response**: Container output queue → Hermes → User
6. **Live Site**: S3 bucket serves static content

### Key Points
- Containers don't serve HTTP (no port 8080)
- All web content served from S3
- CloudWatch logs for health monitoring
- One queue set per container (not per session)

## API Endpoints

### Session Management
- `POST /api/sessions/activate` - Create session
- `GET /api/sessions/{sessionId}/status` - Check status
- `POST /api/sessions/{sessionId}/keepalive` - Extend TTL
- `POST /api/sessions/{sessionId}/deactivate` - End session

### Health & Monitoring
- `GET /hermes/health` - Service health check
- `GET /metrics` - Prometheus metrics (if enabled)

## Container Management

### Build and Push
```bash
# Build with correct architecture
docker build --platform linux/amd64 -t webordinary/hermes .

# Tag and push to ECR
./build-and-push.sh [version]
```

### Queue Management
- Input queue: `webordinary-input-{containerId}`
- Output queue: `webordinary-output-{containerId}`
- DLQ: `webordinary-dlq-{containerId}`

## Monitoring

### CloudWatch Logs
```bash
# Recent logs
AWS_PROFILE=personal aws logs tail /ecs/hermes --since 5m

# Error logs
AWS_PROFILE=personal aws logs tail /ecs/hermes \
  --filter-pattern "ERROR OR Exception"
```

### SQS Monitoring
```bash
# Queue depth
AWS_PROFILE=personal aws sqs get-queue-attributes \
  --queue-url https://sqs.us-west-2.amazonaws.com/942734823970/webordinary-email-queue \
  --attribute-names ApproximateNumberOfMessages
```

## Cost Optimization

- **Idle**: $0/month (scale to 0)
- **Active**: ~$12-15/month (0.5 vCPU, 1GB RAM)
- **SQS**: <$1/month for typical usage

## Security

- IAM roles with least privilege
- VPC security groups
- Non-root container user
- Secrets in environment variables

## Troubleshooting

See CLAUDE.md for quick reference commands and common issues.