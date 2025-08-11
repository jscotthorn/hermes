import { fromIni, fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { AwsCredentialIdentityProvider } from '@smithy/types';
import { Logger } from '@nestjs/common';

const logger = new Logger('AWSCredentialsProvider');

/**
 * Get AWS credentials based on environment
 * - Development: Uses AWS profile from ~/.aws/credentials
 * - Production: Uses ECS Task Role via container credentials
 */
export function getAwsCredentials(): AwsCredentialIdentityProvider | undefined {
  const env = process.env.NODE_ENV;
  const profile = process.env.AWS_PROFILE;

  if (env === 'development' && profile) {
    logger.log(`Using AWS profile '${profile}' for local development`);
    return fromIni({ profile });
  }

  if (env === 'development') {
    logger.warn('AWS_PROFILE not set for development, using default credential chain');
  }

  // In production or when no profile specified, use default chain
  // This will automatically use ECS Task Role in production
  return undefined; // Let SDK use default provider chain
}

/**
 * Get AWS client configuration with appropriate credentials
 */
export function getAwsClientConfig(region?: string) {
  const credentials = getAwsCredentials();
  const config: any = {
    region: region || process.env.AWS_REGION || 'us-west-2',
  };

  if (credentials) {
    config.credentials = credentials;
  }

  // Support for LocalStack or other endpoints
  if (process.env.AWS_ENDPOINT_URL) {
    config.endpoint = process.env.AWS_ENDPOINT_URL;
    logger.log(`Using custom AWS endpoint: ${process.env.AWS_ENDPOINT_URL}`);
  }

  return config;
}