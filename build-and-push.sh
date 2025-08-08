#!/bin/bash

# Build and push Hermes container to ECR
# Usage: ./build-and-push.sh [tag]

set -e

# Configuration
AWS_REGION="us-west-2"
AWS_ACCOUNT_ID="942734823970"
REPOSITORY_NAME="webordinary/hermes"
TAG=${1:-latest}

# Full repository URI
REPOSITORY_URI="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$REPOSITORY_NAME"

echo "Building Hermes container..."
echo "Repository: $REPOSITORY_URI"
echo "Tag: $TAG"

# Authenticate Docker to ECR
echo "Authenticating with ECR..."
aws ecr get-login-password --region $AWS_REGION --profile personal | docker login --username AWS --password-stdin $REPOSITORY_URI

# Build the Docker image
echo "Building Docker image..."
docker build -t $REPOSITORY_NAME:$TAG .

# Tag for ECR
echo "Tagging image for ECR..."
docker tag $REPOSITORY_NAME:$TAG $REPOSITORY_URI:$TAG

# Push to ECR
echo "Pushing to ECR..."
docker push $REPOSITORY_URI:$TAG

echo "✅ Successfully built and pushed $REPOSITORY_URI:$TAG"
echo ""
echo "To scale up Hermes for development:"
echo "aws ecs update-service --cluster webordinary-edit-cluster --service webordinary-hermes-service --desired-count 1 --profile personal"
echo ""
echo "To scale down Hermes to save costs:"
echo "aws ecs update-service --cluster webordinary-edit-cluster --service webordinary-hermes-service --desired-count 0 --profile personal"