#!/bin/bash
# Script to remove simulator-polluted lines from tradeAudit.log
# These are lines with Quarterly strategies that came from simulator runs

echo "you probably don't want to run this"
exit();

AUDIT_FILE="../logs/audits/tradeAudit.log"
BACKUP_FILE="../logs/audits/tradeAudit.log.backup"

# Create backup
cp "$AUDIT_FILE" "$BACKUP_FILE"
echo "Backup created: $BACKUP_FILE"

# Count lines before
BEFORE=$(wc -l < "$AUDIT_FILE")

# Remove lines containing Quarterly strategies (simulator pollution)
# This catches both "QuarterlyTrendFollowing" and "run1-QuarterlyTrendFollowing" patterns
grep -v "Quarterly" "$BACKUP_FILE" > "$AUDIT_FILE"

# Count lines after
AFTER=$(wc -l < "$AUDIT_FILE")

REMOVED=$((BEFORE - AFTER))
echo "Removed $REMOVED polluted lines"
echo "Lines before: $BEFORE"
echo "Lines after: $AFTER"
