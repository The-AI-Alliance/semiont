#!/bin/bash
# Prompt user to run make-meaning.sh setup

# Skip interactive prompt in CI environments
# Check for GitHub Actions remote env variables that are passed to container
if [ -n "$CI" ] || [ -n "$GITHUB_ACTIONS" ] || [ -n "$GITHUB_OUTPUT" ] || [ -n "$GITHUB_ENV" ]; then
    echo "Running in CI - skipping interactive setup prompt"
    exit 0
fi

clear
cat /workspace/.devcontainer/setup-instructions.txt

echo ""
echo "Would you like to run the setup now? (y/n)"
echo "Defaulting to 'yes' in 30 seconds..."

# Read with timeout of 30 seconds, default to 'y'
if read -t 30 -r response; then
    # User provided input
    if [[ "$response" =~ ^[Nn]$ ]]; then
        echo ""
        echo "Setup skipped. You can run setup later with:"
        echo "  bash .devcontainer/make-meaning.sh"
        echo ""
        exit 0
    fi
fi

# Either user said yes, or timeout occurred (default to yes)
echo ""
echo "Running setup..."
bash /workspace/.devcontainer/make-meaning.sh
