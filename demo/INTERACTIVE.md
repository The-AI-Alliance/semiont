# Interactive Terminal UI

The Semiont demo includes an interactive terminal UI for managing dataset operations.

## Launching Interactive Mode

```bash
# Using npm script
npm run demo:interactive

# Or directly
npx tsx demo.ts --interactive
# Aliases also work:
npx tsx demo.ts --app
npx tsx demo.ts --terminal
```

## Interface Layout

The terminal UI is divided into three panels:

### 1. Top Left: Datasets & Commands
- Shows all configured datasets with their available commands
- Navigate with arrow keys or `j`/`k` (vim-style)
- Commands show status indicators:
  - ✓ (green) = Command has been run
  - ○ (gray) = Command not yet run
- Press `Enter` to execute the selected command

### 2. Bottom Left: Details
- When a **dataset** is selected: Shows full configuration and state
- When a **command** is selected: Shows command details and status
- Scrollable with arrow keys or `j`/`k`

### 3. Right Half: Activity Log
- Displays real-time output from running commands
- Shows stdout and stderr
- Automatically scrolls to bottom
- Scrollable with arrow keys or `j`/`k`

## Keyboard Controls

- **↑/↓** or **j/k** - Navigate lists/scroll panels
- **Enter** - Execute selected command
- **Tab** - Switch focus between panels
- **q** or **Esc** or **Ctrl-C** - Quit

## Text Selection

To select and copy text from the terminal:
- **Hold Shift** (or **Option/Alt** on Mac) while selecting with your mouse
- This bypasses the app and lets your terminal handle the selection
- Then copy normally (Cmd-C or Ctrl-C depending on your terminal)

## Command Status Detection

The UI automatically detects whether commands have been run:

- **Download**: Checks if cache file exists
- **Load**: Checks if state file exists
- **Annotate**: Checks if state file contains annotation data

Statuses update automatically after each command completes.

## Example Workflow

1. Launch interactive mode: `npm run demo:interactive`
2. Navigate to a dataset's `download` command
3. Press `Enter` to download content
4. Navigate to the `load` command
5. Press `Enter` to load and upload to backend
6. If available, navigate to `annotate` command
7. Press `Enter` to detect citations and create annotations
8. Use `Tab` to switch between panels and review details
9. Press `q` to quit

## Notes

- Only one command can run at a time
- Commands spawn in separate processes with full output capture
- The interface updates in real-time as commands execute
- All standard demo commands work the same way as CLI mode
- Private datasets (in `config/private/`) are included if configured
