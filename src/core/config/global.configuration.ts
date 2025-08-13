export default () => ({
  aws: {
    account: process.env.AWS_ACCOUNT_ID ?? '942734823970',
    bedrockRegion: 'us-west-2',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '',
    sqsRegion: process.env.AWS_SQS_REGION ?? 'us-west-2',
    sesRegion: process.env.AWS_SES_REGION ?? 'us-west-2',
    emailConsumer: 'hermes-email-consumer',
    // Support dev queue prefix for local development
    emailQueue: process.env.EMAIL_QUEUE_NAME ?? (
      process.env.NODE_ENV === 'development' 
        ? 'dev-webordinary-email-queue'
        : 'webordinary-email-queue'
    ),
    queuePrefix: process.env.QUEUE_PREFIX ?? (
      process.env.NODE_ENV === 'development' ? 'dev-' : ''
    ),
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.CLAUDE_MODEL || 'claude-3-opus-20240229',
  },
  claudeCode: {
    workingDirectory: process.env.WORKSPACE_PATH || '/workspace/amelia-astro',
    maxRetries: parseInt(process.env.MAX_RETRIES || '3'),
    timeout: parseInt(process.env.EXECUTION_TIMEOUT || '30000'),
    // Container URL removed - containers now communicate via SQS only
  },
  featureFlags: {
    useClaudeCode: process.env.USE_CLAUDE_CODE === 'true',
  },
});