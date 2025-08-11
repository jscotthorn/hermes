# Hermes Development Notes

## 🚨 CRITICAL: Always Build for linux/amd64
```bash
docker build --platform linux/amd64 -t webordinary/hermes .
```
If you see "exec format error" in logs, it's an architecture mismatch.

## 📦 Current Architecture (S3 Deployment)
- **MESSAGE ROUTER**: Processes SQS messages, manages containers
- **NO WEB SERVING**: Containers deploy to S3, not HTTP
- **HEALTH CHECK**: Path is `/hermes/health` (not `/health`)
- **SQS CONSUMER**: Name is `hermes-email-consumer`

See README.md for full architecture details.

## 🔧 Quick Commands
```bash
# Scale service
AWS_PROFILE=personal aws ecs update-service \
  --cluster webordinary-edit-cluster \
  --service webordinary-hermes-service \
  --desired-count 1  # or 0 to stop

# View logs
AWS_PROFILE=personal aws logs tail /ecs/hermes --since 10m

# Check queue depth
AWS_PROFILE=personal aws sqs get-queue-attributes \
  --queue-url https://sqs.us-west-2.amazonaws.com/942734823970/webordinary-email-queue \
  --attribute-names ApproximateNumberOfMessages
```

## 🧪 Testing
```bash
# Tests use .env.test automatically
AWS_PROFILE=personal npm run test:integration
AWS_PROFILE=personal npm run test:e2e
```

## 📝 Key Points
1. **Use AWS_PROFILE=personal** for all AWS commands
2. **Scale to 0** when not in use (saves ~$12-15/month)
3. **Messages may be wrapped or raw** - handle both formats
4. **Check module imports** when adding service dependencies
5. **One container per user+project** (not per session)

## 🐛 Common Fixes
- **Exec format error**: Add `--platform linux/amd64`
- **Health check fails**: Use `/hermes/health` not `/health`
- **SQS consumer errors**: Check name is `hermes-email-consumer`
- **Module not found**: Check imports in app.module.ts

See README.md for detailed troubleshooting.