import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables for testing
dotenv.config({ path: path.join(__dirname, '../.env.test') });

// Set default test environment variables if not already set
process.env.NODE_ENV = 'test';
process.env.AWS_REGION = process.env.AWS_REGION || 'us-west-2';
process.env.QUEUE_TRACKING_TABLE = process.env.QUEUE_TRACKING_TABLE || 'webordinary-queue-tracking';
process.env.THREAD_MAPPING_TABLE = process.env.THREAD_MAPPING_TABLE || 'webordinary-thread-mappings';
process.env.CONTAINER_TABLE = process.env.CONTAINER_TABLE || 'webordinary-containers';
process.env.SESSION_TABLE = process.env.SESSION_TABLE || 'webordinary-edit-sessions';
process.env.ECS_CLUSTER_ARN = process.env.ECS_CLUSTER_ARN || 'arn:aws:ecs:us-west-2:942734823970:cluster/webordinary-edit-cluster';

// Increase Jest timeout for integration tests
jest.setTimeout(60000);

// Don't set mock credentials - use AWS_PROFILE instead
// This prevents credential conflicts when AWS_PROFILE is set
if (!process.env.AWS_PROFILE && !process.env.AWS_ACCESS_KEY_ID) {
  console.warn('WARNING: No AWS credentials found. Tests may fail.');
  console.warn('Set AWS_PROFILE=personal or provide AWS credentials.');
}

// Global test utilities
global.sleep = (ms: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

// Cleanup function to be called after tests
global.cleanupTestResources = async () => {
  // This can be expanded to clean up test resources
  console.log('Cleaning up test resources...');
};

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Cleanup on exit
afterAll(async () => {
  await global.cleanupTestResources();
});