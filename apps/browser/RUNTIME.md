# Browser Runtime Directory

This directory contains runtime files for the Browser service.

## Structure

- `.env.local` - Environment configuration (git-ignored)
- `logs/` - Application logs
- `tmp/` - Temporary files
- `browser.pid` - Process ID when running

## Configuration

Edit `.env.local` to configure:
- Server API URL (SERVER_API_URL) - set to localhost for POSIX platform
- Port (PORT)
- Other environment-specific settings

## Source Code

The Browser source code is located at:
/Users/pingel/git_repos/github.com/The-AI-Alliance/semiont/apps/browser

## Commands

- Start: `semiont start --service browser --environment local`
- Check: `semiont status`
- Stop: `semiont stop --service browser --environment local`
- Logs: `tail -f logs/app.log`
