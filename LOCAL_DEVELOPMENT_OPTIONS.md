# Hermes Local Development Options

## Current State Analysis

### AWS Service Dependencies
Hermes currently requires access to the following AWS services:
- **SQS** - Reading from email queue, sending to container queues
- **DynamoDB** - Thread mappings, queue tracking, session management
- **ECS** - Managing Fargate tasks for edit containers
- **EC2** - Describing network interfaces
- **SES** - Sending email responses
- **Bedrock** - Claude API access
- **CloudWatch** - Metrics and logging
- **Secrets Manager** - GitHub token access

### Current Credential Configuration
- Production: Uses ECS Task IAM Role (via `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`)
- Local: Not configured - defaults to SDK credential chain

## Option 1: Direct AWS Credentials (Quickest - 2-4 hours)

### Implementation
```typescript
// hermes/src/core/config/aws-credentials.config.ts
import { fromIni, fromNodeProviderChain } from '@aws-sdk/credential-providers';

export const getAwsCredentials = () => {
  if (process.env.NODE_ENV === 'development') {
    // Use local AWS profile
    return fromIni({ profile: process.env.AWS_PROFILE || 'personal' });
  }
  // Use default chain for production (ECS Task Role)
  return fromNodeProviderChain();
};
```

### Setup Steps
1. Update all AWS SDK client initializations to use credential provider
2. Add `.env.local` file with AWS configuration
3. Run with `npm run start:dev`

### Pros
- ✅ Minimal code changes
- ✅ Quick to implement
- ✅ Uses existing AWS credentials
- ✅ No additional infrastructure

### Cons
- ❌ Uses root account credentials
- ❌ No isolation between local and production
- ❌ Risk of accidentally affecting production resources

### Level of Effort: **2-4 hours**

## Option 2: AssumeRole with Dedicated Dev Role (Recommended - 4-6 hours)

### Implementation
```typescript
// hermes/src/core/config/aws-credentials.config.ts
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { fromTemporaryCredentials } from '@aws-sdk/credential-providers';

export const getAwsCredentials = async () => {
  if (process.env.NODE_ENV === 'development') {
    return fromTemporaryCredentials({
      params: {
        RoleArn: process.env.DEV_ROLE_ARN,
        RoleSessionName: `hermes-local-${Date.now()}`,
        DurationSeconds: 3600,
      },
      masterCredentials: fromIni({ profile: 'personal' }),
    });
  }
  return fromNodeProviderChain();
};
```

### CDK Stack Addition
```typescript
// hephaestus/lib/hermes-dev-role-stack.ts
const devRole = new iam.Role(this, 'HermesLocalDevRole', {
  assumedBy: new iam.ArnPrincipal('arn:aws:iam::942734823970:user/root'),
  roleName: 'hermes-local-development',
  description: 'Role for local Hermes development',
});

// Copy permissions from production taskRole
devRole.addManagedPolicy(/* same policies as production */);
```

### Pros
- ✅ Better security with temporary credentials
- ✅ Can scope permissions specifically for dev
- ✅ Audit trail via CloudTrail
- ✅ Easy to revoke if compromised

### Cons
- ❌ Requires CDK deployment
- ❌ Still using production AWS resources

### Level of Effort: **4-6 hours**

## Option 3: Docker Compose with LocalStack (Most Isolated - 8-12 hours)

### Implementation
```yaml
# docker-compose.yml
version: '3.8'
services:
  localstack:
    image: localstack/localstack:latest
    environment:
      - SERVICES=sqs,dynamodb,ses,secretsmanager
      - AWS_DEFAULT_REGION=us-west-2
    ports:
      - "4566:4566"
    volumes:
      - "./localstack-init:/docker-entrypoint-initaws.d"

  hermes:
    build: ./hermes
    environment:
      - NODE_ENV=development
      - AWS_ENDPOINT_URL=http://localstack:4566
      - AWS_ACCESS_KEY_ID=test
      - AWS_SECRET_ACCESS_KEY=test
    depends_on:
      - localstack
    volumes:
      - ./hermes:/app
    ports:
      - "3000:3000"
```

### Pros
- ✅ Complete isolation from production
- ✅ No AWS costs for development
- ✅ Can reset state easily
- ✅ Safe for testing destructive operations

### Cons
- ❌ LocalStack doesn't support Bedrock/ECS
- ❌ Requires mocking some services
- ❌ Behavior differences from real AWS
- ❌ More complex setup

### Level of Effort: **8-12 hours**

