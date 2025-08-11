#!/usr/bin/env node

/**
 * Development server wrapper that configures AWS SDK v2 credentials
 * This is needed because @ssut/nestjs-sqs uses AWS SDK v2 which doesn't
 * automatically pick up the AWS_PROFILE environment variable
 */

const AWS = require('aws-sdk');
const { spawn } = require('child_process');
const path = require('path');
const dotenv = require('dotenv');

// Load .env.local
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

// Configure AWS SDK v2 to use the personal profile
if (process.env.AWS_PROFILE) {
  console.log(`Configuring AWS SDK v2 to use profile: ${process.env.AWS_PROFILE}`);
  
  // Create shared credentials with the specified profile
  const credentials = new AWS.SharedIniFileCredentials({
    profile: process.env.AWS_PROFILE
  });
  
  // Set the credentials globally for AWS SDK v2
  AWS.config.credentials = credentials;
  AWS.config.region = process.env.AWS_REGION || 'us-west-2';
  
  // Verify credentials are loaded
  credentials.get((err) => {
    if (err) {
      console.error('Failed to load AWS credentials:', err.message);
      console.error('Please ensure AWS profile "personal" is configured');
      process.exit(1);
    }
    console.log('AWS credentials loaded successfully');
    
    // Start the NestJS application
    const nest = spawn('npm', ['run', 'start:dev'], {
      stdio: 'inherit',
      env: {
        ...process.env,
        // Ensure these are passed through
        NODE_ENV: 'development',
        AWS_SDK_LOAD_CONFIG: '1',  // Force SDK to load from config files
      }
    });
    
    nest.on('close', (code) => {
      process.exit(code);
    });
  });
} else {
  console.error('AWS_PROFILE not set in .env.local');
  process.exit(1);
}