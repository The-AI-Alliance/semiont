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
read -r response

if [[ "$response" =~ ^[Yy]$ ]]; then
    bash /workspace/.devcontainer/make-meaning.sh
else
    echo ""
    echo "You can run setup later with:"
    echo "  bash .devcontainer/make-meaning.sh"
    echo ""
fi
