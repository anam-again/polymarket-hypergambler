#!/bin/bash

# MarketMaker Trade Lifecycle Analyzer
# Analyzes mmaker trade logs to track individual trade lifecycles and identify discrepancies

set -e

if [ -z "$1" ]; then
    echo "Usage: $0 <logfile>"
    echo "Example: $0 logs/bots/test-mmaker-btc-gen1.log"
    exit 1
fi

LOGFILE="$1"

if [ ! -f "$LOGFILE" ]; then
    echo "Error: File not found: $LOGFILE"
    exit 1
fi

echo "=============================================="
echo "MarketMaker Trade Lifecycle Analysis"
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

# Step 1: Build mapping from UPDATE lines
# Format: [UPDATE] 2026-02-06T03:03:18.142Z	 test-mml80946i2k, mm-buy-down-1-1770346971118, LIVE -> MATCHED
echo "Building order ID to trade ID mapping from UPDATE lines..."

grep -E "^\[UPDATE\].*LIVE -> MATCHED" "$LOGFILE" | grep -E "mm-(buy|stoploss|sell)" | while read -r line; do
    # Extract order_id (the part before first comma after the timestamp/whitespace)
    # Extract order_name (mm-...) between commas
    order_id=$(echo "$line" | awk -F',' '{print $1}' | awk '{print $NF}')
    order_name=$(echo "$line" | awk -F',' '{gsub(/^[ \t]+|[ \t]+$/, "", $2); print $2}')

    # Extract trade_id from order_name (e.g., "down-1" from "mm-buy-down-1-1770346971118")
    # Also handle retry orders: mm-buy-retry-down-1-{timestamp}
    # Pattern: mm-{type}[-retry]-{direction}-{index}-{timestamp}
    order_type=$(echo "$order_name" | sed -E 's/mm-(buy|buy-retry|stoploss|sell)-.*/\1/')
    trade_id=$(echo "$order_name" | sed -E 's/mm-(buy|buy-retry|stoploss|sell)-([a-z]+-[0-9]+)-[0-9]+/\2/')

    echo "$order_id|$trade_id|$order_type|$order_name"
done > "$TRADE_MAP"

update_count=$(wc -l < "$TRADE_MAP")
echo "Mapped $update_count orders to trade IDs"

# Step 2: Extract COMPLETED lines and join with trade mapping
# Format: [COMPLETED] 2026-02-06T03:03:18.144Z	 1770346998143, mmaker-btc-gen1, test-mml80946i2k, MATCHED, ...
echo "Processing COMPLETED lines..."

grep -E "^\[COMPLETED\]" "$LOGFILE" | while read -r line; do
    # Parse: timestamp, order_ts, bot_name, order_id, status, rel_id, amount, buy_price, sell_price, value, pnl, mode, token_id, direction
    timestamp=$(echo "$line" | awk '{print $2}')

    # Get fields after timestamp (comma separated)
    rest=$(echo "$line" | sed 's/^\[COMPLETED\][^,]*,//')

    # Split by comma - need to handle the format carefully
    # Field 1: [COMPLETED] timestamp order_ts
    # Field 2: bot_name
    # Field 3: order_id
    # Field 4: status (MATCHED)
    # Field 5: rel_id
    # Field 6: amount
    # Field 7: buy_price
    # Field 8: sell_price
    # Field 9: value
    # Field 10: pnl
    # Field 11: mode
    # Field 12: token_id
    # Field 13: direction (BUY/SELL)
    order_id=$(echo "$line" | awk -F',' '{gsub(/^[ \t]+|[ \t]+$/, "", $3); print $3}')
    amount=$(echo "$line" | awk -F',' '{gsub(/^[ \t]+|[ \t]+$/, "", $6); print $6}')
    buy_price=$(echo "$line" | awk -F',' '{gsub(/^[ \t]+|[ \t]+$/, "", $7); print $7}')
    sell_price=$(echo "$line" | awk -F',' '{gsub(/^[ \t]+|[ \t]+$/, "", $8); print $8}')
    value=$(echo "$line" | awk -F',' '{gsub(/^[ \t]+|[ \t]+$/, "", $9); print $9}')
    pnl=$(echo "$line" | awk -F',' '{gsub(/^[ \t]+|[ \t]+$/, "", $10); print $10}')
    direction=$(echo "$line" | awk -F',' '{gsub(/^[ \t]+|[ \t]+$/, "", $13); print $13}')

    # Look up trade_id from mapping
    mapping=$(grep "^$order_id|" "$TRADE_MAP" 2>/dev/null | head -1 || echo "")

    if [ -n "$mapping" ]; then
        trade_id=$(echo "$mapping" | cut -d'|' -f2)
        order_type=$(echo "$mapping" | cut -d'|' -f3)
        order_name=$(echo "$mapping" | cut -d'|' -f4)

        # Output: trade_id|direction|amount|price|value|pnl|timestamp|order_name
        if [ "$direction" = "BUY" ]; then
            echo "$trade_id|BUY|$amount|$buy_price|$value|0|$timestamp|$order_name"
        else
            echo "$trade_id|SELL|$amount|$sell_price|$value|$pnl|$timestamp|$order_name"
        fi
    fi
