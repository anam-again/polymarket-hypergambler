#!/bin/bash

# NCandle Trade Lifecycle Analyzer
# Analyzes ncandle trade logs to track individual trade lifecycles and identify discrepancies
# where more tokens are sold than bought (indicating duplicate sells)

set -e

if [ -z "$1" ]; then
    echo "Usage: $0 <logfile>"
    echo "Example: $0 logs/bots/test-ncandlepeq-btc15.log"
    exit 1
fi

LOGFILE="$1"

if [ ! -f "$LOGFILE" ]; then
    echo "Error: File not found: $LOGFILE"
    exit 1
fi

echo "=============================================="
echo "NCandle Trade Lifecycle Analysis"
echo "File: $LOGFILE"
echo "=============================================="
echo ""

# Create temp files for processing
TEMP_DIR=$(mktemp -d)
TRADE_MAP="$TEMP_DIR/trade_map.txt"
TRADES_DATA="$TEMP_DIR/trades_data.txt"

cleanup() {
    rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

# Step 1: Build mapping from UPDATE lines using awk for efficiency
# Format: [UPDATE] 2026-02-08T23:01:16.127Z	 test-t55cnhjbud, ncandle-buy, LIVE -> MATCHED
echo "Building order ID to order type mapping from UPDATE lines..."

grep -E "^\[UPDATE\].*LIVE -> MATCHED" "$LOGFILE" | grep -E "ncandle-(buy|sell|stoploss)" | \
awk -F',' '{
    # Get order_id from first field (after timestamp)
    n = split($1, a, " ")
    order_id = a[n]
    # Get order_type from second field
    gsub(/^[ \t]+|[ \t]+$/, "", $2)
    order_type = $2
    print order_id "|" order_type
}' > "$TRADE_MAP"

update_count=$(wc -l < "$TRADE_MAP")
echo "Mapped $update_count orders"

# Step 2: Extract COMPLETED lines and join with trade mapping using awk
# Format: [COMPLETED] 2026-02-08T23:01:16.129Z	 1770591676129, ncandlepeq-btc15, test-t55cnhjbud, MATCHED, 1770591663867, 29, 0.68, -1, 19.720000000000002, -19.720000000000002, TEST, 90668433782480783946111347251425730670236134609268290737746579241872959073524, BUY
echo "Processing COMPLETED lines..."

# Use awk to do the join efficiently
awk -F',' -v mapfile="$TRADE_MAP" '
BEGIN {
    # Load the trade map into memory
    while ((getline line < mapfile) > 0) {
        split(line, parts, "|")
        order_map[parts[1]] = parts[2]
    }
    close(mapfile)
}
/^\[COMPLETED\]/ {
    # Parse timestamp
    split($1, ts_parts, " ")
    timestamp = ts_parts[2]

    # Parse fields (trim whitespace)
    gsub(/^[ \t]+|[ \t]+$/, "", $3); order_id = $3
    gsub(/^[ \t]+|[ \t]+$/, "", $6); amount = $6
    gsub(/^[ \t]+|[ \t]+$/, "", $7); buy_price = $7
    gsub(/^[ \t]+|[ \t]+$/, "", $8); sell_price = $8
    gsub(/^[ \t]+|[ \t]+$/, "", $9); value = $9
    gsub(/^[ \t]+|[ \t]+$/, "", $10); pnl = $10
    gsub(/^[ \t]+|[ \t]+$/, "", $12); token_id = $12
    gsub(/^[ \t]+|[ \t]+$/, "", $13); direction = $13

    # Look up order_type from mapping
    if (order_id in order_map) {
        order_type = order_map[order_id]
        if (direction == "BUY") {
            print token_id "|BUY|" amount "|" buy_price "|" value "|0|" timestamp "|" order_id "|" order_type
        } else {
            print token_id "|SELL|" amount "|" sell_price "|" value "|" pnl "|" timestamp "|" order_id "|" order_type
        }
    }
}' "$LOGFILE" > "$TRADES_DATA"

