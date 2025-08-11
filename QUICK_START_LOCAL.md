# Quick Start: Running Hermes Locally

## Immediate Setup (5 minutes)

### 1. Create Local Config
```bash
cd hermes
cp .env.local.example .env.local
```

### 2. Verify AWS Access
```bash
aws sts get-caller-identity --profile personal
```

### 3. Start Hermes Locally
```bash
./scripts/start-local.sh
```

## What This Enables

✅ **Full AWS Access** - Uses your personal AWS profile
✅ **Real Resources** - Connects to actual SQS, DynamoDB, etc.
✅ **Hot Reload** - Changes to code auto-restart
✅ **Debug Logs** - Full visibility into operations

## Debugging Tips

### Monitor Logs
```bash
# In another terminal, watch AWS logs
AWS_PROFILE=personal aws logs tail /ecs/hermes --follow
```

### Check Queue Messages
```bash
# See pending messages
AWS_PROFILE=personal aws sqs get-queue-attributes \
  --queue-url https://sqs.us-west-2.amazonaws.com/942734823970/webordinary-email-queue \
  --attribute-names All
```

### Test Health Check
```bash
curl http://localhost:3000/hermes/health
```

### Send Test Message to Queue
```bash
AWS_PROFILE=personal aws sqs send-message \
  --queue-url https://sqs.us-west-2.amazonaws.com/942734823970/webordinary-email-queue \
  --message-body '{"test": "message"}'
```

## Common Issues

### Port Already in Use
```bash
# Find and kill process on port 3000
lsof -i :3000
kill -9 <PID>
```

### AWS Credentials Error
```bash
# Refresh credentials
aws sso login --profile personal
# OR
aws configure --profile personal
```

### Module Not Found
```bash
npm install
npm run build
```

## VS Code Debug Configuration

Add to `.vscode/launch.json`:
```json
{
  "type": "node",
  "request": "launch",
  "name": "Debug Hermes",
  "skipFiles": ["<node_internals>/**"],
  "program": "${workspaceFolder}/hermes/src/main.ts",
  "preLaunchTask": "npm: build - hermes",
  "outFiles": ["${workspaceFolder}/hermes/dist/**/*.js"],
  "envFile": "${workspaceFolder}/hermes/.env.local",
  "console": "integratedTerminal"
}
```

## Next Steps

Once local development is working:
1. Add breakpoints in VS Code
2. Inspect SQS message processing
3. Test email flow end-to-end
4. Debug container lifecycle issues

## Safety Note

⚠️ **You're using PRODUCTION resources!**
- Be careful with delete operations
- Monitor CloudWatch for costs
- Consider creating dev-prefixed resources later