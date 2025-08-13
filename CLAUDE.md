# Hermes Quick Reference

**Build**: `docker build --platform linux/amd64 -t webordinary/hermes .`
**Deploy**: Push to ECR, update ECS service

## Critical
- Message router only (no web serving)
- Health endpoint: `/hermes/health`
- Email target: `buddy@webordinary.com`
- SQS consumer: `hermes-email-consumer`

## Commands
```bash
# Logs
AWS_PROFILE=personal aws logs tail /ecs/hermes --since 10m

# Scale
AWS_PROFILE=personal aws ecs update-service \
  --cluster webordinary-edit-cluster \
  --service webordinary-hermes-service \
  --desired-count 1

# Queue depth
AWS_PROFILE=personal aws sqs get-queue-attributes \
  --queue-url https://sqs.us-west-2.amazonaws.com/942734823970/webordinary-email-queue \
  --attribute-names ApproximateNumberOfMessages
```

## Key Tables
- `webordinary-thread-mappings` - Thread to session
- `webordinary-container-ownership` - Project+user claims

## Fixes
- Exec format error → Add `--platform linux/amd64`
- Health check fails → Use `/hermes/health`
- Messages in DLQ → Check email format

See [README.md](README.md) for full documentation.