completed_count=$(wc -l < "$TRADES_DATA")
echo "Processed $completed_count matched COMPLETED entries"
echo ""

# Step 3: Aggregate and display trades by token_id using awk
echo "=============================================="
echo "TRADE LIFECYCLE SUMMARY BY TOKEN"
echo "=============================================="
echo ""

# Process everything with awk for efficiency
awk -F'|' '
BEGIN {
    total_pnl = 0
    matched_count = 0
    buy_only_count = 0
    sell_only_count = 0
    mismatch_count = 0
}
{
    token_id = $1
    direction = $2
    amount = $3
    price = $4
    value = $5
    pnl = $6
    timestamp = $7
    order_id = $8
    order_type = $9

    # Track data by token
    if (!(token_id in tokens)) {
        tokens[token_id] = 1
        token_order[++token_count] = token_id
    }

    # Store trade details
    if (direction == "BUY") {
        buy_total[token_id] += amount
        buy_lines[token_id] = buy_lines[token_id] "    - [" timestamp "] " order_id " (" order_type "): " amount " tokens @ $" price " = $" value "\n"
    } else {
        sell_total[token_id] += amount
        sell_pnl[token_id] += pnl
        sell_lines[token_id] = sell_lines[token_id] "    - [" timestamp "] " order_id " (" order_type "): " amount " tokens @ $" price " = $" value " (PnL: $" pnl ")\n"
    }
}
END {
    for (i = 1; i <= token_count; i++) {
        token_id = token_order[i]
        short_token = substr(token_id, length(token_id) - 19)

        print "Token ID: ..." short_token

        if (buy_total[token_id] > 0) {
            print "  Buys:"
            printf "%s", buy_lines[token_id]
        }

        if (sell_total[token_id] > 0) {
            print "  Sells:"
            printf "%s", sell_lines[token_id]
        }

        bt = buy_total[token_id] + 0
        st = sell_total[token_id] + 0
        tp = sell_pnl[token_id] + 0

        print "  Summary: Bought " bt " tokens, Sold " st " tokens, PnL: $" tp

        # Determine status
        if (bt == 0 && st != 0) {
            print "  STATUS: SELL_WITHOUT_BUY (ERROR)"
            sell_only_count++
        } else if (bt != 0 && st == 0) {
            print "  STATUS: BUY_WITHOUT_SELL (pending)"
            buy_only_count++
        } else if (bt != st) {
            print "  STATUS: AMOUNT_MISMATCH (bought " bt ", sold " st ") (ERROR)"
            mismatch_count++
        } else {
            print "  STATUS: OK"
            matched_count++
        }

        total_pnl += tp
        print ""
    }

    print "=============================================="
    print "DISCREPANCY REPORT"
    print "=============================================="
    print ""
    print "Complete trades (buy + sell matched): " matched_count
    print "Buys without sells (pending): " buy_only_count
    print "Sells without buys (ERROR): " sell_only_count
    print "Amount mismatches (ERROR): " mismatch_count
    print ""
    print "Total PnL: $" total_pnl
    print ""

    # Check for potential duplicate sell/stoploss on same token
    print "Checking for multiple sells per buy..."
    has_warnings = 0
    for (i = 1; i <= token_count; i++) {
        token_id = token_order[i]
        short_token = substr(token_id, length(token_id) - 19)

        # Count individual buy and sell transactions
        buy_count = split(buy_lines[token_id], arr, "\n") - 1
        sell_count = split(sell_lines[token_id], arr, "\n") - 1

        if (sell_count > buy_count && buy_count > 0) {
            print "  WARNING: Token ..." short_token " has " buy_count " buy(s) but " sell_count " sell(s)"
            has_warnings = 1
        }
    }

    if (!has_warnings) {
        print "  No duplicate sell issues found."
    }
}
' "$TRADES_DATA"

echo ""
echo "=============================================="
echo "Analysis complete."
echo "=============================================="
