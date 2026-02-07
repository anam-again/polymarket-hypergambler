#!/bin/bash
# Deletes all files underneath /logs/simulator

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
LOGS_DIR="$PROJECT_ROOT/logs/simulator"

if [ -d "$LOGS_DIR" ]; then
    rm -rf "$LOGS_DIR"/*
    echo "Cleaned $LOGS_DIR"
else
    echo "Directory $LOGS_DIR does not exist"
fi