## Option 4: Hybrid Approach (Best Balance - 6-8 hours)

### Implementation
Combine Docker for Hermes with real AWS services using AssumeRole:

```yaml
# docker-compose.yml
version: '3.8'
services:
  hermes:
    build: ./hermes
    environment:
      - NODE_ENV=development
      - AWS_PROFILE=personal
      - DEV_ROLE_ARN=arn:aws:iam::942734823970:role/hermes-local-dev
      - SQS_QUEUE_PREFIX=dev-
      - DYNAMODB_TABLE_PREFIX=dev-
    volumes:
      - ./hermes:/app
      - ~/.aws:/root/.aws:ro  # Mount AWS credentials read-only
    ports:
      - "3000:3000"
    command: npm run start:dev
```

### Additional Setup
1. Create dev-prefixed SQS queues and DynamoDB tables
2. Use environment variables to override resource names
3. Configure separate SES domain for dev emails

### Pros
- ✅ Containerized for consistency
- ✅ Uses real AWS services (no mocking)
- ✅ Isolated resources with prefixes
- ✅ Easy to clean up dev resources
- ✅ Hot-reload for development

### Cons
- ❌ Still incurs some AWS costs
- ❌ Requires duplicate resources

### Level of Effort: **6-8 hours**

## Option 5: VS Code Dev Container (Modern Approach - 5-7 hours)

### Implementation
```json
// .devcontainer/devcontainer.json
{
  "name": "Hermes Development",
  "dockerComposeFile": "docker-compose.yml",
  "service": "hermes",
  "workspaceFolder": "/workspace",
  "features": {
    "ghcr.io/devcontainers/features/aws-cli:1": {},
    "ghcr.io/devcontainers/features/node:1": {}
  },
  "mounts": [
    "source=${localEnv:HOME}/.aws,target=/home/node/.aws,type=bind,consistency=cached"
  ],
  "postCreateCommand": "npm install",
  "customizations": {
    "vscode": {
      "extensions": ["dbaeumer.vscode-eslint", "esbenp.prettier-vscode"]
    }
  }
}
```

### Pros
- ✅ Integrated IDE experience
- ✅ Consistent environment across team
- ✅ Automatic AWS CLI setup
- ✅ GitHub Codespaces compatible

### Cons
- ❌ Requires VS Code
- ❌ Initial setup complexity

### Level of Effort: **5-7 hours**

## Recommended Approach

**For immediate needs (debugging current issues):**
Start with **Option 1** (Direct Credentials) - can be implemented in 2-4 hours

**For sustainable development:**
Implement **Option 2** (AssumeRole) - provides good security with 4-6 hours effort

**For team scaling:**
Move to **Option 4** (Hybrid) or **Option 5** (Dev Container) - best practices for 6-8 hours effort

## Implementation Priority

1. **Immediate (Today)**
   - Implement Option 1 for debugging
   - Document current production issues

2. **Short-term (This Week)**
   - Deploy Option 2 IAM role via CDK
   - Update credential providers in code

3. **Medium-term (Next Sprint)**
   - Implement Option 4 or 5
   - Create development resource sets
   - Document for team

## Required AWS Documentation References

- [AWS SDK Credential Provider Chain](https://docs.aws.amazon.com/sdkref/latest/guide/standardized-credentials.html)
- [Container Credentials](https://docs.aws.amazon.com/sdkref/latest/guide/feature-container-credentials.html)
- [AssumeRole Credentials](https://docs.aws.amazon.com/sdkref/latest/guide/feature-assume-role-credentials.html)
- [ECS Task IAM Roles](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-iam-roles.html)
- [AWS SDK for JavaScript v3 Credentials](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials.html)

## Quick Start Script

```bash
#!/bin/bash
# hermes-local.sh

# Option 1 - Quick start with direct credentials
export AWS_PROFILE=personal
export NODE_ENV=development
cd hermes
npm install
npm run start:dev
```

## Security Considerations

1. **Never commit credentials** to repository
2. **Use .env.local** (add to .gitignore)
3. **Rotate credentials regularly**
4. **Monitor CloudTrail** for local dev access
5. **Use resource prefixes** to avoid production conflicts
6. **Set up billing alerts** for dev resources

## Cost Optimization

- Use `dev-` prefix for all resources
- Set up CloudWatch alarm for unexpected charges
- Create Lambda to clean up dev resources nightly
- Use DynamoDB on-demand pricing for dev tables
- Set SQS message retention to 1 day for dev queues