1. **Always use `--platform linux/amd64`** for Docker builds
2. **Health check path is `/hermes/health`**, not `/health`
3. **SQS consumer name is `hermes-email-consumer`**, not `buddy-email-consumer`
4. **Messages from SQS may be wrapped or raw** - handle both formats
5. **Scale to 0 when not in use** to save costs (~$25-30/month when running)
6. **Check module imports** when adding dependencies between services
7. **Use AWS_PROFILE=personal** for all AWS CLI commands

### Scaling Commands
```bash
# Scale up for development/testing
AWS_PROFILE=personal aws ecs update-service --cluster webordinary-edit-cluster \
  --service webordinary-hermes-service --desired-count 1

# Scale down to save costs
AWS_PROFILE=personal aws ecs update-service --cluster webordinary-edit-cluster \
  --service webordinary-hermes-service --desired-count 0
```

### Log Monitoring
```bash
# View recent logs
AWS_PROFILE=personal aws logs tail /ecs/hermes --since 5m --region us-west-2

# Filter for specific patterns
AWS_PROFILE=personal aws logs tail /ecs/hermes --since 10m \
  --filter-pattern "ERROR OR Exception" --region us-west-2
```

### Common Debugging Queries
```bash
# Check SQS queue status
AWS_PROFILE=personal aws sqs get-queue-attributes \
  --queue-url https://sqs.us-west-2.amazonaws.com/942734823970/webordinary-email-queue \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible

# Check for active sessions
AWS_PROFILE=personal aws dynamodb scan --table-name webordinary-thread-mappings \
  --limit 5 --query 'Items[:5]' --output json

# Check service status
AWS_PROFILE=personal aws ecs describe-services --cluster webordinary-edit-cluster \
  --services webordinary-hermes-service \
  --query 'services[0].{Status:status, Running:runningCount, Desired:desiredCount}'
```

## 🚀 Deployment Checklist

Before deploying Hermes:
- [ ] Run `npm run build` locally to verify TypeScript compilation
- [ ] Build Docker image with `--platform linux/amd64`
- [ ] Verify health check path matches CDK configuration
- [ ] Check SQS consumer names match across all files
- [ ] Test locally with docker run if possible
- [ ] Tag with version number, not just `:latest`
- [ ] Monitor CloudWatch logs after deployment
