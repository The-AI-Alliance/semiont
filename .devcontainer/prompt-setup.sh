#!/bin/bash
# Prompt user to run make-meaning.sh setup

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
