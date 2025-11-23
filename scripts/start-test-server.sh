#!/usr/bin/env bash
set -e

# Load environment variables from .env file
if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
else
    echo "Error: .env file not found"
    exit 1
fi

# Check if required environment variables are set
if [ -z "$TEST_USER_EMAIL" ] || [ -z "$TEST_USER_PW" ]; then
    echo "Error: TEST_USER_EMAIL and TEST_USER_PW must be set in .env"
    exit 1
fi

# Set default testing PocketBase address if not set
TESTING_PB_ADDR=${TESTING_PB_ADDR:-http://127.0.0.1:8210}

# Extract host and port from TESTING_PB_ADDR
PB_HOST=$(echo $TESTING_PB_ADDR | sed -E 's|https?://([^:]+):([0-9]+)|\1|')
PB_PORT=$(echo $TESTING_PB_ADDR | sed -E 's|https?://([^:]+):([0-9]+)|\2|')

# Default to 127.0.0.1:8210 if parsing fails
PB_HOST=${PB_HOST:-127.0.0.1}
PB_PORT=${PB_PORT:-8210}

npm run db:reset

echo "Starting PocketBase test server setup..."
echo "Server: $PB_HOST:$PB_PORT"
echo "Admin email: $TEST_USER_EMAIL"

# Create superuser (this will update if already exists)
echo "Creating/updating superuser..."
pocketbase superuser create "$TEST_USER_EMAIL" "$TEST_USER_PW" --dir ./pb_data 2>/dev/null || \
pocketbase superuser update "$TEST_USER_EMAIL" "$TEST_USER_PW" --dir ./pb_data || {
    echo "Warning: Could not create/update superuser (may already exist)"
}

echo "Starting PocketBase server on $PB_HOST:$PB_PORT..."
pocketbase serve --dir ./pb_data --http "$PB_HOST:$PB_PORT"
