#!/bin/bash

# Hermes Local Development Starter Script
# This script sets up and runs Hermes locally with AWS credentials

set -e

echo "🚀 Starting Hermes in local development mode..."

# Check for required files
if [ ! -f .env.local ]; then
    echo "⚠️  .env.local not found. Creating from example..."
    cp .env.local.example .env.local
    echo "📝 Please update .env.local with your configuration"
    exit 1
fi

# Check AWS credentials
if ! aws sts get-caller-identity --profile personal > /dev/null 2>&1; then
    echo "❌ AWS credentials not configured for 'personal' profile"
    echo "Please run: aws configure --profile personal"
    exit 1
fi

# Load environment variables
export $(cat .env.local | grep -v '^#' | xargs)

# Verify AWS access
echo "✅ AWS Account: $(aws sts get-caller-identity --profile personal --query Account --output text)"

# Check if required queues exist
echo "🔍 Checking AWS resources..."
aws sqs get-queue-url --queue-name "$EMAIL_QUEUE_NAME" --profile personal > /dev/null 2>&1 || \
    echo "⚠️  Warning: Queue $EMAIL_QUEUE_NAME not found"

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
fi

# Build the application
echo "🔨 Building application..."
npm run build

# Start in development mode with hot reload
echo "🎯 Starting Hermes on port ${PORT:-3000}..."
echo "📝 Logs will appear below. Press Ctrl+C to stop."
echo "-------------------------------------------"

npm run start:dev