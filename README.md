# Hermes - NestJS Backend Service

Hermes is the backend service for the Webordinary live-editing platform, handling email processing, session management, and Fargate container orchestration.

## Deployment

### Fargate Service (Recommended)
Hermes is deployed as a scale-to-zero Fargate service for cost-effective development:

```bash
# Scale up for development (takes ~30 seconds)
aws ecs update-service --cluster webordinary-edit-cluster --service webordinary-hermes-service --desired-count 1 --profile personal

# Build and deploy new container version
./build-and-push.sh

# Scale down to save costs
aws ecs update-service --cluster webordinary-edit-cluster --service webordinary-hermes-service --desired-count 0 --profile personal
```

**Service Details:**
- **Container**: `942734823970.dkr.ecr.us-west-2.amazonaws.com/webordinary/hermes`
- **API URL**: `https://webordinary-edit-alb-916355172.us-west-2.elb.amazonaws.com/hermes`
- **Health Check**: `/health` endpoint for ALB monitoring
- **Auto-Scaling**: 0-2 tasks based on CPU utilization
- **Cost**: $0/month idle, ~$12-15/month active (0.5 vCPU, 1GB RAM)

### Local Development
For local testing, you can still run Hermes locally:

```bash
npm run build
npm run start
```

## Architecture Overview

### Core Modules
- **EditSessionModule**: Manages DynamoDB sessions and Fargate scaling
- **MessagePipelineModule**: Processes emails and executes user instructions
- **BedrockModule**: Integrates with AWS Bedrock for AI model inference

### Session Management
Hermes provides REST API endpoints for edit session lifecycle:
- `POST /api/sessions/activate` - Create new edit session
- `GET /api/sessions/{sessionId}/status` - Check session status  
- `POST /api/sessions/{sessionId}/keepalive` - Extend session TTL
- `POST /api/sessions/{sessionId}/deactivate` - End session
- `GET /api/sessions/client/{clientId}` - List client sessions

### AWS Integration Services
- **SQS**: Email message processing from SES
- **DynamoDB**: Session state storage with TTL
- **ECS**: Direct control of edit container scaling
- **CloudWatch**: Metrics publishing for auto-scaling
- **Bedrock**: AI model inference for email classification
- **SES**: Email response sending

## Configuration

Environment variables loaded via NestJS ConfigService:
- `NODE_ENV`: production | development
- `PORT`: 3000 (default)
- `AWS_REGION`: us-west-2
- `DYNAMODB_TABLE_NAME`: webordinary-edit-sessions
- `ECS_CLUSTER_NAME`: webordinary-edit-cluster
- `ECS_SERVICE_NAME`: webordinary-edit-service

## Development Commands

```bash
# Install dependencies
npm install

# Development with hot reload
npm run start:dev

# Build for production
npm run build

# Run tests
npm run test

# Run tests with coverage
npm run test:cov

# Run end-to-end tests
npm run test:e2e

# Lint and fix
npm run lint

# Format code
npm run format
```

## Container Management

### Building and Pushing
```bash
# Build and push to ECR (tags as 'latest' by default)
./build-and-push.sh

# Build and push with custom tag
./build-and-push.sh v1.2.3
```

### Dockerfile Features
- Multi-stage build for production optimization
- Health checks via curl
- Non-root user for security
- Alpine-based Node.js 20 runtime

## Testing Strategy

- **Unit Tests**: Service logic and API endpoints
- **Integration Tests**: AWS service interactions  
- **E2E Tests**: Complete email�session�preview flow
- **Health Checks**: Container and service availability

## Session Lifecycle Flow

1. **Email Ingestion**: SES � SQS � Hermes processes message
2. **Session Creation**: Creates DynamoDB session with unique ID
3. **Container Scaling**: ECS API scales edit service from 0�1
4. **Preview URL**: Returns `edit.domain.com/session/{sessionId}`
5. **Activity Monitoring**: Updates session TTL on each request
6. **Auto-Shutdown**: Scales containers to 0 after 5min idle
7. **Session Cleanup**: DynamoDB TTL removes expired sessions

## Production Site Integration

### Amelia Stamps Client
- **Production**: https://amelia.webordinary.com (CloudFront → S3)
- **Editor**: https://edit.amelia.webordinary.com (ALB → Fargate)
- **GitHub Repo**: ameliastamps/amelia-astro
- **Build Pipeline**: GitHub webhook → Lambda → S3 → CloudFront invalidation

### Deployment Flow
1. **Edit Session**: User makes changes via Claude Code in Fargate
2. **Git Commit**: Changes committed to feature branch
3. **PR/Merge**: User approves changes to main branch
4. **Auto-Deploy**: GitHub webhook triggers Lambda build
5. **Live Update**: CloudFront serves updated static site

## Cost Optimization

### Development Mode
- **Idle**: $0/month (both Hermes and edit services at 0)
- **Active**: ~$27-30/month combined when both services running
- **Typical**: ~$8-15/month for 10-20 hours of development work

### Production Scaling
- **Always-On**: ~$25-30/month for Hermes + edit service costs
- **Auto-Scale**: Variable based on email volume and session activity
- **Multi-Client**: Shared ALB and infrastructure reduce per-client costs

## Monitoring & Observability

- **Health Endpoint**: `/health` returns service status
- **CloudWatch Logs**: Structured logging via Winston
- **ECS Service Insights**: Container metrics and auto-scaling events
- **ALB Health Checks**: 30-second intervals with graceful degradation
- **DynamoDB Metrics**: Session creation/expiration tracking

## Security

- **IAM Roles**: Least-privilege access to AWS services
- **VPC Security Groups**: Service-to-service communication only
- **Secrets Manager**: GitHub tokens and sensitive configuration
- **Container Security**: Non-root user, minimal attack surface
- **API Authentication**: Ready for JWT/OAuth integration

## Future Enhancements

- **Auto-scaling triggers**: Scale based on email volume patterns
- **Multi-region**: Deploy across regions for global availability  
- **Circuit breakers**: Resilient handling of AWS service failures
- **Caching layer**: Redis for frequent session lookups
- **Batch processing**: Bundle multiple emails for efficiency