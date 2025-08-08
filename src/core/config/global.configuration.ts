export default () => ({
  aws: {
    account: process.env.AWS_ACCOUNT_ID ?? '',
    bedrockRegion: 'us-west-2',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '',
    sqsRegion: 'us-east-2',
    sesRegion: process.env.AWS_SES_REGION ?? 'us-east-2',
    emailConsumer: 'buddy-email-consumer',
    emailQueue: 'webordinary-buddy-incoming-email',
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.CLAUDE_MODEL || 'claude-3-opus-20240229',
  },
  claudeCode: {
    workingDirectory: process.env.WORKSPACE_PATH || '/workspace/amelia-astro',
    maxRetries: parseInt(process.env.MAX_RETRIES || '3'),
    timeout: parseInt(process.env.EXECUTION_TIMEOUT || '30000'),
    containerUrl: process.env.CLAUDE_CODE_CONTAINER_URL || 'http://localhost:8080',
  },
  featureFlags: {
    useClaudeCode: process.env.USE_CLAUDE_CODE === 'true',
  },
});