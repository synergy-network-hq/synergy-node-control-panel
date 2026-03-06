#!/bin/bash
# Uninstall script for Synergy Devnet Control Panel
# This script removes the application and ALL associated data for a clean reinstall

set -e

APP_NAME="Synergy Devnet Control Panel"
APP_ID="synergy-devnet-control-panel"
APP_IDENTIFIER="com.synergy.node-monitor"

echo "=========================================="
echo "  $APP_NAME - Complete Uninstall"
echo "=========================================="
echo ""
echo "This will remove:"
echo "  - The installed application package"
echo "  - All application configuration"
echo "  - All monitor workspace data"
echo "  - All node data and sandboxes"
echo "  - All cached data"
echo ""
read -p "Are you sure you want to continue? (yes/no): " confirm

if [[ "$confirm" != "yes" ]]; then
    echo "Uninstallation cancelled."
    exit 0
fi

echo ""
echo "Uninstalling $APP_NAME..."

# Stop any running processes first
echo "Checking for running processes..."
if pgrep -f "synergy.*node-monitor" > /dev/null 2>&1; then
    echo "Warning: Found running processes. Attempting to stop them..."
    pkill -f "synergy.*node-monitor" 2>/dev/null || true
    sleep 2
fi

# Check if installed via .deb package
if command -v dpkg >/dev/null 2>&1; then
    # Check for actual installed package name
    INSTALLED_PKG=$(dpkg -l 2>/dev/null | grep -E "^ii\s+(synergy-devnet-control-panel|synergy-devnet-control-center|com\.synergy\.node-monitor)" | awk '{print $2}' | head -1)
    
    if [[ -n "$INSTALLED_PKG" ]]; then
        echo "Found installed package: $INSTALLED_PKG"
        echo "Removing .deb package (requires sudo password)..."
        
        # Remove and purge the package
        if sudo dpkg -r "$INSTALLED_PKG" 2>/dev/null; then
            echo "✓ Package removed"
        elif sudo apt-get remove -y "$INSTALLED_PKG" 2>/dev/null; then
            echo "✓ Package removed via apt-get"
        else
            echo "⚠ Failed to remove package (may need manual removal)"
            echo "  Run: sudo dpkg --purge $INSTALLED_PKG"
        fi
        
        # Purge to remove config files
        sudo dpkg --purge "$INSTALLED_PKG" 2>/dev/null && echo "✓ Package purged" || true
        sudo apt-get autoremove -y 2>/dev/null || true
    else
        echo "Package not found in dpkg (may not be installed via .deb)"
    fi
fi

# Check if installed via .rpm package
if command -v rpm >/dev/null 2>&1 && rpm -qa 2>/dev/null | grep -q "$APP_ID"; then
    echo "Removing .rpm package..."
    sudo rpm -e "$APP_ID" 2>/dev/null || true
    echo "✓ Package removed"
fi

# Remove application data directories
echo ""
echo "Removing application data..."

# Tauri standard directories
if [[ -d "$HOME/.config/com.synergy.node-monitor" ]]; then
    rm -rf "$HOME/.config/com.synergy.node-monitor"
    echo "✓ Removed ~/.config/com.synergy.node-monitor"
fi

if [[ -d "$HOME/.local/share/com.synergy.node-monitor" ]]; then
    rm -rf "$HOME/.local/share/com.synergy.node-monitor"
    echo "✓ Removed ~/.local/share/com.synergy.node-monitor"
fi

if [[ -d "$HOME/.cache/com.synergy.node-monitor" ]]; then
    rm -rf "$HOME/.cache/com.synergy.node-monitor"
    echo "✓ Removed ~/.cache/com.synergy.node-monitor"
fi

# Control panel workspace (current location)
if [[ -d "$HOME/.synergy-devnet-control-panel" ]]; then
    rm -rf "$HOME/.synergy-devnet-control-panel"
    echo "✓ Removed ~/.synergy-devnet-control-panel"
fi

# Legacy workspace location
if [[ -d "$HOME/.synergy-node-monitor" ]]; then
    rm -rf "$HOME/.synergy-node-monitor"
    echo "✓ Removed legacy ~/.synergy-node-monitor"
fi

# Legacy macOS workspace location
if [[ -d "$HOME/Library/Application Support/com.synergy.node-monitor" ]]; then
    rm -rf "$HOME/Library/Application Support/com.synergy.node-monitor"
    echo "✓ Removed ~/Library/Application Support/com.synergy.node-monitor"
fi

# Node sandbox data
if [[ -d "$HOME/.synergy/node" ]]; then
    rm -rf "$HOME/.synergy/node"
    echo "✓ Removed ~/.synergy/node"
fi

# Remove desktop entries
echo ""
echo "Removing desktop entries..."
rm -f "$HOME/.local/share/applications/com.synergy.node-monitor.desktop"
rm -f "$HOME/.local/share/applications/synergy-devnet-control-panel.desktop"
rm -f "$HOME/.local/share/applications/synergy-devnet-control-center.desktop"
echo "✓ Removed user desktop entries"

# Remove from system applications (if installed system-wide)
if [[ -f "/usr/share/applications/com.synergy.node-monitor.desktop" ]]; then
    sudo rm -f /usr/share/applications/com.synergy.node-monitor.desktop 2>/dev/null || true
    echo "✓ Removed system desktop entry"
fi

if [[ -f "/usr/share/applications/synergy-devnet-control-center.desktop" ]]; then
    sudo rm -f /usr/share/applications/synergy-devnet-control-center.desktop 2>/dev/null || true
    echo "✓ Removed system desktop entry"
fi

echo ""
echo "=========================================="
echo "  Uninstallation Complete!"
echo "=========================================="
echo ""
echo "All application data has been removed. You can now:"
echo "  1. Reinstall the application from the .deb/.rpm/.AppImage package"
echo "  2. Run the setup wizard again for a fresh start"
echo ""