done > "$TRADES_DATA"

completed_count=$(wc -l < "$TRADES_DATA")
echo "Processed $completed_count matched COMPLETED entries"
echo ""

# Step 3: Aggregate and display trades
echo "=============================================="
echo "TRADE LIFECYCLE SUMMARY"
echo "=============================================="
echo ""

# Get unique trade IDs
trade_ids=$(cut -d'|' -f1 "$TRADES_DATA" | sort -u)

total_pnl=0
matched_count=0
buy_only_count=0
sell_only_count=0
mismatch_count=0

for trade_id in $trade_ids; do
    echo "Trade ID: $trade_id"

    # Get buys for this trade
    buys=$(grep "^$trade_id|BUY|" "$TRADES_DATA" || true)
    sells=$(grep "^$trade_id|SELL|" "$TRADES_DATA" || true)

    buy_total=0
    sell_total=0
    trade_pnl=0

    if [ -n "$buys" ]; then
        echo "  Buys:"
        echo "$buys" | while IFS='|' read -r tid dir amt price val pnl ts name; do
            echo "    - [$ts] $name: $amt tokens @ \$$price = \$$val"
        done
        buy_total=$(echo "$buys" | awk -F'|' '{sum += $3} END {print sum}')
    fi

    if [ -n "$sells" ]; then
        echo "  Sells:"
        echo "$sells" | while IFS='|' read -r tid dir amt price val pnl ts name; do
            echo "    - [$ts] $name: $amt tokens @ \$$price = \$$val (PnL: \$$pnl)"
        done
        sell_total=$(echo "$sells" | awk -F'|' '{sum += $3} END {print sum}')
        trade_pnl=$(echo "$sells" | awk -F'|' '{sum += $6} END {print sum}')
    fi

    echo "  Summary: Bought $buy_total tokens, Sold $sell_total tokens, PnL: \$$trade_pnl"

    # Determine status
    if [ "$buy_total" = "0" ] && [ "$sell_total" != "0" ]; then
        echo "  STATUS: SELL_WITHOUT_BUY"
        ((sell_only_count++)) || true
    elif [ "$buy_total" != "0" ] && [ "$sell_total" = "0" ]; then
        echo "  STATUS: BUY_WITHOUT_SELL (pending)"
        ((buy_only_count++)) || true
    elif [ "$buy_total" != "$sell_total" ]; then
        echo "  STATUS: AMOUNT_MISMATCH (bought $buy_total, sold $sell_total)"
        ((mismatch_count++)) || true
    else
        echo "  STATUS: OK"
        ((matched_count++)) || true
    fi

    total_pnl=$(echo "$total_pnl + $trade_pnl" | bc 2>/dev/null || echo "$total_pnl")
    echo ""
done

echo "=============================================="
echo "DISCREPANCY REPORT"
echo "=============================================="
echo ""
echo "Complete trades (buy + sell matched): $matched_count"
echo "Buys without sells (pending): $buy_only_count"
echo "Sells without buys (ERROR): $sell_only_count"
echo "Amount mismatches: $mismatch_count"
echo ""
echo "Total PnL: \$$total_pnl"
echo ""

# Check for duplicate trade IDs in the same direction
echo "Checking for duplicate entries..."
duplicates=$(cut -d'|' -f1,2 "$TRADES_DATA" | sort | uniq -c | awk '$1 > 1 {print $0}')
if [ -n "$duplicates" ]; then
    echo "DUPLICATES FOUND:"
    echo "$duplicates"
else
    echo "No duplicate entries found."
fi

echo ""
echo "=============================================="
echo "Analysis complete."
echo "=============================================="
